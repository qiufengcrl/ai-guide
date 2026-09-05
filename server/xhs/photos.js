const { searchNotesDetailed, fetchNoteCoverImage } = require('./session');
const { withXhsRetry } = require('./throttle');
const { cookieFingerprint } = require('./freshness');

const PHOTO_CACHE_MAX = 256;
const PHOTO_CACHE_HIT_TTL_MS = 6 * 60 * 60 * 1000;
const photoCache = new Map();

function cacheKey(destination, label, cookie) {
  return `${cookieFingerprint(cookie)}::${destination}::${label}`;
}

function cacheGet(key) {
  const entry = photoCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    photoCache.delete(key);
    return undefined;
  }
  return entry.url;
}

function cachePut(key, url) {
  const href = String(url || '').trim();
  if (!href) return;
  photoCache.set(key, {
    url: href,
    expiresAt: Date.now() + PHOTO_CACHE_HIT_TTL_MS,
  });
  if (photoCache.size > PHOTO_CACHE_MAX) {
    const oldest = photoCache.keys().next().value;
    if (oldest) photoCache.delete(oldest);
  }
}

function resetXhsPhotoCacheForTests() {
  photoCache.clear();
}

async function getXhsPhoto(name, cookie, destination = '') {
  const label = String(name || '').trim();
  if (!label || !cookie) return '';
  const key = cacheKey(destination, label, cookie);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const query = `${label} 风景`;
  const { notes } = await withXhsRetry(
    () => searchNotesDetailed(query, cookie, 1, { sort: 'time_descending' }),
    { cookie },
  );
  const item = notes[0];
  if (!item) return '';
  const url = await withXhsRetry(() => fetchNoteCoverImage(item, cookie), { cookie });
  cachePut(key, url);
  return url || '';
}

module.exports = {
  getXhsPhoto,
  resetXhsPhotoCacheForTests,
};
