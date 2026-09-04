const { extractXhsUrls } = require('./xhs/url');

const TOO_FAR_KM = 40;

const DESTINATION_SEEDS = {
  北京: ['故宫', '天坛', '颐和园', '八达岭长城', '景山公园', '北海公园', '雍和宫', '南锣鼓巷'],
  上海: ['外滩', '豫园', '南京路步行街', '田子坊', '上海博物馆', '武康路'],
  河南: ['龙门石窟', '少林寺', '白马寺', '清明上河园', '开封府', '殷墟', '云台山'],
  洛阳: ['龙门石窟', '白马寺', '应天门', '洛邑古城', '关林'],
  开封: ['清明上河园', '开封府', '大相国寺', '铁塔公园'],
  郑州: ['河南博物院', '二七纪念塔', '嵩山少林寺', '黄河风景名胜区'],
  西安: ['兵马俑', '大雁塔', '西安城墙', '回民街', '大唐不夜城', '钟楼'],
  成都: ['宽窄巷子', '锦里', '成都大熊猫繁育研究基地', '武侯祠', '杜甫草堂'],
  杭州: ['西湖', '灵隐寺', '河坊街', '西溪湿地', '断桥'],
  南京: ['中山陵', '夫子庙', '总统府', '玄武湖', '南京博物院'],
  苏州: ['拙政园', '狮子林', '平江路', '虎丘', '寒山寺'],
  广州: ['陈家祠', '沙面', '北京路步行街', '白云山'],
  深圳: ['世界之窗', '莲花山公园', '大梅沙', '深圳博物馆'],
  重庆: ['洪崖洞', '解放碑', '磁器口', '长江索道', '李子坝'],
  厦门: ['鼓浪屿', '南普陀寺', '曾厝垵', '中山路步行街'],
  青岛: ['栈桥', '八大关', '崂山', '天主教堂'],
  大理: ['大理古城', '洱海', '崇圣寺三塔', '喜洲古镇'],
  丽江: ['丽江古城', '玉龙雪山', '束河古镇', '黑龙潭'],
  桂林: ['漓江', '象鼻山', '两江四湖', '阳朔西街'],
  张家界: ['天门山', '张家界国家森林公园', '张家界大峡谷'],
  三亚: ['亚龙湾', '天涯海角', '南山寺', '蜈支洲岛'],
  漠河: ['北极村', '洛古河', '北红村', '黑龙江第一湾'],
  大兴安岭: ['漠河', '北极村', '洛古河', '白桦林', '九曲十八湾', '呼中国家级自然保护区', '莫尔道嘎国家森林公园', '根河'],
  京都: ['伏见稻荷大社', '清水寺', '岚山', '金阁寺', '祇园'],
  大阪: ['大阪城', '道顿堀', '心斋桥', '通天阁'],
  东京: ['浅草寺', '东京塔', '明治神宫', '涩谷', '上野公园'],
};

const WEAK_PLACE_WORDS = new Set([
  '历史', '文化', '美食', '购物', '自然', '亲子', '小众', '网红', '景点', '旅游', '攻略',
  'citywalk', 'history', 'culture', 'food', 'shopping', 'nature', 'sightseeing', 'travel',
]);

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
  const urls = extractXhsUrls(input.urls, sourceText).slice(0, limits.maxNotes);
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
    searchQueries: guideSearchQueries(destination, interests),
  };
}

function guideSearchQueries(destination, interests) {
  const dest = String(destination || '').trim();
  const interest = (interests || []).map(String).map((item) => item.trim()).filter(Boolean)[0] || '';
  const queries = [];
  if (dest && interest) queries.push(`${dest}${interest}攻略`);
  if (dest) queries.push(`${dest}旅游攻略`);
  if (dest) queries.push(`${dest}必去景点`);
  if (dest && interest) queries.push(`${dest} ${interest} 旅游 景点攻略`);
  return [...new Set(queries.filter(Boolean))];
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

function foldName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s·・,，.。'’"“”]/g, '');
}

function stripAdminTail(name) {
  return String(name || '')
    .trim()
    .replace(/(特别行政区|自治区|省|市|地区|盟|州|县|旗)$/g, '')
    .replace(/\s+(special administrative region|autonomous region|province|prefecture|municipality|county|city)$/i, '')
    .trim();
}

