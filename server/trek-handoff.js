const { buildTrekPlaceNotes } = require('./guide-quality');

function safeHttpsImageUrl(url) {
  const text = String(url || '').trim();
  if (!/^https:\/\//i.test(text)) return undefined;
  return text.slice(0, 2000);
}

async function loadTrekCategoryMap(ctx) {
  const map = { food: null, sight: null };
  try {
    const list = await ctx.categories.list();
    for (const category of list || []) {
      const id = Number(category?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const label = `${String(category?.name || '')} ${String(category?.icon || '')}`.toLowerCase();
      if (!map.food && /food|restaurant|餐饮|美食|吃|餐/.test(label)) map.food = id;
      if (!map.sight && /sight|attraction|景点|参观|museum|博物馆|地标|寺|公园/.test(label)) map.sight = id;
    }
    if (!map.sight) {
      const fallback = (list || []).find((category) => Number(category?.id) > 0);
      if (fallback) map.sight = Number(fallback.id);
    }
  } catch {
    // Category lookup is best-effort; commit should still succeed without it.
  }
  return map;
}

function buildTrekPlacePayload(item, guides, categoryMap, locale = 'zh') {
  const reason = String(item?.reason || '').trim();
  const notes = buildTrekPlaceNotes(item, guides, locale);
  const categoryId = item?.categoryHint === 'food' ? categoryMap.food : categoryMap.sight;
  const payload = {
    name: item.name,
    lat: item.lat,
    lng: item.lng,
    address: item.address || '',
    notes,
  };
  if (reason) payload.description = reason.slice(0, 2000);
  if (Number.isInteger(item?.stayMinutes) && item.stayMinutes > 0) {
    payload.duration_minutes = item.stayMinutes;
  }
  if (categoryId) payload.category_id = categoryId;
  const imageUrl = safeHttpsImageUrl(item?.photoUrl);
  if (imageUrl) payload.image_url = imageUrl;
  if (item?.placeId) payload.google_place_id = String(item.placeId);
  if (item?.osmId) payload.osm_id = String(item.osmId);
  return payload;
}

module.exports = {
  loadTrekCategoryMap,
  buildTrekPlacePayload,
  safeHttpsImageUrl,
};
