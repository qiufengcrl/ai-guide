const { get } = require('./client');
const { XhsSessionError } = require('./errors');
const { withXhsRetry } = require('./throttle');

const COMMENT_PAGE_PATH = '/api/sns/web/v2/comment/page';
const COMMENT_SUB_PAGE_PATH = '/api/sns/web/v2/comment/sub/page';
const DEFAULT_MAX_COMMENTS = 40;
const COMMENT_GUIDE_LIMIT = 5;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_MAX_SUB_PARENTS = 3;

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

function commentItems(data) {
  const comments = data?.data?.comments || data?.comments;
  return Array.isArray(comments) ? comments : [];
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

function subCommentQuery(noteId, rootCommentId, options = {}) {
  return {
    note_id: String(noteId || '').trim(),
    root_comment_id: String(rootCommentId || ''),
    num: String(options.num || 10),
    cursor: String(options.cursor || ''),
    image_formats: 'jpg,webp,avif',
    top_comment_id: '',
    xsec_token: String(options.xsecToken || options.xsec_token || ''),
  };
}

async function signedCommentGet(path, params, cookie, options = {}) {
  return withXhsRetry(
    () => get(path, params, cookie, options),
    {
      cookie,
      userId: options.userId,
      wait: options.wait !== false,
      maxRetries: options.maxRetries,
    },
  );
}

async function fetchSubComments(noteId, cookie, parent, options = {}) {
  const texts = [];
  const maxComments = Number(options.maxComments) > 0 ? Number(options.maxComments) : DEFAULT_MAX_COMMENTS;
  let cursor = String(parent.sub_comment_cursor || parent.subCommentCursor || '');
  let hasMore = true;
  let pages = 0;
  while (hasMore && texts.length < maxComments && pages < 2) {
    const data = await signedCommentGet(COMMENT_SUB_PAGE_PATH, subCommentQuery(noteId, parent.id, {
      ...options,
      cursor,
    }), cookie, options);
    const pageTexts = parseCommentTexts({ data: { comments: commentItems(data) } }, maxComments - texts.length);
    texts.push(...pageTexts);
    hasMore = Boolean(data?.data?.has_more ?? data?.has_more);
    cursor = String(data?.data?.cursor || data?.cursor || '');
    pages += 1;
  }
  return texts;
}

async function fetchNoteComments(noteId, cookie, options = {}) {
  const id = String(noteId || '').trim();
  if (!id) throw new XhsSessionError('note_id is required for comments', 'fetch');
  if (!cookie) throw new XhsSessionError('Xiaohongshu Cookie is empty', 'auth');

  const maxComments = Number(options.maxComments) > 0 ? Number(options.maxComments) : DEFAULT_MAX_COMMENTS;
  const maxPages = Math.min(3, Number(options.maxPages) > 0 ? Number(options.maxPages) : DEFAULT_MAX_PAGES);
  const texts = [];
  let cursor = String(options.cursor || '');
  let hasMore = true;
  let pages = 0;
  let subParents = 0;

  while (hasMore && texts.length < maxComments && pages < maxPages) {
    const data = await signedCommentGet(COMMENT_PAGE_PATH, commentQuery(id, { ...options, cursor }), cookie, options);
    texts.push(...parseCommentTexts(data, maxComments - texts.length));
    if (options.subComments !== false) {
      for (const item of commentItems(data)) {
        if (texts.length >= maxComments) break;
        if (subParents >= DEFAULT_MAX_SUB_PARENTS) break;
        if (!item?.sub_comment_has_more && !item?.subCommentHasMore) continue;
        subParents += 1;
        const extras = await fetchSubComments(id, cookie, item, {
          ...options,
          maxComments: maxComments - texts.length,
        });
        texts.push(...extras.slice(0, maxComments - texts.length));
      }
    }
    hasMore = Boolean(data?.data?.has_more);
    cursor = String(data?.data?.cursor || '');
    pages += 1;
  }
  return texts;
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
