const session = require('../xhs/session');
const comments = require('../xhs/comments');
const client = require('../xhs/client');
const cache = require('../xhs/cache');

async function fetchNote(item, cookie, options = {}) {
  if (options.cache !== false) {
    const hit = await cache.readNote(options.ctx, options.userId, item?.noteId);
    if (hit) return { ...hit, xsecToken: item?.xsecToken || hit.xsecToken || '' };
  }
  const note = await session.fetchSessionNote(item, cookie);
  if (options.cache !== false) await cache.writeNote(options.ctx, options.userId, item?.noteId, note);
  return note;
}

async function fetchComments(noteId, cookie, options = {}) {
  if (options.cache !== false) {
    const hit = await cache.readComments(options.ctx, options.userId, noteId);
    if (hit) return hit;
  }
  const texts = await comments.fetchNoteComments(noteId, cookie, options);
  if (options.cache !== false) await cache.writeComments(options.ctx, options.userId, noteId, texts);
  return texts;
}

module.exports = {
  id: 'xhs',
  SEARCH_PAGE_SIZE: session.SEARCH_PAGE_SIZE,
  pong: (cookie, options) => client.pong(cookie, options),
  search: (keyword, cookie, maxNotes, options) => session.searchNotesDetailed(keyword, cookie, maxNotes, options),
  fetchNote,
  fetchComments,
};
