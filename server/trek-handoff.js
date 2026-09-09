const {
  attachPreviewTips,
  buildTrekPlaceNotes,
  collectReservations,
} = require('./guide-quality');

const HANDOFF_KEY = 'ai-guide.handoff';
const HANDOFF_VERSION = 1;
const MAX_PREP_TIPS = 20;
const MAX_SOURCES = 16;
const MAX_RESERVATIONS = 40;
const MAX_WARNINGS = 12;

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
    address: item.address || '',
    notes,
  };
  if (typeof item.lat === 'number' && Number.isFinite(item.lat)
    && typeof item.lng === 'number' && Number.isFinite(item.lng)) {
    payload.lat = item.lat;
    payload.lng = item.lng;
  }
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

function compactBudget(budget) {
  if (!budget || typeof budget !== 'object') return null;
  const pickTier = (tier) => {
    if (!tier || typeof tier !== 'object') return null;
    return {
      transport: Number(tier.transport) || 0,
      lodging: Number(tier.lodging) || 0,
      tickets: Number(tier.tickets) || 0,
      food: Number(tier.food) || 0,
      total: Number(tier.total) || 0,
      ...(tier.notes ? { notes: String(tier.notes).slice(0, 200) } : {}),
    };
  };
  return {
    currency: String(budget.currency || 'CNY').toUpperCase(),
    days: Math.max(1, Number(budget.days) || 1),
    estimated: budget.estimated !== false,
    source: String(budget.source || 'heuristic'),
    clues: Array.isArray(budget.clues)
      ? budget.clues.slice(0, 8).map((clue) => ({
        kind: String(clue?.kind || 'other'),
        amount: Number(clue?.amount) || 0,
        currency: String(clue?.currency || ''),
      }))
      : [],
    economy: pickTier(budget.economy),
    comfort: pickTier(budget.comfort),
    luxury: pickTier(budget.luxury),
  };
}

function compactPrepTips(tips) {
  return (Array.isArray(tips) ? tips : [])
    .map((tip) => ({
      text: String(tip?.text || tip || '').trim().slice(0, 200),
      category: String(tip?.category || 'pitfall'),
    }))
    .filter((tip) => tip.text)
    .slice(0, MAX_PREP_TIPS);
}

function compactReservations(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      name: String(item?.name || '').trim(),
      dayTitle: String(item?.dayTitle || '').trim(),
      tips: String(item?.tips || '').trim().slice(0, 300),
    }))
    .filter((item) => item.name)
    .slice(0, MAX_RESERVATIONS);
}

function compactGuideSources(guides) {
  const sources = [];
  const seen = new Set();
  for (const guide of guides || []) {
    const id = String(guide?.id || '').trim();
    const title = String(guide?.title || '').trim().slice(0, 200);
    const url = String(guide?.url || '').trim().slice(0, 500);
    const via = String(guide?.via || '').trim();
    const key = id || url || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = {};
    if (id) row.id = id;
    if (title) row.title = title;
    if (url) row.url = url;
    if (via) row.via = via;
    sources.push(row);
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
}

function buildTripHandoff(job, options = {}) {
  const draft = job?.draft && typeof job.draft === 'object' ? job.draft : {};
  const locale = String(options.locale || job?.payload?.locale || 'zh');
  const withTips = Array.isArray(draft.prepTips) && Array.isArray(draft.reservations)
    ? draft
    : attachPreviewTips({ ...draft });
  const reservations = Array.isArray(draft.reservations)
    ? draft.reservations
    : collectReservations(withTips);
  const warnings = Array.isArray(draft.warnings)
    ? draft.warnings.map((text) => String(text || '').trim().slice(0, 200)).filter(Boolean).slice(0, MAX_WARNINGS)
    : [];
  return {
    version: HANDOFF_VERSION,
    generatedAt: String(options.now || new Date().toISOString()),
    locale,
    destination: String(draft.intent?.destination || '').trim(),
    dayCount: Number(draft.intent?.dayCount) || 0,
    budget: compactBudget(draft.budget),
    prepTips: compactPrepTips(withTips.prepTips),
    reservations: compactReservations(reservations),
    sources: compactGuideSources(draft.guides),
    warnings,
  };
}

module.exports = {
  HANDOFF_KEY,
  HANDOFF_VERSION,
  loadTrekCategoryMap,
  buildTrekPlacePayload,
  buildTripHandoff,
  safeHttpsImageUrl,
};
