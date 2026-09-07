const MARKETING_TEXT_RE = /跟团|定制游|私信|加微信|加[Vv]|微信号|旅社|旅行社|包车游|一日游套餐|点击链接|代购|推广|商务合作|合作微信|报名咨询|vx[:：]|扫码咨询|纯玩团|当地向导|免费咨询|报名立减|进群优惠|导游微信|旅行顾问|点击主页|橱窗同款|佣金|广告合作|探店合作/i;

const PERSONAL_RE = /我去了|我们去|打卡|踩坑|人均|住在|吃了|走了|排了|人少|人多|建议提前|别去|值得|不值得|第[一二三四五六七八]天|day\s*[1-8]|上午|下午|傍晚|清晨|闭馆|预约|避坑/i;

const AD_PLACE_RE = /网红店合作|探店合作|广告植入|赞助商|种草合作/;

const QUALITY_MIN_SCORE = 22;

const PREP_LINE_RE = /避坑|提前预约|预约|穿衣|签证|换汇|交通卡|交通|地铁|门票|开放时间|注意事项|携带|旺季|淡季|排队|抢票|限流|闭馆|周一闭馆|周二闭馆/i;

const COMMENT_INSIGHT_RE = /避坑|排队|闭馆|周[一二三四五六日]|门票|价格|涨价|降价|人均|开放时间|营业时间|人少|拥挤|预约|抢票|注意事项|别去|不值得|推荐|必去|最新|更新|现在|目前|改到|调整到/i;

function foldText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function guidesForItem(guides, fromGuideIds) {
  const ids = new Set((fromGuideIds || []).map(String).filter(Boolean));
  if (!ids.size) return guides || [];
  return (guides || []).filter((guide) => ids.has(String(guide.id)));
}

function isMarketingText(text) {
  return MARKETING_TEXT_RE.test(String(text || ''));
}

function countReHits(re, text) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const matches = String(text || '').match(new RegExp(re.source, flags));
  return matches ? matches.length : 0;
}

