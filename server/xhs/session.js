const { fetchWithTimeout, fetchPublicNote, exploreNoteUrl } = require('./url');
const { createSearchId, createSignedPost } = require('./signature');
const { isXhsRateLimitError, withXhsRetry } = require('./throttle');

const SEARCH_PAGE_SIZE = 20;

class XhsSessionError extends Error {
  constructor(message, code = 'fetch') {
    super(message);
    this.name = 'XhsSessionError';
    this.code = code;
  }
}

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

function isXhsAuthError(error) {
  if (!(error instanceof XhsSessionError)) {
    return /300011|signed session|missing the a1|missing the web_session|cookie is empty/i.test(String(error?.message || error || ''));
  }
  return error.code === 'auth';
}

function isXhsVerificationError(error) {
  if (error instanceof XhsSessionError && error.code === 'verification') return true;
  return /461|471|verification/i.test(String(error?.message || error || ''));
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
      `【需要验证】小红书要求验证码或触发风控（461）。请在本机浏览器登录后更新 Cookie。已降级继续。${suffix}`,
      `【Verification required】Xiaohongshu requested captcha or risk control (461). Log in locally and update your Cookie. Degraded and continuing. ${suffix}`);
  }
  if (isXhsRateLimitError(error) || /429|频繁|cuqps|too many requests|rate limit/i.test(text)) {
    return messageFn(locale,
      `【请求过快】小红书暂时限流。请稍后重试关键词搜索。${suffix}`,
      `【Rate limited】Xiaohongshu throttled this request. Try keyword search later. ${suffix}`);
  }
  return messageFn(locale, `小红书请求失败：${text}`, `Xiaohongshu request failed: ${text}`);
}

function formatXhsDegradedWarning(error, locale, messageFn) {
  return formatXhsWarning(error, locale, messageFn);
}

function assertSessionResponse(data) {
  const code = Number(data?.code);
  const msg = String(data?.msg || '');
  if (code === 300011 || msg.includes('异常')) {
    throw new XhsSessionError(`Xiaohongshu rejected the signed session (code=${code || 'unknown'}): ${msg || 'account risk control'}`, 'auth');
  }
  if (data?.success === false) throw new XhsSessionError(msg || `Xiaohongshu returned code ${code || 'unknown'}`, 'fetch');
  return data;
}

async function post(path, body, cookie) {
  let signed;
  try {
    signed = createSignedPost(path, body, cookie);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Xiaohongshu request signing failed';
    const code = /missing the a1|missing the web_session|cookie is empty/i.test(detail) ? 'auth' : 'fetch';
    throw new XhsSessionError(detail, code);
  }
  let response;
  try {
    response = await fetchWithTimeout(`https://edith.xiaohongshu.com${path}`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    }, 12000);
  } catch (error) {
    throw new XhsSessionError(error instanceof Error ? error.message : 'Xiaohongshu network error', 'fetch');
  }
  if (response.status === 461 || response.status === 471) {
    throw new XhsSessionError(`Xiaohongshu requested verification (${response.status})`, 'verification');
  }
  if (!response.ok) throw new XhsSessionError(`Xiaohongshu returned ${response.status}`, 'fetch');
  return assertSessionResponse(await response.json());
}

function parseSearchNotes(data, maxNotes = 4) {
  const items = data?.data?.items || data?.data?.notes || [];
  if (!Array.isArray(items)) return [];
  const notes = [];
  const seen = new Set();
  for (const item of items) {
    const card = item?.note_card || item?.note || {};
    const model = String(item?.model_type || item?.modelType || '').toLowerCase();
    if (model && model !== 'note') continue;
    const noteId = String(item?.id || card.note_id || card.id || '').trim();
    if (!noteId || seen.has(noteId)) continue;
    if (noteId.length < 16 && !/^[0-9a-f]{24}$/i.test(noteId)) continue;
    seen.add(noteId);
    const xsecToken = String(item?.xsec_token || item?.xsecToken || card.xsec_token || '');
    notes.push({
      noteId,
      xsecToken,
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
  const sort = options.sort === 'time_descending' ? 'time_descending' : 'general';
  const data = await post('/api/sns/web/v1/search/notes', {
    keyword: String(keyword || '').trim(),
    page: 1,
    page_size: SEARCH_PAGE_SIZE,
    search_id: createSearchId(),
    sort,
    note_type: 0,
    ext_flags: [],
    filters: [
      { tags: ['general'], type: 'sort_type' },
      { tags: ['不限'], type: 'filter_note_type' },
      { tags: ['不限'], type: 'filter_note_time' },
      { tags: ['不限'], type: 'filter_note_range' },
      { tags: ['不限'], type: 'filter_pos_distance' },
    ],
    geo: '',
    image_formats: ['jpg', 'webp', 'avif'],
  }, cookie);
  return { notes: parseSearchNotes(data, maxNotes), debug: inspectSearchData(data) };
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
  };
}

async function fetchSignedFeed(item, cookie) {
  return post('/api/sns/web/v1/feed', {
    source_note_id: item.noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: '1' },
    xsec_source: 'pc_search',
    xsec_token: item.xsecToken || '',
  }, cookie);
}

async function fetchSessionNote(item, cookie) {
  try {
    const data = await withXhsRetry(() => fetchSignedFeed(item, cookie), { cookie });
    const note = data?.data?.items?.[0]?.note_card;
    if (note && (note.desc || note.display_title)) {
      return {
        noteId: item.noteId,
        title: String(note.display_title || item.title || '').trim(),
        text: String(note.desc || ''),
        url: item.url,
        via: item.via || 'search',
      };
    }
  } catch (error) {
    if (isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)) {
      if (isXhsRateLimitError(error) && item.url) {
        try { error.fallbackNote = await fetchPublicNote(item.url); } catch { /* keep signed error */ }
      }
      throw error;
    }
    // Public SSR is the intentional detail fallback for fetch/network failures.
  }
  const note = await fetchPublicNote(item.url);
  return { ...note, via: item.via || 'search' };
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
    extra: { need_body_topic: '0' },
    xsec_source: item.via === 'search' ? 'pc_search' : 'pc_share',
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
  formatXhsWarning,
  formatXhsDegradedWarning,
  searchNotes,
  searchNotesDetailed,
  fetchSessionNote,
  fetchNoteCoverImage,
  parseSearchNotes,
};
