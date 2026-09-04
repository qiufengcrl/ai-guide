const { fetchWithTimeout, fetchPublicNote } = require('./url');
const { createSearchId, createSignedPost } = require('./signature');

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

function assertSessionResponse(data) {
  const code = Number(data?.code);
  const message = String(data?.msg || '');
  if (code === 300011 || message.includes('异常')) {
    throw new XhsSessionError(`Xiaohongshu rejected the signed session (code=${code || 'unknown'}): ${message || 'account risk control'}`);
  }
  if (data?.success === false) throw new XhsSessionError(message || `Xiaohongshu returned code ${code || 'unknown'}`);
  return data;
}

async function post(path, body, cookie) {
  let signed;
  try {
    signed = createSignedPost(path, body, cookie);
  } catch (error) {
    throw new XhsSessionError(error instanceof Error ? error.message : 'Xiaohongshu request signing failed');
  }
  const response = await fetchWithTimeout(`https://edith.xiaohongshu.com${path}`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  }, 12000);
  if (!response.ok) throw new XhsSessionError(`Xiaohongshu returned ${response.status}`);
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
    notes.push({
      noteId,
      xsecToken: String(item?.xsec_token || item?.xsecToken || card.xsec_token || ''),
      title: String(card.display_title || card.title || item?.display_title || ''),
      url: `https://www.xiaohongshu.com/explore/${noteId}`,
    });
    if (notes.length >= maxNotes) break;
  }
  return notes;
}

async function searchNotes(keyword, cookie, maxNotes = 4) {
  if (!cookie) throw new XhsSessionError('Xiaohongshu Cookie is empty');
  const data = await post('/api/sns/web/v1/search/notes', {
    keyword: String(keyword || '').trim(),
    page: 1,
    page_size: Math.min(20, Math.max(1, maxNotes)),
    search_id: createSearchId(),
    sort: 'general',
    note_type: 0,
    ext_flags: [],
    image_formats: ['jpg', 'webp', 'avif'],
  }, cookie);
  return parseSearchNotes(data, maxNotes);
}

async function fetchSessionNote(item, cookie) {
  try {
    const data = await post('/api/sns/web/v1/feed', {
      source_note_id: item.noteId,
      image_formats: ['jpg', 'webp', 'avif'],
      extra: { need_body_topic: '1' },
      xsec_source: 'pc_search',
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
  } catch {
    // Public SSR is the intentional detail fallback.
  }
  const note = await fetchPublicNote(item.url, cookie);
  return { ...note, via: 'search' };
}

module.exports = {
  XhsSessionError,
  normalizeXhsCookie,
  assertSessionResponse,
  searchNotes,
  fetchSessionNote,
  parseSearchNotes,
};
