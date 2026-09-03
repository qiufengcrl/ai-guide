const TOO_FAR_KM = 40;

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

function settings(config) {
  return {
    maxDays: clampInt(config.max_days, 8, 1, 14),
    maxPlacesPerDay: clampInt(config.max_places_per_day, 6, 1, 12),
    maxNotes: clampInt(config.max_notes, 4, 1, 8),
    xhsEnabled: config.xhs_enabled !== false && String(config.xhs_enabled ?? 'true') !== 'false',
  };
}

function isZh(locale) {
  return String(locale || '').toLowerCase().startsWith('zh');
}

function message(locale, zh, en) {
  return isZh(locale) ? zh : en;
}

function normalizeInput(body, limits) {
  const input = body && typeof body === 'object' ? body : {};
  const interests = Array.isArray(input.interests)
    ? input.interests.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 12)
    : String(input.interests || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
  const mustSee = Array.isArray(input.mustSee)
    ? input.mustSee.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 12)
    : [];
  const destination = String(input.destination || '').trim();
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || '')) ? String(input.startDate) : null;
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.endDate || '')) ? String(input.endDate) : null;
  const requestedDays = clampInt(input.dayCount, 5, 1, limits.maxDays);
  const datedDays = startDate && endDate
    ? Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1
    : requestedDays;
  const dayCount = Math.min(limits.maxDays, Math.max(1, datedDays));
  const pace = ['relaxed', 'balanced', 'packed'].includes(input.pace) ? input.pace : 'balanced';
  const sourceText = String(input.sourceText || '').trim().slice(0, 12000);
  const urls = String(input.urls || '').split(/\s+/).filter(Boolean).slice(0, limits.maxNotes);
  return {
    destination,
    startDate,
    endDate,
    dayCount,
    pace,
    interests,
    mustSee,
    avoid: Array.isArray(input.avoid) ? input.avoid.map(String).slice(0, 12) : [],
    sourceText: sourceText || null,
    urls,
    guideQuery: `${destination} ${interests.length ? interests.join(' ') : '景点'} 旅游 景点攻略`.trim(),
  };
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'object' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          nameZh: { type: 'string' },
          nameEn: { type: 'string' },
          reason: { type: 'string' },
          durationMinutes: { type: 'number' },
          reservationRequired: { type: 'boolean' },
          reservationTips: { type: 'string' },
          dayHint: { type: 'number' },
          guideId: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  required: ['candidates'],
};

function extractionText(guides, intent) {
  const guideText = guides
    .map((guide) => `[${guide.id}] ${guide.title || ''}\n${String(guide.text || '').slice(0, 4000)}`)
    .join('\n\n')
    .slice(0, 12000);
  return guideText || `Destination: ${intent.destination}; interests: ${intent.interests.join(', ') || 'sightseeing'}`;
}

function normalizeCandidates(raw, intent) {
  const model = Array.isArray(raw?.candidates) ? raw.candidates : [];
  const candidates = model.map((item) => ({
    name: String(item?.name || '').trim(),
    nameZh: String(item?.nameZh || '').trim(),
    nameEn: String(item?.nameEn || '').trim(),
    reason: String(item?.reason || '').trim(),
    durationMinutes: clampInt(item?.durationMinutes, 90, 15, 720),
    reservationRequired: item?.reservationRequired === true,
    reservationTips: String(item?.reservationTips || '').trim(),
    dayHint: clampInt(item?.dayHint, 1, 1, intent.dayCount),
    guideId: String(item?.guideId || '').trim(),
  })).filter((item) => item.name);
  if (model.length) return candidates;
  const fallbackNames = [...intent.mustSee, ...intent.interests];
  if (!fallbackNames.length && intent.destination) fallbackNames.push(intent.destination);
  return fallbackNames
    .filter(Boolean)
    .map((name, index) => ({
      name,
      nameZh: name,
      nameEn: '',
      reason: '',
      durationMinutes: 90,
      reservationRequired: false,
      reservationTips: '',
      dayHint: (index % intent.dayCount) + 1,
      guideId: '',
    }));
}

function finiteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function evidenceFromSearch(candidate, result, index) {
  const place = (result?.places || []).find((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
  if (!place) return null;
  return {
    id: `ev_${index + 1}`,
    name: String(place.name || candidate.name),
    lat: place.lat,
    lng: place.lng,
    address: String(place.address || ''),
    placeId: place.google_place_id || place.placeId || null,
    osmId: place.osm_id || place.osmId || null,
    provider: String(result.source || place.source || 'maps'),
    categoryHint: Array.isArray(place.types) && place.types.includes('restaurant') ? 'food' : 'sight',
    source: 'poi_search',
    fromGuideIds: candidate.guideId ? [candidate.guideId] : [],
    stayHintMinutes: candidate.durationMinutes,
    reservationHint: candidate.reservationTips || (candidate.reservationRequired ? 'Reservation may be required' : ''),
    reason: candidate.reason,
    dayHint: candidate.dayHint,
  };
}

function haversineKm(a, b) {
  const rad = (n) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const q = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function isoDate(startDate, offset) {
  if (!startDate) return null;
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function gateAndSchedule(intent, evidence, limits, locale, copy) {
  const warnings = [];
  const unique = [];
  const seen = new Set();
  for (const item of evidence) {
    if (!finiteCoordinate(item.lat) || !finiteCoordinate(item.lng)) {
      warnings.push(message(locale, `「${item.name}」没有坐标，已跳过`, `"${item.name}" had no coordinates and was skipped`));
      continue;
    }
    const key = `${item.name.toLowerCase()}|${item.lat.toFixed(5)}|${item.lng.toFixed(5)}`;
    if (seen.has(key)) {
      warnings.push(message(locale, `「${item.name}」重复，已跳过`, `"${item.name}" was duplicated and skipped`));
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  const perDay = intent.pace === 'relaxed' ? Math.min(3, limits.maxPlacesPerDay) : limits.maxPlacesPerDay;
  const days = Array.from({ length: intent.dayCount }, (_, index) => ({
    date: isoDate(intent.startDate, index),
    title: message(locale, `第 ${index + 1} 天`, `Day ${index + 1}`),
    notes: copy || '',
    selected: true,
    places: [],
  }));
  for (const item of unique.slice(0, intent.dayCount * perDay)) {
    let dayIndex = Math.max(0, Math.min(days.length - 1, Number(item.dayHint || 1) - 1));
    if (days[dayIndex].places.length >= perDay) {
      dayIndex = days.findIndex((day) => day.places.length < perDay);
      if (dayIndex < 0) break;
    }
    const previous = days[dayIndex].places.at(-1);
    const tooFar = previous ? haversineKm(previous, item) > TOO_FAR_KM : false;
    days[dayIndex].places.push({
      evidenceId: item.id,
      name: item.name,
      lat: item.lat,
      lng: item.lng,
      address: item.address,
      placeId: item.placeId,
      osmId: item.osmId,
      categoryHint: item.categoryHint,
      stayMinutes: item.stayHintMinutes,
      notes: item.reason || item.reservationHint || '',
      tooFar,
      selected: !tooFar,
    });
  }
  if (unique.length > intent.dayCount * perDay) {
    warnings.push(message(locale, '地点超过行程容量，已截断', 'Places exceeded itinerary capacity and were truncated'));
  }
  return { days, warnings };
}

function publicDraft(job) {
  const draft = job.draft || {};
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    intent: draft.intent || null,
    guides: (draft.guides || []).map(({ text, ...guide }) => guide),
    progress: {
      guidesRead: (draft.guides || []).length,
      guidesTotal: (draft.guides || []).length
        + Math.max(0, (job.work?.urls?.length || 0) - (job.work?.urlIndex || 0))
        + Math.max(0, (job.work?.pendingNotes?.length || 0) - (job.work?.noteIndex || 0)),
    },
    warnings: draft.warnings || [],
    days: draft.days || [],
    ...(job.error ? { error: job.error } : {}),
  };
}

module.exports = {
  TOO_FAR_KM,
  EXTRACTION_SCHEMA,
  settings,
  isZh,
  message,
  normalizeInput,
  extractionText,
  normalizeCandidates,
  evidenceFromSearch,
  gateAndSchedule,
  publicDraft,
  haversineKm,
};
