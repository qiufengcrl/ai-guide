const { splitGuidePaste } = require('./xhs/url');
const { scoreRow: geoScoreRow } = require('./geo/nominatim');
const { isMarketingCandidate, filterMarketingGuides, scoreGuide } = require('./guide-quality');

const TOO_FAR_KM = 40;
const MAX_FROM_DESTINATION_KM = 150;
const REGION_RADIUS_KM = 400;
const ABSOLUTE_MAX_FROM_DESTINATION_KM = 500;
const REGION_CLUSTER_KM = 80;
const REGION_SPLIT_MIN_SPAN_KM = 80;

const GUIDE_RESERVATION_HINT = /预约|抢票|提前预约|约满|需预约|需提前/;
const GUIDE_SECTION_SKIP = /^(🍜|💡|#|美食推荐|避坑|小贴士)/;
const GUIDE_ROUTE_SKIP = /^(廊桥|登岛|欣赏|观看|拍照|散步|环岛(?!步道)|灯光|喷泉|夜景灯光)/;
const GUIDE_NAME_SUFFIX = /(登顶|数字展馆.*|与夜景.*|灯光.*|\/喷泉)$/u;
const DAY_HEADER_RE = /^(?:📅\s*|【)?(?:第\s*([0-9一二三四五六七八九十两]+)\s*天|Day\s*([0-9]{1,2})|D([0-9]{1,2}))(?:\s*[】:：\-—·]|$)/i;
const GUIDE_COMPARE_RE = /并称|相比|不同于|不是去|不要去|不如|不像|对比/;
const CN_DAY_TOKEN = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function stripInvisible(text) {
  return String(text || '')
    .replace(/[\u200b-\u200d\ufeff\uFE0F\u00a0]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanGuidePlaceName(raw) {
  let name = stripInvisible(raw)
    .replace(/^[▪️•·\-–—\d①②③④⑤⑥⑦⑧⑨⑩1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟📍🗺️]+\s*/u, '')
    .replace(/[:：].*$/, '')
    .replace(/[（(].*[）)]/g, '')
    .replace(GUIDE_NAME_SUFFIX, '')
    .trim();
  if (name.endsWith('与夜景')) name = name.replace(/与夜景$/, '').trim();
  return name;
}

function guidePlaceNamesFromSegment(segment, intent) {
  const cleaned = cleanGuidePlaceName(segment);
  if (!cleaned || cleaned.length < 2 || cleaned.length > 24) return [];
  if (GUIDE_ROUTE_SKIP.test(cleaned)) return [];
  if (isWeakPlaceName(cleaned, intent)) return [];
  return cleaned.split(/[/／、|｜]/).map(cleanGuidePlaceName).filter((item) => item.length >= 2);
}

function reservationHintsFromLine(line) {
  const text = String(line || '').trim();
  if (!text || !GUIDE_RESERVATION_HINT.test(text)) {
    return { reservationRequired: false, reservationTips: '' };
  }
  const match = text.match(/(?:需?提前预约|预约[^，。；\n]{0,24}|抢票[^，。；\n]{0,24}|约满[^，。；\n]{0,16})/);
  return {
    reservationRequired: true,
    reservationTips: String(match?.[0] || '可能需要预约').trim(),
  };
}

function parseDayToken(raw) {
  const text = String(raw || '').trim();
  if (CN_DAY_TOKEN[text] != null) return CN_DAY_TOKEN[text];
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 14 ? n : 0;
}

function matchDayHeader(line) {
  const trimmed = stripInvisible(line);
  const match = trimmed.match(DAY_HEADER_RE);
  if (!match) return null;
  const day = parseDayToken(match[1] || match[2] || match[3]);
  if (!day) return null;
  const rest = stripInvisible(trimmed.slice(match[0].length).replace(/^[】:：\-—·\s]+/, ''));
  return { day, rest };
}

function inferDayCountFromGuides(guides) {
  let fromHeaders = 0;
  let fromTitle = 0;
  for (const guide of guides || []) {
    const title = stripInvisible(guide?.title || '');
    const titleDay = title.match(/(\d+)\s*天(?:\d+\s*[晚夜])?/);
    if (titleDay) {
      const n = Number(titleDay[1]);
      if (n >= 1 && n <= 14) fromTitle = Math.max(fromTitle, n);
    }
    if (/两天(?:一夜|一晚)?/.test(title)) fromTitle = Math.max(fromTitle, 2);
    for (const line of String(guide?.text || '').split(/\n/)) {
      const header = matchDayHeader(line);
      if (header) fromHeaders = Math.max(fromHeaders, header.day);
    }
  }
  const inferred = Math.max(fromHeaders, fromTitle);
  return inferred >= 1 && inferred <= 14 ? inferred : 0;
}

function applyGuideDerivedIntent(intent, guides, limits) {
  if (!intent || typeof intent !== 'object') return intent;
  const inferred = inferDayCountFromGuides(guides);
  const maxDays = Math.max(1, Number(limits?.maxDays) || 14);
  if (inferred >= 1) {
    intent.dayCount = Math.min(maxDays, inferred);
    intent.dayCountSource = 'guide';
  }
  return intent;
}

function guideCorpus(guides) {
  return (guides || []).map((guide) => `${guide?.title || ''}\n${guide?.text || ''}`).join('\n\n');
}

function nameAppearsInText(name, text) {
  const raw = String(name || '').trim();
  if (raw.length < 2) return false;
  if (String(text || '').includes(raw)) return true;
  const foldedName = foldName(raw);
  const foldedText = foldName(text);
  return Boolean(foldedName) && foldedText.includes(foldedName);
}

function isComparisonOnlyMention(name, text) {
  const lines = String(text || '').split(/\n/).map((line) => stripInvisible(line)).filter(Boolean);
  let mentioned = 0;
  let comparison = 0;
  for (const line of lines) {
    if (!nameAppearsInText(name, line)) continue;
    mentioned += 1;
    if (GUIDE_COMPARE_RE.test(line)) comparison += 1;
  }
  return mentioned > 0 && comparison === mentioned;
}

function namesOverlap(left, right) {
  const a = foldName(left);
  const b = foldName(right);
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

function filterInventedCandidates(candidates, guides) {
  const corpus = guideCorpus(guides);
  if (!stripInvisible(corpus)) return candidates;
  return (candidates || []).filter((item) => {
    const name = String(item?.nameZh || item?.name || '').trim();
    if (!nameAppearsInText(name, corpus) && !nameAppearsInText(item?.name, corpus)) return false;
    if (isComparisonOnlyMention(name, corpus)) return false;
    return true;
  });
}

function mergeExtractedCandidates(fromGuide, fromLlm) {
  const seen = new Set();
  const merged = [];
  const push = (item) => {
    const key = foldName(item?.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };
  for (const item of fromGuide || []) push(item);
  for (const item of fromLlm || []) push(item);
  return merged;
}

function candidatesFromGuideText(guides, intent) {
  const cap = Math.max(targetPlaceCount(intent), 16);
  const seen = new Set();
  const results = [];
  const push = (rawName, guideId, reason, lineContext, dayHint) => {
    const reservation = reservationHintsFromLine(lineContext || reason);
    for (const name of guidePlaceNamesFromSegment(rawName, intent)) {
      if (isWeakPlaceName(name, intent) || isGenericPlaceName(name, intent.destination)) continue;
      const key = foldName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(toCandidate({
        name,
        nameZh: name,
        reason: String(reason || '').trim().slice(0, 240),
        guideId,
        dayHint: dayHint || 1,
        reservationRequired: reservation.reservationRequired,
        reservationTips: reservation.reservationTips,
      }, intent));
      if (results.length >= cap) return true;
    }
    return false;
  };

  for (const guide of guides || []) {
    const text = String(guide.text || '');
    if (!text.trim()) continue;
    const guideId = String(guide.id || '').trim();
    let inFoodSection = false;
    let currentDay = 1;
    const lines = text.split(/\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const trimmed = stripInvisible(lines[lineIndex]);
      if (!trimmed) continue;
      const header = matchDayHeader(trimmed);
      if (header) {
        currentDay = header.day;
        if (header.rest && push(header.rest, guideId, trimmed, trimmed, currentDay)) return results;
        continue;
      }
      if (/^🍜|^美食推荐/.test(trimmed)) {
        inFoodSection = true;
        continue;
      }
      if (GUIDE_SECTION_SKIP.test(trimmed)) {
        inFoodSection = false;
        continue;
      }
      if (inFoodSection || /^#/.test(trimmed)) continue;

      const nextLine = stripInvisible(lines[lineIndex + 1] || '');
      const lineContext = [trimmed, nextLine].filter(Boolean).join('\n');

      const bullet = trimmed.match(/^[▪️•·]\s*(.+)$/);
      if (bullet && push(bullet[1], guideId, trimmed, lineContext, currentDay)) return results;

      const numbered = trimmed.match(/^(?:\d+[.\u3001、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(.+)$/);
      if (numbered && push(numbered[1], guideId, trimmed, lineContext, currentDay)) return results;

      if (/推荐路线|路线[:：]|→/.test(trimmed)) {
        const routePart = trimmed.replace(/^.*?(?:推荐路线|路线)[:：]?\s*/u, '');
        for (const segment of routePart.split(/\s*(?:→|->|➡|—>)\s*/)) {
          if (push(segment, guideId, trimmed, lineContext, currentDay)) return results;
        }
        continue;
      }

      const quoted = trimmed.match(/[“"]([^”"]{2,24})[”"]/);
      if (quoted && /(停车场|站|导航)/.test(trimmed) && push(quoted[1], guideId, trimmed, lineContext, currentDay)) return results;

      const nearby = trimmed.match(/去(?:旁边|附近)的?\s*(.{2,16})/);
      if (nearby && push(nearby[1], guideId, trimmed, lineContext, currentDay)) return results;
    }

    const title = stripInvisible(guide.title || '');
    const titleMatch = title.match(/[｜|]\s*([^｜|]+?)(?:\s*游玩攻略|\s*攻略)?\s*📝?\s*$/u)
      || title.match(/📍\s*[^｜|]+[｜|]\s*([^｜|]+?)(?:\s*游玩攻略|\s*攻略)?/u);
    if (titleMatch && push(titleMatch[1], guideId, title, title, 1)) return results;
  }

  return results;
}

function resolveExtractCandidates(extracted, guides, intent) {
  const llmCandidateCount = Array.isArray(extracted?.candidates) ? extracted.candidates.length : 0;
  const hasGuideText = (guides || []).some((guide) => String(guide.text || '').trim());
  const llmRaw = normalizeCandidates(extracted, { ...intent, mustSee: hasGuideText ? [] : intent.mustSee });
  const llm = hasGuideText ? filterInventedCandidates(llmRaw, guides) : llmRaw;
  const fromGuide = hasGuideText ? candidatesFromGuideText(guides, intent) : [];
  let merged = [];
  let source = null;
  if (hasGuideText) {
    merged = mergeExtractedCandidates(fromGuide, llm);
    if (fromGuide.length && llm.length) source = 'llm+guide_text';
    else if (fromGuide.length) source = 'guide_text';
    else if (llm.length) source = 'llm';
  } else if (llm.length) {
    merged = llm;
    source = 'llm';
  }
  const candidates = normalizeCandidates({ candidates: merged }, intent);
  if (candidates.length) {
    return { candidates, source, llmCandidateCount };
  }
  return { candidates: [], source: null, llmCandidateCount };
}

function guideTextForExtractRetry(guides) {
  return (guides || [])
    .map((guide) => {
      const title = String(guide.title || '').trim();
      const text = String(guide.text || '').trim();
      if (title && text) return `${title}\n${text}`;
      return text || title;
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 12000);
}

function extractRetryInstruction(locale, dayCount) {
  return message(locale,
    `仅列出正文中字面出现的具体景点、寺庙、街区、公园名称；不要返回城市或省份。每项一条 candidate，带 name 与 dayHint（1..${dayCount}）。`,
    `List only concrete place names that appear verbatim in the text; do not return cities or provinces. One candidate per place with name and dayHint (1..${dayCount}).`);
}

const PLACE_SEARCH_ALIASES = {
  北极村: '北极镇 漠河',
  洛古河: '洛古河村',
  白桦林: '白桦林观景台',
  黑龙江第一湾: '龙江第一湾风景区',
  呼中国家级自然保护区: '呼中区',
  东洲岛: '衡阳东洲岛',
  船山书院: '衡阳东洲岛 船山书院',
  夫之楼: '衡阳东洲岛 夫之楼',
  罗汉寺: '衡阳东洲岛 罗汉寺',
};

function inferDestinationFromGuides(guides) {
  for (const guide of guides || []) {
    const title = stripInvisible(guide?.title || '');
    if (!title) continue;
    const pipe = title.match(/📍\s*([^｜|]+?)[｜|]/);
    if (pipe) {
      const dest = stripAdminTail(pipe[1].trim());
      if (dest.length >= 2) return dest;
    }
    const suffix = title.match(/^(.{2,12}?)(?:\s*[｜|]|\s+游玩攻略|\s+攻略)/u);
    if (suffix) {
      const dest = stripAdminTail(suffix[1].trim());
      if (dest.length >= 2 && !/(攻略|游记|笔记)/.test(dest)) return dest;
    }
  }
  return '';
}

function mergeGuideTexts(guides) {
  const seen = new Set();
  const merged = [];
  for (const guide of guides || []) {
    const noteId = String(guide?.noteId || '').trim();
    const url = String(guide?.url || '').trim();
    const key = noteId
      || (url ? `url:${url}` : '')
      || foldName(`${guide?.title || ''}|${String(guide?.text || '').slice(0, 200)}`);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(guide);
  }
  return merged;
}
function looksLikeShareCard(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 500) return false;
  return /xhslink\.(cn|com)|xiaohongshu\.com\/|进入【小红书】/.test(raw);
}

function noteDisplayTitle(note, fallback) {
  const title = String(note?.title || '').trim();
  if (title) return title;
  const line = String(note?.text || '')
    .split(/\n/)[0]
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length >= 4) return line.slice(0, 40);
  return String(fallback || '').trim();
}

const WEAK_PLACE_WORDS = new Set([
  '历史', '文化', '美食', '购物', '自然', '亲子', '小众', '网红', '景点', '旅游', '攻略',
  'citywalk', 'history', 'culture', 'food', 'shopping', 'nature', 'sightseeing', 'travel',
]);

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

function truthySetting(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function settings(config) {
  return {
    maxDays: clampInt(config.max_days, 8, 1, 14),
    maxPlacesPerDay: clampInt(config.max_places_per_day, 6, 1, 12),
    maxNotes: clampInt(config.max_notes, 4, 1, 8),
    xhsEnabled: truthySetting(config.xhs_enabled),
    placesApiBase: String(config.places_api_base || '').trim(),
    placesApiKey: String(config.places_api_key || '').trim(),
  };
}

function resolveXhsKeywordSearch(bodyValue) {
  if (bodyValue !== undefined && bodyValue !== null && bodyValue !== '') {
    return truthySetting(bodyValue);
  }
  return false;
}

function geoSearchOptions(config, extra = {}) {
  const limits = settings(config);
  return {
    ...extra,
    placesApiBase: limits.placesApiBase,
    placesApiKey: limits.placesApiKey,
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
  const split = splitGuidePaste(input.urls, input.sourceText);
  const urls = split.urls.slice(0, limits.maxNotes);
  const sourceText = split.sourceText || '';
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
    xhsKeywordSearch: body.xhsKeywordSearch,
  };
}

function guideSearchQueries(destination, interests) {
  const dest = String(destination || '').trim();
  const tags = (interests || []).map(String).map((item) => item.trim()).filter(Boolean);
  const primary = tags[0] || '';
  const queries = [];
  if (dest && primary) queries.push(`${dest}${primary}攻略`);
  if (dest) queries.push(`${dest}旅游攻略`);
  if (dest) queries.push(`${dest}必去景点`);
  if (dest) queries.push(`${dest}避坑`);
  if (dest) queries.push(`${dest}美食`);
  if (dest) queries.push(`${dest}拍照机位`);
  if (dest) queries.push(`${dest}费用`);
  if (dest && primary) queries.push(`${dest} ${primary} 旅游 景点攻略`);
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
    budget: {
      type: 'object',
      properties: {
        currency: { type: 'string' },
        economy: { type: 'object' },
        comfort: { type: 'object' },
        luxury: { type: 'object' },
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
  if (/(特别行政区|自治区|省)$/.test(raw)) return true;
  if (/\b(province|country|republic|autonomous region|special administrative region)\b/i.test(raw)) return true;
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

function normalizeCandidates(raw, intent) {
  const model = Array.isArray(raw?.candidates) ? raw.candidates : [];
  const seen = new Set();
  const unique = [];
  const pushUnique = (item) => {
    if (!item?.name || isWeakPlaceName(item.name, intent)) return;
    if (isMarketingCandidate(item)) return;
    const key = foldName(item.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  };
  for (const item of model) pushUnique(toCandidate(item, intent));
  const target = targetPlaceCount(intent);
  if (unique.length < target) {
    for (const name of intent.mustSee || []) {
      pushUnique(toCandidate({}, intent, name));
      if (unique.length >= target) break;
    }
  }
  return spreadDayHints(unique, intent.dayCount);
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
    'For each place include nameZh (Simplified Chinese official name), nameEn (English official name when known), reason (real user tips or pitfalls from the notes), durationMinutes, reservationRequired, and reservationTips when notes mention 预约/抢票/提前预约.',
    `Spread places across days with dayHint from 1 to ${intent.dayCount}. If the notes have 第N天 / Day N headings, follow those headings.`,
    'If notes mention prices (人均/门票/住宿/交通), also fill budget with currency and economy/comfort/luxury objects, each with numeric transport, lodging, tickets, food for the whole trip. Do not invent live market quotes.',
  ].filter(Boolean).join('\n');
  const commentTips = (guides || [])
    .flatMap((guide) => (guide.commentInsights || []).map((tip) => `- ${tip}`))
    .slice(0, 20);
  const commentBlock = commentTips.length ? `\nComment tips:\n${commentTips.join('\n')}` : '';
  const guideText = guides
    .slice()
    .sort((left, right) => scoreGuide(right).score - scoreGuide(left).score)
    .map((guide) => `[${guide.id}] ${guide.title || ''}\n${String(guide.text || '').slice(0, 4000)}`)
    .join('\n\n')
    .slice(0, 12000);
  if (guideText) {
    return `${header}\n\nExtract named visitable places that appear in these notes. One candidate per place. reason must be tips for that place only — do not list other places inside reason. Do not invent places, do not add well-known sights that are absent from the notes, and skip names that appear only as comparisons (并称/相比). Preserve booking tips and user warnings.${commentBlock}\n\n${guideText}`;
  }
  return `${header}\n\nNo travel notes were supplied. Propose well-known visitable places in the destination that match the interests.`;
}

function extractionInstruction(intent, hasGuides) {
  const target = targetPlaceCount(intent);
  const dest = intent.destination || 'the destination';
  const fields = 'Each candidate must include name, nameZh, nameEn, reason, durationMinutes, reservationRequired, reservationTips, dayHint, and guideId when sourced from a note. Use reservationRequired=true when notes mention 预约, 抢票, 提前预约, or 约满.';
  if (hasGuides) {
    return `Extract specific visitable places that appear verbatim in the notes. ${fields} Prefer first-person visit notes over sponsored or group-tour pitches. Prefer attractions, museums, temples, parks, neighborhoods, and food streets in ${dest}. Keep real user tips in reason for that one place only. When notes mention prices, also fill budget with currency and three tiers (economy, comfort, luxury), each with numeric transport, lodging, tickets, food for the whole trip. Do not invent live quotes. Do not invent places that are not in the notes. Do not return the destination, a province, city, or country as a place. Use dayHint 1..${intent.dayCount}, matching 第N天/Day N headings when present. Target about ${target} places, or every named place in the notes if fewer. Do not invent coordinates.`;
  }
  return `No notes were supplied. Propose well-known visitable places in ${dest}. ${fields} Each name must be a specific attraction or neighborhood, not the destination, province, city, or country. Spread across ${intent.dayCount} days with dayHint. Target ${target} places. Do not invent coordinates.`;
}

function collectXhsNoteIds(guides, pendingNotes) {
  const ids = new Set();
  for (const guide of guides || []) {
    if (guide?.noteId) ids.add(String(guide.noteId));
  }
  for (const item of pendingNotes || []) {
    if (item?.noteId) ids.add(String(item.noteId));
  }
  return ids;
}

function remainingXhsNoteSlots(guides, pendingNotes, maxNotes) {
  return Math.max(0, maxNotes - collectXhsNoteIds(guides, pendingNotes).size);
}

async function mapConcurrent(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let nextIndex = 0;
  async function runWorker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }
  const workers = Math.min(Math.max(1, limit || 1), list.length);
  await Promise.all(Array.from({ length: workers }, runWorker));
  return results;
}

async function resolveCandidateEvidence(candidate, index, intent, searchPlacesFn, options, bias) {
  const destination = intent.destination;
  const queries = placeSearchNames(candidate, destination);
  let lastError = null;
  let boundaryRejected = false;
  for (const query of queries) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await searchPlacesFn(query, options);
        const places = (result?.places || []).filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
        const nearby = places.filter((item) => nearDestination(item, destination, bias));
        if (places.length && !nearby.length) boundaryRejected = true;
        const nearbyEvidence = result
          ? evidenceFromSearch(candidate, result, index, destination, bias)
          : null;
        if (nearbyEvidence) return { evidence: nearbyEvidence, query, boundaryRejected: false };
        const farEvidence = result
          ? evidenceFromSearch(candidate, result, index, destination, bias, { allowFar: true })
          : null;
        if (farEvidence) return { evidence: farEvidence, query, boundaryRejected: true };
        if (places.length && !nearby.length) boundaryRejected = true;
        break;
      } catch (error) {
        lastError = error;
        const text = String(error?.message || error || '');
        if (/429|461|cuqps|限流|频繁|too many requests|rate limit/i.test(text) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 600 * (2 ** attempt)));
          continue;
        }
        break;
      }
    }
  }
  return {
    evidence: null,
    query: queries[queries.length - 1] || String(candidate.name || ''),
    error: lastError,
    boundaryRejected,
  };
}

function progressForJob(job, locale) {
  const work = job.work || {};
  const stage = String(job.stage || '');
  const intent = job.draft?.intent || {};
  const destination = String(intent.destination || '').trim();

  if (stage === 'fetch_guides') {
    const urlTotal = work.urls?.length || 0;
    if (work.urlIndex < urlTotal) {
      return message(locale,
        `正在读取链接 ${work.urlIndex + 1}/${urlTotal}`,
        `Reading link ${work.urlIndex + 1}/${urlTotal}`);
    }
    if (!work.searchAttempted) {
      return message(locale, '正在搜索小红书攻略…', 'Searching Xiaohongshu guides…');
    }
    const pendingTotal = work.pendingNotes?.length || 0;
    if (work.noteIndex < pendingTotal) {
      return message(locale,
        `正在读取攻略 ${work.noteIndex + 1}/${pendingTotal}`,
        `Reading guide ${work.noteIndex + 1}/${pendingTotal}`);
    }
    return message(locale, '正在整理攻略来源…', 'Organizing guide sources…');
  }
  if (stage === 'extract') {
    return message(locale, '正在从攻略提取景点…', 'Extracting places from guides…');
  }
  if (stage === 'enrich_comments') {
    const total = Number(work.commentGuideTotal) || Math.min(5, (job.draft?.guides || []).filter((guide) => guide.noteId).length);
    const done = work.commentGuideIndex || 0;
    return message(locale,
      `正在读取评论区提示（${done}/${total || 1}）…`,
      `Reading comment tips (${done}/${total || 1})…`);
  }
  if (stage === 'gather_evidence') {
    if (!work.bias && !work.biasFailed && destination) {
      return message(locale, `正在定位「${destination}」…`, `Locating “${destination}”…`);
    }
    if (!work.geocodeDone) {
      const total = work.candidates?.length || 0;
      return message(locale, `正在匹配地图坐标（${total} 个地点）…`, `Matching map coordinates (${total} places)…`);
    }
    if (!work.photosDone && (work.evidence?.length || 0) > 0) {
      return message(locale, '正在获取景点配图…', 'Fetching place photos…');
    }
  }
  if (stage === 'write_copy' || stage === 'gate' || stage === 'schedule') {
    return message(locale, '正在排行程…', 'Building the itinerary…');
  }
  if (stage === 'ready') {
    return message(locale, '预览已就绪', 'Preview is ready');
  }
  return message(locale, '处理中…', 'Working…');
}

function progressStepForJob(job) {
  const stage = String(job.stage || '');
  if (stage === 'ready') return 4;
  if (['schedule', 'write_copy', 'gate'].includes(stage)) return 4;
  if (stage === 'gather_evidence') return 3;
  if (stage === 'extract') return 2;
  return 1;
}

function progressCounts(job) {
  const work = job.work || {};
  const guides = job.draft?.guides || [];
  const guidesTotal = guides.length
    + Math.max(0, (work.urls?.length || 0) - (work.urlIndex || 0))
    + Math.max(0, (work.pendingNotes?.length || 0) - (work.noteIndex || 0));
  const candidatesTotal = work.candidates?.length || 0;
  const evidenceDone = work.geocodeDone ? (work.evidence?.length || 0) : 0;
  return {
    guidesRead: guides.length,
    guidesTotal,
    placesTotal: candidatesTotal,
    placesResolved: evidenceDone,
  };
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

function placeSearchQuery(candidate, destination) {
  const rawName = String(candidate?.nameZh || candidate?.name || '').trim();
  const name = PLACE_SEARCH_ALIASES[rawName] || rawName;
  const dest = String(destination || '').trim();
  if (!name) return dest;
  if (!dest) return name;
  if (foldName(name).includes(foldName(dest)) || foldName(dest).includes(foldName(name))) return name;
  return `${name} ${dest}`;
}

function placeSearchNames(candidate, destination) {
  const name = String(candidate?.nameZh || candidate?.name || '').trim();
  const alias = PLACE_SEARCH_ALIASES[name];
  const queries = [];
  const add = (value) => {
    const text = String(value || '').trim();
    if (text && !queries.includes(text)) queries.push(text);
  };
  add(placeSearchQuery(candidate, destination));
  add(alias);
  add(name);
  return queries;
}

function finiteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function radiusKmFromPlace(place, destination) {
  const dest = String(destination || place?.name || '').trim();
  const types = (place?.types || []).map((item) => String(item).toLowerCase());
  const hay = `${place?.name || ''} ${place?.address || ''} ${dest}`;
  if (isMultiCityDestination(dest) || /(地区|自治州|自治区|盟|群岛)$/.test(dest) || /islands|prefecture/i.test(hay)) {
    return REGION_RADIUS_KM;
  }
  if (types.some((type) => ['state', 'province', 'region'].includes(type))) return REGION_RADIUS_KM;
  if (types.some((type) => ['county', 'municipality'].includes(type))) return 200;
  if (types.some((type) => ['island', 'archipelago'].includes(type)) || /岛$|island/i.test(dest)) return 350;
  return MAX_FROM_DESTINATION_KM;
}

function destinationRadiusKm(bias, destination) {
  const km = Number(bias?.radiusKm);
  if (Number.isFinite(km) && km > 0) return km;
  return radiusKmFromPlace(bias, destination);
}

function destinationMentioned(text, destination) {
  const hay = String(text || '');
  const dest = String(destination || '').trim();
  if (dest.length < 2) return false;
  const lowerHay = hay.toLowerCase();
  const lowerDest = dest.toLowerCase();
  let from = 0;
  while (from <= lowerHay.length - lowerDest.length) {
    const idx = lowerHay.indexOf(lowerDest, from);
    if (idx < 0) return false;
    const window = hay.slice(Math.max(0, idx - 1), idx + dest.length + 1);
    if ((dest === '京都' || lowerDest === 'kyoto') && /[东東]京都/.test(window)) {
      from = idx + 1;
      continue;
    }
    if (/^[a-z]/i.test(dest)) {
      const before = idx === 0 ? ' ' : lowerHay[idx - 1];
      const after = idx + dest.length >= lowerHay.length ? ' ' : lowerHay[idx + dest.length];
      if (/[a-z0-9]/i.test(before) || /[a-z0-9]/i.test(after)) {
        from = idx + 1;
        continue;
      }
    }
    return true;
  }
  return false;
}

function addressMentionsDestination(place, destination) {
  return destinationMentioned(`${place?.name || ''} ${place?.address || ''}`, destination);
}

function pickDestinationBias(places, destination) {
  const ranked = (Array.isArray(places) ? places : []).filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
  if (!ranked.length) return null;
  const dest = String(destination || '').trim();
  const admin = ranked.filter((item) => isAdministrativePlace(item));
  const namedAdmin = admin.find((item) => dest && (destinationMentioned(item.name, dest) || addressMentionsDestination(item, dest)));
  const named = ranked.find((item) => dest && (destinationMentioned(item.name, dest) || addressMentionsDestination(item, dest)));
  const chosen = namedAdmin || named || admin[0] || ranked[0];
  const radiusKm = radiusKmFromPlace(chosen, dest);
  return {
    lat: chosen.lat,
    lng: chosen.lng,
    radiusKm,
    radius: Math.round(radiusKm * 1000),
    types: Array.isArray(chosen.types) ? chosen.types : [],
    name: chosen.name || dest,
  };
}

function nearDestination(place, destination, bias) {
  if (!finiteCoordinate(place?.lat) || !finiteCoordinate(place?.lng)) return false;
  if (!bias || !finiteCoordinate(bias.lat) || !finiteCoordinate(bias.lng)) return true;
  const distance = haversineKm(place, bias);
  if (distance > ABSOLUTE_MAX_FROM_DESTINATION_KM) return false;
  const radius = destinationRadiusKm(bias, destination);
  if (distance <= radius) return true;
  return addressMentionsDestination(place, destination) && distance <= REGION_RADIUS_KM;
}

function isLowQualityPlace(place) {
  const types = (place?.types || []).map((item) => String(item).toLowerCase());
  if (types.some((type) => [
    'parking', 'parking_lot', 'parking_space', 'bus_stop', 'bus_station',
    'transit_station', 'subway_station', 'train_station', 'tram_stop',
  ].includes(type))) return true;
  const label = `${place?.name || ''} ${place?.address || ''}`;
  return /停车场|公交站|地铁站|停车楼|换乘站|parking lot|bus stop|transit station/i.test(label);
}

function scoreSearchPlace(place, destination) {
  let score = geoScoreRow({
    category: place?.types?.[0],
    type: place?.types?.[1] || place?.types?.[0],
    name: place?.name,
    importance: 0.2,
  });
  if (isGenericPlaceName(place.name, destination)) score -= 10;
  if (isAdministrativePlace(place)) score -= 8;
  if (isLowQualityPlace(place)) score -= 12;
  const dest = String(destination || '').trim();
  if (addressMentionsDestination(place, dest)) score += 2;
  return score;
}
function isAdministrativePlace(place) {
  const types = (place?.types || []).map((item) => String(item).toLowerCase());
  return types.some((type) => [
    'boundary', 'administrative', 'province', 'state', 'country',
    'region', 'municipality', 'county', 'city', 'town',
  ].includes(type));
}

function pickSearchPlace(candidate, ranked) {
  if (!ranked.length) return null;
  const wanted = [candidate?.nameZh, candidate?.name].map((item) => String(item || '').trim()).filter(Boolean);
  const related = ranked.filter((place) => wanted.some((name) => namesOverlap(name, place.name)));
  const pool = related.length ? related : ranked;
  return pool.find((item) => !isGenericPlaceName(item.name, '') && !isAdministrativePlace(item))
    || pool[0]
    || null;
}

function evidenceFromSearch(candidate, result, index, destination, bias, options = {}) {
  const places = (result?.places || []).filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
  const nearby = places.filter((item) => nearDestination(item, destination, bias));
  const pool = nearby.length ? nearby : (options.allowFar ? places : []);
  const ranked = pool
    .filter((item) => !isLowQualityPlace(item))
    .slice()
    .sort((left, right) => scoreSearchPlace(right, destination) - scoreSearchPlace(left, destination));
  const place = pickSearchPlace(candidate, ranked);
  if (!place || isLowQualityPlace(place)) return null;
  const displayName = String(candidate?.nameZh || candidate?.name || place.name);
  return {
    id: `ev_${index + 1}`,
    name: displayName,
    mapName: String(place.name || ''),
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
    reservationRequired: candidate.reservationRequired === true,
    reservationHint: candidate.reservationTips || (candidate.reservationRequired ? 'Reservation may be required' : ''),
    reason: candidate.reason,
    dayHint: candidate.dayHint,
    photoUrl: '',
    unmapped: false,
    tooFarFromDestination: !nearby.length && options.allowFar === true,
  };
}

function unmappedEvidenceFromCandidate(candidate, index) {
  const name = String(candidate?.nameZh || candidate?.name || '').trim();
  return {
    id: `ev_${index + 1}`,
    name,
    mapName: '',
    lat: null,
    lng: null,
    address: '',
    placeId: null,
    osmId: null,
    provider: '',
    categoryHint: 'sight',
    source: 'unmapped',
    fromGuideIds: candidate?.guideId ? [candidate.guideId] : [],
    stayHintMinutes: candidate?.durationMinutes,
    reservationRequired: candidate?.reservationRequired === true,
    reservationHint: candidate?.reservationTips || '',
    reason: candidate?.reason || '',
    dayHint: candidate?.dayHint || 1,
    photoUrl: '',
    unmapped: true,
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

function clusterCentroid(items) {
  const coords = items.filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
  if (!coords.length) return null;
  const sum = coords.reduce((acc, item) => ({ lat: acc.lat + item.lat, lng: acc.lng + item.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / coords.length, lng: sum.lng / coords.length };
}

function maxSpanKm(items) {
  let max = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      max = Math.max(max, haversineKm(items[i], items[j]));
    }
  }
  return max;
}

function clusterEvidence(items, linkKm) {
  const parent = items.map((_, index) => index);
  const find = (index) => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const unite = (left, right) => {
    parent[find(left)] = find(right);
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (haversineKm(items[i], items[j]) <= linkKm) unite(i, j);
    }
  }
  const groups = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[index]);
  }
  return [...groups.values()];
}

function adminUnitFromAddress(address) {
  const parts = String(address || '').split(/[,，]/).map((part) => part.trim()).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const embedded = part.match(/(?:省|自治区)(.{2,10}?)(市|县|州|盟|地区)/);
    if (embedded) {
      const name = stripAdminTail(`${embedded[1]}${embedded[2]}`);
      if (name.length >= 2 && !/(省|自治区)$/.test(name)) return name;
    }
    const match = part.match(/([^,，/]{2,10}?)(市|县|州|盟|地区)$/);
    if (match) {
      const name = stripAdminTail(match[0]);
      if (name.length >= 2 && !/(省|自治区)$/.test(name)) return name;
    }
  }
  return null;
}

function inferRegionName(items, destination, locale) {
  const counts = new Map();
  for (const item of items) {
    const fromAddress = adminUnitFromAddress(item.address);
    if (fromAddress) counts.set(fromAddress, (counts.get(fromAddress) || 0) + 1);
  }
  if (counts.size) {
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  }
  return message(locale, '子区域', 'Area');
}

function allocateRegionDays(totalDays, sizes) {
  const regionCount = sizes.length;
  if (regionCount <= 0) return [];
  if (regionCount === 1) return [totalDays];
  if (regionCount > totalDays) {
    const slots = sizes.map((_, index) => (index < totalDays ? 1 : 0));
    let used = slots.reduce((sum, size) => sum + size, 0);
    while (used < totalDays) {
      const index = slots.findIndex((size) => size === 0);
      if (index < 0) break;
      slots[index] = 1;
      used += 1;
    }
    return slots;
  }
  const slots = sizes.map(() => 1);
  let remaining = Math.max(0, totalDays - regionCount);
  const totalSize = sizes.reduce((sum, size) => sum + size, 0) || regionCount;
  const extras = sizes.map((size) => Math.floor(remaining * size / totalSize));
  for (let index = 0; index < regionCount; index += 1) slots[index] += extras[index];
  let used = slots.reduce((sum, size) => sum + size, 0);
  let cursor = 0;
  while (used < totalDays) {
    slots[cursor % regionCount] += 1;
    used += 1;
    cursor += 1;
  }
  while (used > totalDays) {
    const index = slots.findIndex((size) => size > 1);
    if (index < 0) break;
    slots[index] -= 1;
    used -= 1;
  }
  return slots;
}

function isMultiCityDestination(destination) {
  const dest = String(destination || '').trim();
  if (!dest) return false;
  if (/(省|自治区|地区|盟)$/.test(dest)) return true;
  const core = stripAdminTail(dest);
  return /^(河南|河北|山西|山东|陕西|甘肃|青海|四川|云南|贵州|湖南|湖北|江西|安徽|江苏|浙江|福建|广东|海南|辽宁|吉林|黑龙江|内蒙古|广西|宁夏|新疆|西藏|大兴安岭|呼伦贝尔|漠河)$/.test(core);
}

function splitRegions(intent, evidence, locale) {
  const items = (Array.isArray(evidence) ? evidence : []).filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
  if (!isMultiCityDestination(intent?.destination)
    || items.length <= 1
    || maxSpanKm(items) <= REGION_SPLIT_MIN_SPAN_KM) {
    return { evidence, regions: [] };
  }
  const clusters = clusterEvidence(items, REGION_CLUSTER_KM);
  if (clusters.length <= 1) {
    return { evidence, regions: [] };
  }
  while (clusters.length > intent.dayCount) {
    let minIndex = 0;
    for (let index = 1; index < clusters.length; index += 1) {
      if (clusters[index].length < clusters[minIndex].length) minIndex = index;
    }
    const mergeInto = minIndex > 0 ? minIndex - 1 : 1;
    clusters[mergeInto].push(...clusters[minIndex]);
    clusters.splice(minIndex, 1);
  }
  clusters.sort((left, right) => {
    const leftCenter = clusterCentroid(left);
    const rightCenter = clusterCentroid(right);
    return (leftCenter?.lng || 0) - (rightCenter?.lng || 0);
  });
  const daySlots = allocateRegionDays(intent.dayCount, clusters.map((cluster) => cluster.length));
  const regions = [];
  let dayStart = 1;
  for (let index = 0; index < clusters.length; index += 1) {
    const cluster = clusters[index];
    const span = daySlots[index] || 1;
    const dayEnd = dayStart + span - 1;
    const name = inferRegionName(cluster, intent.destination, locale);
    regions.push({ name, dayStart, dayEnd, placeCount: cluster.length });
    cluster.forEach((item, placeIndex) => {
      item.regionName = name;
      item.dayHint = dayStart + (placeIndex % span);
    });
    dayStart = dayEnd + 1;
  }
  return { evidence, regions };
}

function tooFarLimitKm(evidence) {
  const items = Array.isArray(evidence) ? evidence.filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng)) : [];
  let max = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      max = Math.max(max, haversineKm(items[i], items[j]));
    }
  }
  return max > 200 ? 300 : TOO_FAR_KM;
}

function markDistance(days, limitKm = TOO_FAR_KM) {
  const limit = Number.isFinite(limitKm) && limitKm > 0 ? limitKm : TOO_FAR_KM;
  for (const day of days) {
    day.places.forEach((place, index) => {
      if (place.unmapped || !finiteCoordinate(place.lat) || !finiteCoordinate(place.lng)) {
        place.tooFar = false;
        place.selected = true;
        return;
      }
      const previous = [...day.places.slice(0, index)].reverse()
        .find((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
      const tooFar = previous ? haversineKm(previous, place) > limit : false;
      place.tooFar = tooFar;
      place.selected = !tooFar;
    });
  }
}

function sortDayPlacesByDistance(places) {
  const list = Array.isArray(places) ? places.slice() : [];
  const mapped = list.filter((item) => finiteCoordinate(item?.lat) && finiteCoordinate(item?.lng));
  const unmapped = list.filter((item) => !finiteCoordinate(item?.lat) || !finiteCoordinate(item?.lng));
  if (mapped.length <= 2) return mapped.concat(unmapped);
  const remaining = mapped.slice();
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const anchor = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const distance = haversineKm(anchor, remaining[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return ordered.concat(unmapped);
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
    const mapped = finiteCoordinate(item.lat) && finiteCoordinate(item.lng);
    const key = mapped
      ? `${item.name.toLowerCase()}|${item.lat.toFixed(5)}|${item.lng.toFixed(5)}`
      : `${String(item.name || '').toLowerCase()}|unmapped|${item.id || unique.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!mapped) {
      unique.push({ ...item, unmapped: true });
      continue;
    }
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
  const dayRegionNames = new Map();
  for (const item of unique.slice(0, intent.dayCount * perDay)) {
    let dayIndex = Math.max(0, Math.min(days.length - 1, Number(item.dayHint || 1) - 1));
    if (days[dayIndex].places.length >= perDay) {
      dayIndex = days.findIndex((day) => day.places.length < perDay);
      if (dayIndex < 0) break;
    }
    if (item.regionName && !dayRegionNames.has(dayIndex)) {
      dayRegionNames.set(dayIndex, item.regionName);
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
      reason: item.reason || '',
      fromGuideIds: item.fromGuideIds || [],
      notes: item.reason || item.reservationHint || '',
      reservationRequired: item.reservationRequired === true,
      reservationTips: item.reservationHint || '',
      photoUrl: item.photoUrl || '',
      commentTips: item.commentTips || [],
      tooFar: item.tooFarFromDestination === true,
      unmapped: item.unmapped === true,
      selected: item.tooFarFromDestination !== true,
      tooFarFromDestination: item.tooFarFromDestination === true,
    });
  }
  for (const day of days) {
    day.places = sortDayPlacesByDistance(day.places);
  }
  for (const [dayIndex, regionName] of dayRegionNames.entries()) {
    days[dayIndex].title = message(locale, `第 ${dayIndex + 1} 天 · ${regionName}`, `Day ${dayIndex + 1} · ${regionName}`);
  }
  rebalanceDays(days);
  markDistance(days, tooFarLimitKm(unique));
  for (const day of days) {
    for (const place of day.places) {
      if (place.tooFarFromDestination) {
        place.tooFar = true;
        place.selected = false;
      }
    }
  }
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
    guides: guides.map(({ text, commentInsights, xsecToken, ...guide }) => guide),
    sourceSummary: {
      basis: guides.length ? 'guides' : 'destination',
      query: intent.guideQuery || '',
      destination: intent.destination || '',
      searchQuery: job.work?.lastSearchQuery || intent.searchQueries?.[0] || intent.guideQuery || '',
      noteCount: guides.filter((guide) => guide.via === 'search' || guide.via === 'url').length,
    },
    progress: {
      ...progressCounts(job),
      message: progressForJob(job, job.payload?.locale || 'en'),
      step: progressStepForJob(job),
      totalSteps: 4,
    },
    warnings: draft.warnings || [],
    days: draft.days || [],
    prepTips: Array.isArray(draft.prepTips) ? draft.prepTips : [],
    reservations: Array.isArray(draft.reservations) ? draft.reservations : [],
    budget: draft.budget && typeof draft.budget === 'object' ? draft.budget : null,
    extractMeta: job.work?.extractMeta || null,
    ...(job.error ? { error: job.error } : {}),
  };
}

module.exports = {
  TOO_FAR_KM,
  MAX_FROM_DESTINATION_KM,
  REGION_RADIUS_KM,
  ABSOLUTE_MAX_FROM_DESTINATION_KM,
  EXTRACTION_SCHEMA,
  PLACE_SEARCH_ALIASES,
  looksLikeShareCard,
  noteDisplayTitle,
  settings,
  geoSearchOptions,
  resolveXhsKeywordSearch,
  truthySetting,
  collectXhsNoteIds,
  remainingXhsNoteSlots,
  mapConcurrent,
  resolveCandidateEvidence,
  progressForJob,
  progressStepForJob,
  progressCounts,
  isZh,
  message,
  normalizeInput,
  extractionText,
  extractionInstruction,
  normalizeCandidates,
  inferDestinationFromGuides,
  inferDayCountFromGuides,
  applyGuideDerivedIntent,
  filterInventedCandidates,
  mergeGuideTexts,
  isLowQualityPlace,
  scoreSearchPlace,
  sortDayPlacesByDistance,
  reservationHintsFromLine,
  candidatesFromGuideText,
  resolveExtractCandidates,
  guideTextForExtractRetry,
  extractRetryInstruction,
  isGenericPlaceName,
  isWeakPlaceName,
  targetPlaceCount,
  placeSearchQuery,
  placeSearchNames,
  guideSearchQueries,
  evidenceFromSearch,
  unmappedEvidenceFromCandidate,
  nearDestination,
  pickDestinationBias,
  destinationRadiusKm,
  gateAndSchedule,
  splitRegions,
  publicDraft,
  haversineKm,
  filterMarketingGuides,
  isMarketingCandidate,
  isMultiCityDestination,
  REGION_CLUSTER_KM,
  REGION_SPLIT_MIN_SPAN_KM,
};
