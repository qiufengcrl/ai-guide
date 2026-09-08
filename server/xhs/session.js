const { fetchHtmlNote, exploreNoteUrl } = require('./url');
const { createSearchId } = require('./signature');
const { isXhsRateLimitError, withXhsRetry } = require('./throttle');
const {
  XhsSessionError,
  isXhsAuthError,
  isXhsVerificationError,
  isXhsNotFoundError,
  assertSessionResponse,
} = require('./errors');
const { post, pong } = require('./client');
const { SearchSortType, SearchNoteType } = require('./field');

const SEARCH_PAGE_SIZE = 20;
const SKIP_SEARCH_MODELS = new Set(['rec_query', 'hot_query', 'user']);

function normalizeXhsCookie(value) {
  let normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length >= 2 && normalized[0] === normalized.at(-1) && (normalized[0] === '"' || normalized[0] === "'")) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (normalized.startsWith('[') || (normalized.startsWith('{') && normalized.includes('"name"'))) {
    try {
      const parsed = JSON.parse(normalized);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const pairs = items
        .filter((item) => item && typeof item === 'object' && String(item.name || '').trim())
        .map((item) => `${String(item.name).trim()}=${String(item.value || '').trim()}`);
      if (pairs.length) return pairs.join('; ');
    } catch {
      // A regular Cookie header may begin with punctuation; keep it unchanged.
    }
  }
  return normalized;
}

function degradedSuffix(scene, locale, messageFn) {
  if (scene === 'search') {
    return messageFn(locale,
      '已跳过搜索，继续使用链接、粘贴或表单生成。',
      'Search was skipped; continuing with links, pasted text, or the form.');
  }
  return messageFn(locale,
    '已继续使用链接、粘贴或表单生成。',
    'Planning continued with links, pasted text, or the form.');
}

function formatXhsWarning(error, locale, messageFn, options = {}) {
  const text = error instanceof Error ? error.message : String(error || '');
  const scene = options.scene || 'signed';
  const suffix = degradedSuffix(scene, locale, messageFn);
  if (isXhsAuthError(error)) {
    return messageFn(locale,
      `【认证失败】小红书 Cookie 无效、不完整或已过期，请在插件设置中更新 Cookie。${suffix}`,
      `【Auth failed】Your Xiaohongshu Cookie is invalid, incomplete, or expired. Update it in plugin settings. ${suffix}`);
  }
  if (isXhsVerificationError(error) || /风控/.test(text)) {
    return messageFn(locale,
      `【需要验证】小红书要求验证码或触发风控（461）。常见原因是登录 IP 与 TREK 服务器出口 IP 不一致。${suffix}`,
      `【Verification required】Xiaohongshu requested captcha or risk control (461). A common cause is an IP mismatch between the login and this TREK server. ${suffix}`);
  }
  if (isXhsRateLimitError(error) || /429|频繁|cuqps|too many requests|rate limit/i.test(text)) {
    const retry = scene === 'search'
      ? messageFn(locale, '请稍后重试关键词搜索。', 'Try keyword search later. ')
      : messageFn(locale, '请稍后再试。', 'Try again later. ');
    return messageFn(locale,
      `【请求过快】小红书暂时限流。${retry}${suffix}`,
      `【Rate limited】Xiaohongshu throttled this request. ${retry}${suffix}`);
  }
  return messageFn(locale, `小红书请求失败：${text}`, `Xiaohongshu request failed: ${text}`);
}

function formatXhsDegradedWarning(error, locale, messageFn) {
  return formatXhsWarning(error, locale, messageFn);
}

