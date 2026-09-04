const { UA, fetchXhs, fetchPublicNote, exploreNoteUrl } = require('./url');

const SEARCH_PAGE_SIZE = 20;
const SEARCH_PATH = '/api/sns/web/v1/search/notes';
const FEED_PATH = '/api/sns/web/v1/feed';

class XhsSessionError extends Error {}

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

function cookieMap(cookie) {
  const map = {};
  for (const part of String(cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    map[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return map;
}

function assertUsableCookie(cookie) {
  if (!cookie) throw new XhsSessionError('Xiaohongshu Cookie is empty');
  const keys = cookieMap(cookie);
  if (!keys.a1 || !keys.web_session) {
    throw new XhsSessionError('Xiaohongshu Cookie is missing a1 or web_session');
  }
}

function searchId() {
  const chars = 'abcdef0123456789';
  let value = '';
  for (let i = 0; i < 21; i += 1) value += chars[Math.floor(Math.random() * 16)];
  return value;
}

function sessionHeaders(cookie) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json;charset=UTF-8',
    origin: 'https://www.xiaohongshu.com',
    referer: 'https://www.xiaohongshu.com/',
    cookie,
    'user-agent': UA,
  };
}

function assertSessionResponse(response, data) {
  if (response.status === 461 || response.status === 471) {
    throw new XhsSessionError('Xiaohongshu requested verification');
  }
  const code = Number(data?.code);
  const message = String(data?.msg || '');
  if (code === 300011 || message.includes('异常') || message.includes('登录')) {
    throw new XhsSessionError('Xiaohongshu session is unavailable');
  }
  if (data?.success === false) throw new XhsSessionError(message || `Xiaohongshu returned code ${code || 'unknown'}`);
  return data;
}

async function post(path, body, cookie) {
  assertUsableCookie(cookie);
  const response = await fetchXhs(`https://edith.xiaohongshu.com${path}`, {
    method: 'POST',
    headers: sessionHeaders(cookie),
    body: JSON.stringify(body),
  }, 12000);
  if (response.status === 461 || response.status === 471) {
    throw new XhsSessionError('Xiaohongshu requested verification');
  }
  if (!response.ok) throw new XhsSessionError(`Xiaohongshu returned ${response.status}`);
  return assertSessionResponse(response, await response.json());
}

function searchPayload(keyword) {
  return {
    keyword,
    page: 1,
    page_size: SEARCH_PAGE_SIZE,
    search_id: searchId(),
    sort: 'general',
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
  };
}

function toSearchNote(item) {
  const noteId = String(item?.id || item?.note_id || item?.note_card?.note_id || '');
  if (item?.model_type !== 'note' || !noteId) return null;
  const xsecToken = String(item.xsec_token || '');
  return {
    noteId,
    xsecToken,
    xsecSource: 'pc_search',
    title: String(item.note_card?.display_title || ''),
    url: exploreNoteUrl(noteId, xsecToken, 'pc_search'),
  };
}

async function searchNotes(keyword, cookie, maxNotes = 4) {
  const data = await post(SEARCH_PATH, searchPayload(keyword), cookie);
  return (data?.data?.items || [])
    .map(toSearchNote)
    .filter(Boolean)
    .slice(0, Math.min(8, Math.max(1, maxNotes)));
}

async function fetchSessionNote(item, cookie) {
  try {
    const data = await post(FEED_PATH, {
      source_note_id: item.noteId,
      image_formats: ['jpg', 'webp', 'avif'],
      extra: { need_body_topic: '1' },
      xsec_source: item.xsecSource || 'pc_search',
      xsec_token: item.xsecToken || '',
    }, cookie);
    const note = data?.data?.items?.[0]?.note_card;
    if (note && (note.desc || note.display_title)) {
      return {
        noteId: item.noteId,
        title: String(note.display_title || item.title || ''),
        text: String(note.desc || ''),
        url: item.url,
        via: 'search',
      };
    }
  } catch (error) {
    if (error instanceof XhsSessionError && /verification/i.test(error.message)) throw error;
  }
  const note = await fetchPublicNote(item.url);
  return { ...note, via: 'search' };
}

module.exports = {
  SEARCH_PAGE_SIZE,
  XhsSessionError,
  normalizeXhsCookie,
  assertSessionResponse,
  assertUsableCookie,
  searchNotes,
  fetchSessionNote,
  searchPayload,
};
