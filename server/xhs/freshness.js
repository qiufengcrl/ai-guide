const crypto = require('node:crypto');

const XHS_COOKIE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieFingerprint(cookie) {
  const raw = String(cookie || '').trim();
  if (!raw) return '';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

async function resolveActingUserId(ctx, explicit) {
  for (const value of [explicit, ctx?.user?.id, ctx?.actingUserId]) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

function parseTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

async function readXhsCookieUpdatedAt(ctx, userId, cookie) {
  const dbStamps = [];
  if (userId != null) {
    try {
      const rows = await ctx.db.query('SELECT xhs_cookie_updated_at FROM user_meta WHERE user_id = ?', userId);
      dbStamps.push(parseTimestamp(rows[0]?.xhs_cookie_updated_at));
    } catch {
      // table may not exist yet
    }
  }
  const fp = cookieFingerprint(cookie);
  if (fp) {
    try {
      const rows = await ctx.db.query('SELECT updated_at FROM xhs_cookie_clock WHERE fp = ?', fp);
      dbStamps.push(parseTimestamp(rows[0]?.updated_at));
    } catch {
      // table may not exist yet
    }
  }
  const dbMax = dbStamps.reduce((max, value) => (value > max ? value : max), 0);
  // User-writable settings can only fill in when no server stamp exists; they cannot
  // hide a stale DB value, and future timestamps are ignored.
  if (dbMax) return dbMax;

  let settingsStamp = 0;
  try {
    settingsStamp = parseTimestamp(await ctx.settings.get('xhs_cookie_updated_at'));
  } catch {
    // settings.get may be unavailable in userless contexts
  }
  if (!settingsStamp || settingsStamp > Date.now()) return 0;
  return settingsStamp;
}

async function writeXhsCookieUpdatedAt(ctx, userId, cookie, at = Date.now()) {
  const stamp = Number(at) || Date.now();
  if (typeof ctx.settings?.set === 'function') {
    try { await ctx.settings.set('xhs_cookie_updated_at', String(stamp)); } catch { /* SDK may be read-only */ }
  }
  if (userId == null) return;
  try {
    await ctx.db.exec(
      'INSERT INTO user_meta (user_id, xhs_cookie_updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET xhs_cookie_updated_at = excluded.xhs_cookie_updated_at',
      userId,
      stamp,
    );
  } catch {
    // Health check / testXhs should not fail because meta storage is unavailable.
  }
  const fp = cookieFingerprint(cookie);
  if (!fp) return;
  try {
    await ctx.db.exec(
      'INSERT INTO xhs_cookie_clock (fp, user_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(fp) DO UPDATE SET updated_at = excluded.updated_at, user_id = excluded.user_id',
      fp,
      userId,
      stamp,
    );
  } catch {
    // Same as user_meta: persistence is best-effort.
  }
}

module.exports = {
  XHS_COOKIE_STALE_MS,
  cookieFingerprint,
  resolveActingUserId,
  parseTimestamp,
  readXhsCookieUpdatedAt,
  writeXhsCookieUpdatedAt,
};
