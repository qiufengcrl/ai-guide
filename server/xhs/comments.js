const { fetchWithTimeout } = require('./url');
const { createSignedGet } = require('./signature');
const { XhsSessionError, throwForHttpStatus, assertSessionResponse } = require('./errors');

const COMMENT_PAGE_PATH = '/api/sns/web/v2/comment/page';
const COMMENT_SUB_PAGE_PATH = '/api/sns/web/v2/comment/sub/page';
const DEFAULT_MAX_COMMENTS = 40;
const COMMENT_GUIDE_LIMIT = 5;

function pushComment(item, texts, maxComments) {
  const content = String(item?.content || '').trim();
  if (content) texts.push(content);
  const subs = item?.sub_comments || item?.subComments || [];
  for (const sub of Array.isArray(subs) ? subs : []) {
    if (texts.length >= maxComments) return;
    pushComment(sub, texts, maxComments);
  }
}

function parseCommentTexts(data, maxComments = DEFAULT_MAX_COMMENTS) {
  const comments = data?.data?.comments || data?.comments;
  if (!Array.isArray(comments)) return [];
  const texts = [];
  for (const item of comments) {
    if (texts.length >= maxComments) break;
    pushComment(item, texts, maxComments);
  }
  return texts;
}

function commentQuery(noteId, options = {}) {
  return {
    note_id: String(noteId || '').trim(),
    cursor: String(options.cursor || ''),
    top_comment_id: '',
    image_formats: 'jpg,webp,avif',
    xsec_token: String(options.xsecToken || options.xsec_token || ''),
  };
}

async function signedGetJson(path, params, cookie, options = {}) {
  let signed;
  try {
    signed = createSignedGet(path, params, cookie, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Xiaohongshu request signing failed';
    const code = /missing the a1|missing the web_session|cookie is empty/i.test(detail) ? 'auth' : 'fetch';
    throw new XhsSessionError(detail, code);
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  let response;
  try {
    response = await fetchWithTimeout(signed.url, {
      method: 'GET',
      headers: signed.headers,
    }, timeoutMs);
  } catch (error) {
    throw new XhsSessionError(error instanceof Error ? error.message : 'Xiaohongshu network error', 'fetch');
  }
  throwForHttpStatus(response);
  return assertSessionResponse(await response.json());
}

async function fetchNoteComments(noteId, cookie, options = {}) {
  const id = String(noteId || '').trim();
  if (!id) throw new XhsSessionError('note_id is required for comments', 'fetch');
  if (!cookie) throw new XhsSessionError('Xiaohongshu Cookie is empty', 'auth');

  const data = await signedGetJson(COMMENT_PAGE_PATH, commentQuery(id, options), cookie, options);
  const maxComments = Number(options.maxComments) > 0 ? Number(options.maxComments) : DEFAULT_MAX_COMMENTS;
  return parseCommentTexts(data, maxComments);
}

module.exports = {
  COMMENT_PAGE_PATH,
  COMMENT_SUB_PAGE_PATH,
  COMMENT_GUIDE_LIMIT,
  DEFAULT_MAX_COMMENTS,
  parseCommentTexts,
  fetchNoteComments,
  commentQuery,
};