function scoreGuide(guide) {
  const title = String(guide?.title || '');
  const body = String(guide?.text || guide?.desc || '').slice(0, 4000);
  const blob = `${title}\n${body}`;
  const liked = Number(guide?.likedCount || guide?.liked_count || 0);
  const reasons = [];
  if (isMarketingText(blob) || AD_PLACE_RE.test(blob)) {
    return { score: 0, reject: true, reasons: ['marketing'] };
  }
  let score = 40;
  const personalHits = countReHits(PERSONAL_RE, blob);
  if (personalHits) {
    score += Math.min(24, personalHits * 6);
    reasons.push('personal');
  }
  if (/第[一二三四五]天|day\s*[1-5]/i.test(blob)) {
    score += 10;
    reasons.push('itinerary');
  }
  if (body.length >= 180 && body.length <= 3500) score += 8;
  else if (body.length > 0 && body.length < 60) {
    score -= 12;
    reasons.push('thin');
  }
  const hashCount = (blob.match(/#/g) || []).length;
  if (hashCount >= 8) {
    score -= 12;
    reasons.push('hashtags');
  }
  if (liked > 0) score += Math.min(8, Math.floor(Math.log10(liked + 1) * 4));
  score = Math.max(0, Math.min(100, score));
  return { score, reject: false, reasons };
}

function isMarketingGuide(guide) {
  return scoreGuide(guide).reject;
}

function isMarketingCandidate(candidate) {
  const reason = String(candidate?.reason || '');
  const name = String(candidate?.name || '');
  return isMarketingText(`${name}\n${reason}`) || AD_PLACE_RE.test(`${name}\n${reason}`);
}

function filterMarketingGuides(guides) {
  const kept = [];
  let skipped = 0;
  for (const guide of guides || []) {
    const rating = scoreGuide(guide);
    if (rating.reject || rating.score < QUALITY_MIN_SCORE) {
      skipped += 1;
      continue;
    }
    kept.push({ ...guide, qualityScore: rating.score });
  }
  kept.sort((left, right) => (right.qualityScore || 0) - (left.qualityScore || 0));
  return { guides: kept, skipped };
}

function selectSearchNotes(notes, limit) {
  const cap = Math.max(0, Number(limit) || 0);
  return (notes || [])
    .map((note) => ({
      note,
      rating: scoreGuide({
        title: note?.title,
        text: note?.desc || note?.text || '',
        likedCount: note?.likedCount,
      }),
    }))
    .filter((row) => !row.rating.reject)
    .sort((left, right) => right.rating.score - left.rating.score
      || Number(right.note?.likedCount || 0) - Number(left.note?.likedCount || 0))
    .slice(0, cap)
    .map((row) => row.note);
}

function extractCommentInsights(comments, limit = 6) {
  const tips = [];
  const seen = new Set();
  for (const content of comments || []) {
    const text = String(content || '').replace(/https?:\/\/\S+/g, '').trim();
    if (text.length < 6 || text.length > 200) continue;
    if (!COMMENT_INSIGHT_RE.test(text)) continue;
    if (isMarketingText(text)) continue;
    const key = foldText(text);
    if (seen.has(key)) continue;
    seen.add(key);
    tips.push(text);
    if (tips.length >= limit) break;
  }
  return tips;
}

function commentTipsForPlace(placeName, guides, guideIds) {
  const ids = new Set((guideIds || []).map(String).filter(Boolean));
  const related = (guides || []).filter((guide) => !ids.size || ids.has(String(guide.id)));
  const tips = [];
  const seen = new Set();
  const foldedPlace = foldText(placeName);
  for (const guide of related) {
    for (const tip of guide.commentInsights || []) {
      const folded = foldText(tip);
      if (seen.has(folded)) continue;
      const mentionsPlace = foldedPlace.length >= 2 && folded.includes(foldedPlace);
      const general = /门票|价格|预约|闭馆|开放时间|人少|排队|避坑|注意事项/.test(tip);
      if (!mentionsPlace && !general) continue;
      seen.add(folded);
      tips.push(tip);
      if (tips.length >= 3) return tips;
    }
  }
  return tips;
}

function categorizePrepTip(text) {
  const value = String(text || '');
  if (/签证|换汇|货币|护照|入境|海关/.test(value)) return 'docs';
  if (/穿衣|衣服|防晒|雨具|气温|天气|鞋子|外套/.test(value)) return 'packing';
  if (/交通|地铁|公交|巴士|一日券|电车|打车|出租|交通卡|JR/.test(value)) return 'transit';
  if (/预约|抢票|约满|提前预约/.test(value)) return 'booking';
  if (/门票|开放时间|营业时间|闭馆|周一|排队|限流/.test(value)) return 'hours';
  return 'pitfall';
}

function toPrepTipItems(texts) {
  return (texts || []).map((text) => ({
    text: String(text),
    category: categorizePrepTip(text),
  }));
}

function extractPrepTips(guides, limit = 8) {
  const tips = [];
  const seen = new Set();
  for (const guide of guides || []) {
    for (const line of String(guide?.text || '').split(/\n/)) {
      const text = line.replace(/https?:\/\/\S+/g, '')
        .replace(/^[▪️•*\-\s]+/, '')
        .replace(/^\d+[.\u3001、]\s*/, '')
        .trim();
      if (text.length < 6 || text.length > 160) continue;
      if (!PREP_LINE_RE.test(text)) continue;
      if (isMarketingText(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tips.push(text);
      if (tips.length >= limit) break;
    }
    if (tips.length >= limit) break;
  }
  return tips;
}

function attachPreviewTips(draft, limit = 8) {
  const next = draft || {};
  const guides = next.guides || [];
  next.prepTips = toPrepTipItems(extractPrepTips(guides, limit));
  for (const day of next.days || []) {
    for (const place of day.places || []) {
      const related = guidesForItem(guides, place.fromGuideIds);
      place.prepTips = toPrepTipItems(extractPrepTips(related, 3));
    }
  }
  return next;
}

function formatGuideSources(fromGuideIds, guides, locale) {
  const ids = Array.isArray(fromGuideIds) ? fromGuideIds.filter(Boolean) : [];
  if (!ids.length) return '';
  const byId = new Map((guides || []).map((guide) => [String(guide.id), guide]));
  const links = [];
  for (const id of ids) {
    const guide = byId.get(String(id));
    if (!guide) continue;
    const title = String(guide.title || '').trim();
    const url = String(guide.url || '').trim();
    if (url) links.push(title ? `${title}: ${url}` : url);
    else if (title) links.push(title);
  }
  if (!links.length) return '';
  const label = locale === 'zh' ? '来源' : 'Source';
  return `${label}: ${links.join(' | ')}`;
}

function buildTrekPlaceNotes(item, guides, locale = 'zh') {
  const parts = [];
  const reason = String(item?.reason || '').trim();
  if (reason) parts.push(reason);
  if (item?.reservationRequired || item?.reservationTips) {
    const tip = String(item?.reservationTips || '').trim()
      || (locale === 'zh' ? '可能需要预约' : 'Reservation may be required');
    parts.push(locale === 'zh' ? `预约：${tip}` : `Reservation: ${tip}`);
  }
  const relatedGuides = guidesForItem(guides, item?.fromGuideIds);
  const prep = extractPrepTips(relatedGuides, 3);
  if (prep.length) {
    const label = locale === 'zh' ? '出发前提示' : 'Before you go';
    parts.push(`${label}：${prep.join('；')}`);
  }
  const commentTips = Array.isArray(item?.commentTips) && item.commentTips.length
    ? item.commentTips
    : commentTipsForPlace(item?.name, guides, item?.fromGuideIds);
  if (commentTips.length) {
    const label = locale === 'zh' ? '评论区提示' : 'From comments';
    parts.push(`${label}：${commentTips.join('；')}`);
  }
  const sources = formatGuideSources(item?.fromGuideIds, guides, locale);
  if (sources) parts.push(sources);
  return parts.join('\n\n').slice(0, 2000);
}

module.exports = {
  MARKETING_TEXT_RE,
  QUALITY_MIN_SCORE,
  scoreGuide,
  isMarketingGuide,
  isMarketingCandidate,
  filterMarketingGuides,
  selectSearchNotes,
  extractPrepTips,
  categorizePrepTip,
  toPrepTipItems,
  attachPreviewTips,
  extractCommentInsights,
  commentTipsForPlace,
  guidesForItem,
  buildTrekPlaceNotes,
  formatGuideSources,
};