function parseSearchNotes(data, maxNotes = 4) {
  const items = data?.data?.items || data?.data?.notes || [];
  if (!Array.isArray(items)) return [];
  const notes = [];
  const seen = new Set();
  for (const item of items) {
    const card = item?.note_card || item?.note || {};
    const model = String(item?.model_type || item?.modelType || '').toLowerCase();
    if (SKIP_SEARCH_MODELS.has(model) || (model && model !== 'note')) continue;
    const noteId = String(item?.id || card.note_id || card.id || '').trim();
    if (!noteId || seen.has(noteId)) continue;
    if (noteId.length < 16 && !/^[0-9a-f]{24}$/i.test(noteId)) continue;
    seen.add(noteId);
    const xsecToken = String(item?.xsec_token || item?.xsecToken || card.xsec_token || '');
    notes.push({
      noteId,
      xsecToken,
      xsecSource: String(item?.xsec_source || item?.xsecSource || 'pc_search'),
      title: String(card.display_title || card.title || item?.display_title || ''),
      url: exploreNoteUrl(noteId, xsecToken, 'pc_search'),
      via: 'search',
    });
    if (notes.length >= maxNotes) break;
  }
  return notes;
}

async function searchNotes(keyword, cookie, maxNotes = 4) {
  const { notes } = await searchNotesDetailed(keyword, cookie, maxNotes);
  return notes;
}

async function searchNotesDetailed(keyword, cookie, maxNotes = 4, options = {}) {
  if (!cookie) throw new XhsSessionError('Xiaohongshu Cookie is empty', 'auth');
  const sort = options.sort === SearchSortType.LATEST || options.sort === SearchSortType.MOST_POPULAR
    ? options.sort
    : SearchSortType.GENERAL;
  const noteType = Number.isFinite(Number(options.noteType)) ? Number(options.noteType) : SearchNoteType.ALL;
  const searchId = String(options.searchId || options.search_id || createSearchId());
  const maxPages = Math.min(3, Number(options.maxPages) > 0 ? Number(options.maxPages) : 2);
  const startPage = Number(options.page) > 0 ? Number(options.page) : 1;
  const collected = [];
  const seen = new Set();
  let hasMore = false;
  let lastPage = startPage;
  let lastDebug = null;

  for (let page = startPage; page < startPage + maxPages && collected.length < maxNotes; page += 1) {
    lastPage = page;
    const remaining = maxNotes - collected.length;
    const data = await withXhsRetry(
      () => post('/api/sns/web/v1/search/notes', {
        keyword: String(keyword || '').trim(),
        page,
        page_size: SEARCH_PAGE_SIZE,
        search_id: searchId,
        sort,
        note_type: noteType,
        ext_flags: [],
        filters: [
          { tags: [sort], type: 'sort_type' },
          { tags: ['不限'], type: 'filter_note_type' },
          { tags: ['不限'], type: 'filter_note_time' },
          { tags: ['不限'], type: 'filter_note_range' },
          { tags: ['不限'], type: 'filter_pos_distance' },
        ],
        geo: '',
        image_formats: ['jpg', 'webp', 'avif'],
      }, cookie, options),
      { cookie, wait: options.wait !== false, maxRetries: options.maxRetries },
    );
    lastDebug = inspectSearchData(data);
    const payload = data?.data && typeof data.data === 'object' ? data.data : {};
    hasMore = Boolean(payload.has_more);
    for (const note of parseSearchNotes(data, remaining)) {
      if (seen.has(note.noteId)) continue;
      seen.add(note.noteId);
      collected.push(note);
      if (collected.length >= maxNotes) break;
    }
    if (!hasMore) break;
  }

  return {
    notes: collected,
    hasMore,
    searchId,
    page: lastPage,
    debug: lastDebug,
  };
}

function inspectSearchData(data) {
  const payload = data?.data && typeof data.data === 'object' ? data.data : {};
  const items = payload.items || payload.notes;
  return {
    success: data?.success,
    code: data?.code ?? null,
    msg: String(data?.msg || '').slice(0, 120),
    dataKeys: Object.keys(payload).slice(0, 16),
    itemCount: Array.isArray(items) ? items.length : null,
    firstModel: items?.[0]?.model_type || items?.[0]?.modelType || null,
    firstKeys: items?.[0] && typeof items[0] === 'object' ? Object.keys(items[0]).slice(0, 16) : [],
    hasMore: Boolean(payload.has_more),
  };
}