function isGenericPlaceName(name, destination) {
  const raw = String(name || '').trim();
  if (!raw) return true;
  const folded = foldName(raw);
  if (['中国', 'china', '中华人民共和国', 'prc'].includes(folded)) return true;
  if (/(特别行政区|自治区|省|市|地区|盟)$/.test(raw)) return true;
  if (/\b(province|prefecture|municipality|autonomous region|special administrative region|country|republic)\b/i.test(raw)) return true;
  const dest = String(destination || '').trim();
  if (!dest) return false;
  const destFold = foldName(dest);
  const destCore = foldName(stripAdminTail(dest));
  const nameCore = foldName(stripAdminTail(raw));
  return folded === destFold || (Boolean(destCore) && nameCore === destCore);
}

function isWeakPlaceName(name, intent) {
  const raw = String(name || '').trim();
  if (!raw) return true;
  if (isGenericPlaceName(raw, intent?.destination)) return true;
  const folded = foldName(raw);
  if (WEAK_PLACE_WORDS.has(folded)) return true;
  return (intent?.interests || []).some((item) => foldName(item) === folded);
}

function destinationSeeds(destination) {
  const dest = String(destination || '').trim();
  if (!dest) return [];
  const destFold = foldName(stripAdminTail(dest)) || foldName(dest);
  for (const [key, places] of Object.entries(DESTINATION_SEEDS)) {
    const keyFold = foldName(stripAdminTail(key));
    if (!destFold || !keyFold) continue;
    if (destFold === keyFold) return places.slice();
    if (destFold.length >= 2 && keyFold.length >= 2
      && (destFold.startsWith(keyFold) || keyFold.startsWith(destFold) || destFold.includes(keyFold))) {
      return places.slice();
    }
  }
  return [];
}

function targetPlaceCount(intent) {
  const perDay = intent.pace === 'relaxed' ? 2 : intent.pace === 'packed' ? 4 : 3;
  return Math.min(Math.max(intent.dayCount, 1) * perDay, 12);
}

function extractionText(guides, intent) {
  const target = targetPlaceCount(intent);
  const header = [
    `Destination: ${intent.destination || '(unknown)'}`,
    `Days: ${intent.dayCount}`,
    `Pace: ${intent.pace}`,
    `Interests: ${intent.interests.join(', ') || 'sightseeing'}`,
    intent.mustSee.length ? `Must see: ${intent.mustSee.join(', ')}` : '',
    `Propose about ${target} specific visitable places (attractions, museums, temples, parks, historic sites, neighborhoods, food streets).`,
    'Do not list the destination itself, a province, city, country, or administrative region as a place.',
    `Spread places across days with dayHint from 1 to ${intent.dayCount}.`,
  ].filter(Boolean).join('\n');
  const guideText = guides
    .map((guide) => `[${guide.id}] ${guide.title || ''}\n${String(guide.text || '').slice(0, 4000)}`)
    .join('\n\n')
    .slice(0, 12000);
  if (guideText) {
    return `${header}\n\nExtract named places from these notes first; if they are thin, supplement with well-known places in the destination.\n\n${guideText}`;
  }
  return `${header}\n\nNo travel notes were supplied. Propose well-known visitable places in the destination that match the interests.`;
}

function extractionInstruction(intent, hasGuides) {
  const target = targetPlaceCount(intent);
  const dest = intent.destination || 'the destination';
  if (hasGuides) {
    return `Extract specific visitable places from the notes. Prefer attractions, museums, temples, parks, neighborhoods, and food streets in ${dest}. Do not return the destination, a province, city, or country as a place. Use dayHint 1..${intent.dayCount}. Target about ${target} places. Do not invent coordinates.`;
  }
  return `No notes were supplied. Propose well-known visitable places in ${dest}. Each name must be a specific attraction or neighborhood, not the destination, province, city, or country. Spread across ${intent.dayCount} days with dayHint. Target ${target} places. Do not invent coordinates.`;
}

function toCandidate(item, intent, fallbackName) {
  const name = String(fallbackName || item?.name || '').trim();
  return {
    name,
    nameZh: String(item?.nameZh || '').trim() || name,
    nameEn: String(item?.nameEn || '').trim(),
    reason: String(item?.reason || '').trim(),
    durationMinutes: clampInt(item?.durationMinutes, 90, 15, 720),
    reservationRequired: item?.reservationRequired === true,
    reservationTips: String(item?.reservationTips || '').trim(),
    dayHint: clampInt(item?.dayHint, 1, 1, intent.dayCount),
    guideId: String(item?.guideId || '').trim(),
  };
}

