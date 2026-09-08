// Per-user note/comment cache (MediaCrawler-style local store, TREK-safe).
//
// Feasible: db:own tables keyed by user_id + note_id, short TTL, cleared in
// deleteUserData, never written into exportUserData (avoid duplicating guide text).
//
// Not feasible: a global/cross-user note library. Signed feed/comment payloads
// are session-personalized, and db:own forbids sharing another user's rows.
const NOTE_TABLE = 'xhs_note_cache';
const COMMENT_TABLE = 'xhs_comment_cache';
const TTL_MS = 6 * 60 * 60 * 1000;

function validUserId(userId) {
  const uid = Number(userId);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

async function readRow(ctx, table, userId, noteId) {
  const uid = validUserId(userId);
  const id = String(noteId || '').trim();
  if (!ctx?.db || !uid || !id) return null;
  try {
    const rows = await ctx.db.query(
      `SELECT payload_json, fetched_at FROM ${table} WHERE user_id = ? AND note_id = ?`,
      uid,
      id,
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() - Number(row.fetched_at || 0) > TTL_MS) {
      try { await ctx.db.exec(`DELETE FROM ${table} WHERE user_id = ? AND note_id = ?`, uid, id); } catch { /* ignore */ }
      return null;
    }
    const payload = JSON.parse(String(row.payload_json || ''));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

async function writeRow(ctx, table, userId, noteId, payload) {
  const uid = validUserId(userId);
  const id = String(noteId || '').trim();
  if (!ctx?.db || !uid || !id || !payload || typeof payload !== 'object') return;
  try {
    await ctx.db.exec(
      `DELETE FROM ${table} WHERE user_id = ? AND fetched_at < ?`,
      uid,
      Date.now() - TTL_MS,
    );
  } catch {
    // Best-effort sweep; write still proceeds.
  }
  try {
    await ctx.db.exec(
      `INSERT INTO ${table} (user_id, note_id, payload_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, note_id) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
      uid,
      id,
      JSON.stringify(payload),
      Date.now(),
    );
  } catch {
    // Cache must never break planning if the table is missing or the row is too large.
  }
}

async function readNote(ctx, userId, noteId) {
  return readRow(ctx, NOTE_TABLE, userId, noteId);
}

async function writeNote(ctx, userId, noteId, note) {
  if (!note || !String(note.text || '').trim()) return;
  return writeRow(ctx, NOTE_TABLE, userId, noteId, {
    noteId: note.noteId || noteId,
    xsecToken: note.xsecToken || '',
    title: note.title || '',
    text: String(note.text || '').slice(0, 4000),
    url: note.url || '',
    via: note.via || 'search',
  });
}

async function readComments(ctx, userId, noteId) {
  const row = await readRow(ctx, COMMENT_TABLE, userId, noteId);
  return Array.isArray(row?.texts) ? row.texts : null;
}

async function writeComments(ctx, userId, noteId, texts) {
  if (!Array.isArray(texts) || !texts.length) return;
  return writeRow(ctx, COMMENT_TABLE, userId, noteId, { texts });
}

async function deleteUserCache(ctx, userId) {
  const uid = validUserId(userId);
  if (!ctx?.db || !uid) return;
  try { await ctx.db.exec('DELETE FROM xhs_note_cache WHERE user_id = ?', uid); } catch { /* ignore */ }
  try { await ctx.db.exec('DELETE FROM xhs_comment_cache WHERE user_id = ?', uid); } catch { /* ignore */ }
}

module.exports = {
  TTL_MS,
  readNote,
  writeNote,
  readComments,
  writeComments,
  deleteUserCache,
};
