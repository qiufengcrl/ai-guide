const { searchNotesDetailed, fetchNoteCoverImage } = require('./session');
const { withXhsRetry } = require('./throttle');

const PHOTO_CACHE_MAX = 256;
const PHOTO_CACHE_HIT_TTL_MS = 6 * 60 * 60 * 1000;
const PHOTO_CACHE_MISS_TTL_MS = 10 * 60 * 1000;
const photoCache = new Map();

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
  photoCache.set(key, {
    url: String(url || ''),
    expiresAt: Date.now() + (url ? PHOTO_CACHE_HIT_TTL_MS : PHOTO_CACHE_MISS_TTL_MS),
  });
  if (photoCache.size > PHOTO_CACHE_MAX) {
    const oldest = photoCache.keys().next().value;
    if (oldest) photoCache.delete(oldest);
  }
}

async function getXhsPhoto(name, cookie, destination = '') {
  const label = String(name || '').trim();
  if (!label || !cookie) return '';
  const cacheKey = `${destination}::${label}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let url = '';
  try {
    const query = `${label} 风景`;
    const { notes } = await withXhsRetry(() => searchNotesDetailed(query, cookie, 1, { sort: 'time_descending' }));
    const item = notes[0];
    if (item) url = await withXhsRetry(() => fetchNoteCoverImage(item, cookie));
  } catch {
    url = '';
  }
  cachePut(cacheKey, url);
  return url;
}

module.exports = {
  getXhsPhoto,
};