function spreadDayHints(candidates, dayCount) {
  const days = Math.max(1, dayCount || 1);
  if (candidates.length <= 1) return candidates;
  const sameHint = candidates.every((item) => item.dayHint === candidates[0].dayHint);
  if (!sameHint) return candidates;
  return candidates.map((item, index) => ({ ...item, dayHint: (index % days) + 1 }));
}

function normalizeCandidates(raw, intent) {
  const model = Array.isArray(raw?.candidates) ? raw.candidates : [];
  const seen = new Set();
  const unique = [];
  const pushUnique = (item) => {
    if (!item?.name || isWeakPlaceName(item.name, intent)) return;
    const key = foldName(item.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  };
  for (const item of model) pushUnique(toCandidate(item, intent));
  const target = targetPlaceCount(intent);
  if (unique.length < target) {
    for (const name of [...intent.mustSee, ...destinationSeeds(intent.destination)]) {
      pushUnique(toCandidate({}, intent, name));
      if (unique.length >= target) break;
    }
  }
  return spreadDayHints(unique, intent.dayCount);
}

function placeSearchQuery(candidate, destination) {
  const name = String(candidate?.nameZh || candidate?.name || '').trim();
  const dest = String(destination || '').trim();
  if (!name) return dest;
  if (!dest) return name;
  if (foldName(name).includes(foldName(dest)) || foldName(dest).includes(foldName(name))) return name;
  return `${name} ${dest}`;
}

function finiteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAdministrativePlace(place) {
  const types = (place?.types || []).map((item) => String(item).toLowerCase());
  return types.some((type) => [
    'boundary', 'administrative', 'province', 'state', 'country',
    'region', 'municipality', 'county', 'city', 'town',
  ].includes(type));
}

function evidenceFromSearch(candidate, result, index, destination) {
  const places = (result?.places || []).filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
  const specific = places.find((item) => !isGenericPlaceName(item.name, destination) && !isAdministrativePlace(item));
  const named = places.find((item) => !isGenericPlaceName(item.name, destination));
  const place = specific || named || null;
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

function markDistance(days) {
  for (const day of days) {
    day.places.forEach((place, index) => {
      const previous = day.places[index - 1];
      const tooFar = previous ? haversineKm(previous, place) > TOO_FAR_KM : false;
      place.tooFar = tooFar;
      place.selected = !tooFar;
    });
  }
}

function rebalanceDays(days) {
  for (;;) {
    const empty = days.find((day) => day.places.length === 0);
    const richest = days.reduce((best, day) => (day.places.length > best.places.length ? day : best), days[0]);
    if (!empty || !richest || richest.places.length <= 1) break;
    empty.places.push(richest.places.pop());
  }
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
      tooFar: false,
      selected: true,
    });
  }
  rebalanceDays(days);
  markDistance(days);
  if (unique.length > intent.dayCount * perDay) {
    warnings.push(message(locale, '地点超过行程容量，已截断', 'Places exceeded itinerary capacity and were truncated'));
  }
  return { days, warnings };
}

function publicDraft(job) {
  const draft = job.draft || {};
  const intent = draft.intent || {};
  const guides = draft.guides || [];
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    intent: intent || null,
    guides: guides.map(({ text, ...guide }) => guide),
    sourceSummary: {
      basis: guides.length ? 'guides' : 'destination',
      query: intent.guideQuery || '',
      destination: intent.destination || '',
      searchQuery: job.work?.lastSearchQuery || intent.searchQueries?.[0] || intent.guideQuery || '',
      noteCount: guides.filter((guide) => guide.via === 'search' || guide.via === 'url').length,
    },
    progress: {
      guidesRead: guides.length,
      guidesTotal: guides.length
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
  DESTINATION_SEEDS,
  settings,
  isZh,
  message,
  normalizeInput,
  extractionText,
  extractionInstruction,
  normalizeCandidates,
  isGenericPlaceName,
  isWeakPlaceName,
  destinationSeeds,
  targetPlaceCount,
  placeSearchQuery,
  guideSearchQueries,
  evidenceFromSearch,
  gateAndSchedule,
  publicDraft,
  haversineKm,
};
