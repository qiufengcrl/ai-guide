const { fetchWithTimeout } = require('./url');
const { createSignedGet } = require('./signature');
const { assertSessionResponse, XhsSessionError } = require('./session');

const COMMENT_PAGE_PATH = '/api/sns/web/v2/comment/page';
const DEFAULT_MAX_COMMENTS = 24;

function parseCommentTexts(data, maxComments = DEFAULT_MAX_COMMENTS) {
  const comments = data?.data?.comments;
  if (!Array.isArray(comments)) return [];
  const texts = [];
  for (const item of comments) {
    const content = String(item?.content || '').trim();
    if (!content) continue;
    texts.push(content);
    if (texts.length >= maxComments) break;
  }
  return texts;
}

async function fetchNoteComments(noteId, cookie, options = {}) {
  const id = String(noteId || '').trim();
  if (!id) throw new XhsSessionError('note_id is required for comments', 'fetch');
  if (!cookie) throw new XhsSessionError('Xiaohongshu Cookie is empty', 'auth');

  const signed = createSignedGet(COMMENT_PAGE_PATH, {
    note_id: id,
    cursor: String(options.cursor || ''),
    top_comment_id: '',
    image_formats: ['jpg', 'webp', 'avif'],
  }, cookie, options);
  const query = new URLSearchParams({
    note_id: id,
    cursor: String(options.cursor || ''),
    top_comment_id: '',
    image_formats: 'jpg,webp,avif',
  });
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  let response;
  try {
    response = await fetchWithTimeout(`https://edith.xiaohongshu.com${COMMENT_PAGE_PATH}?${query}`, {
      method: 'GET',
      headers: signed.headers,
    }, timeoutMs);
  } catch (error) {
    throw new XhsSessionError(error instanceof Error ? error.message : 'Xiaohongshu network error', 'fetch');
  }
  if (response.status === 461 || response.status === 471) {
    throw new XhsSessionError(`Xiaohongshu requested verification (${response.status})`, 'verification');
  }
  if (!response.ok) throw new XhsSessionError(`Xiaohongshu returned ${response.status}`, 'fetch');
  const data = assertSessionResponse(await response.json());
  const maxComments = Number(options.maxComments) > 0 ? Number(options.maxComments) : DEFAULT_MAX_COMMENTS;
  return parseCommentTexts(data, maxComments);
}

module.exports = {
  COMMENT_PAGE_PATH,
  parseCommentTexts,
  fetchNoteComments,
};