function xsecSourceFor(item) {
  if (item?.xsecSource) return String(item.xsecSource);
  return item?.via === 'url' ? 'pc_share' : 'pc_search';
}

function noteFromFeed(data, item) {
  const note = data?.data?.items?.[0]?.note_card;
  if (!note || !(note.desc || note.display_title)) return null;
  return {
    noteId: item.noteId,
    xsecToken: item.xsecToken || '',
    title: String(note.display_title || item.title || '').trim(),
    text: String(note.desc || ''),
    url: item.url,
    via: item.via || 'search',
  };
}

async function fetchSignedFeed(item, cookie) {
  return post('/api/sns/web/v1/feed', {
    source_note_id: item.noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: 1 },
    xsec_source: xsecSourceFor(item),
    xsec_token: item.xsecToken || '',
  }, cookie);
}

function htmlResolved(item) {
  const source = xsecSourceFor(item);
  return {
    noteId: item.noteId,
    xsecToken: item.xsecToken || '',
    xsecSource: source,
    url: item.url || exploreNoteUrl(item.noteId, item.xsecToken, source),
  };
}

async function fetchHtmlFallback(item, cookie) {
  const resolved = htmlResolved(item);
  if (cookie) {
    try {
      const note = await fetchHtmlNote(resolved, { cookie, via: item.via || 'search' });
      if (note) return note;
    } catch {
      // Public SSR is the next layer, matching MediaCrawler enable_cookie then cookie-less HTML.
    }
  }
  return fetchHtmlNote(resolved, { via: item.via || 'search', timeoutMs: 5000 });
}

async function fetchSessionNote(item, cookie) {
  let signedError = null;
  try {
    const data = await withXhsRetry(() => fetchSignedFeed(item, cookie), { cookie });
    const note = noteFromFeed(data, item);
    if (note) return note;
  } catch (error) {
    signedError = error;
    if (isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)) {
      const htmlCookie = isXhsRateLimitError(error) ? cookie : null;
      try { error.fallbackNote = await fetchHtmlFallback(item, htmlCookie); } catch { /* keep signed error */ }
      throw error;
    }
    if (isXhsNotFoundError(error)) {
      try { return await fetchHtmlFallback(item, cookie); } catch { throw error; }
    }
  }
  try {
    return await fetchHtmlFallback(item, cookie);
  } catch (htmlError) {
    if (signedError) throw signedError;
    throw htmlError;
  }
}

function pickCoverImageUrl(noteCard) {
  const imageList = noteCard?.image_list || noteCard?.imageList || [];
  const first = imageList[0];
  if (!first || typeof first !== 'object') return '';
  const infoList = first.info_list || first.infoList || [];
  if (Array.isArray(infoList) && infoList.length > 1 && infoList[1]?.url) return String(infoList[1].url);
  if (Array.isArray(infoList) && infoList[0]?.url) return String(infoList[0].url);
  return String(first.url_default || first.urlDefault || first.url_pre || first.urlPre || first.url || '');
}

async function fetchNoteCoverImage(item, cookie) {
  const data = await post('/api/sns/web/v1/feed', {
    source_note_id: item.noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: 0 },
    xsec_source: xsecSourceFor(item),
    xsec_token: item.xsecToken || '',
  }, cookie);
  const noteCard = data?.data?.items?.[0]?.note_card;
  return pickCoverImageUrl(noteCard);
}

module.exports = {
  SEARCH_PAGE_SIZE,
  XhsSessionError,
  normalizeXhsCookie,
  assertSessionResponse,
  isXhsAuthError,
  isXhsVerificationError,
  isXhsNotFoundError,
  formatXhsWarning,
  formatXhsDegradedWarning,
  searchNotes,
  searchNotesDetailed,
  fetchSessionNote,
  fetchNoteCoverImage,
  parseSearchNotes,
  pong,
};
