const MARKETING_TEXT_RE = /跟团|定制游|私信|加微信|加[Vv]|微信号|旅社|旅行社|包车游|一日游套餐|点击链接|代购|推广|商务合作|合作微信|报名咨询|vx[:：]|扫码咨询|纯玩团|当地向导|免费咨询/i;

const PREP_LINE_RE = /避坑|提前预约|预约|穿衣|签证|换汇|交通卡|门票|开放时间|注意事项|携带|旺季|淡季|排队|抢票|限流|闭馆|周一闭馆|周二闭馆/i;

function isMarketingText(text) {
  return MARKETING_TEXT_RE.test(String(text || ''));
}

function isMarketingGuide(guide) {
  const title = String(guide?.title || '');
  const body = String(guide?.text || '').slice(0, 4000);
  return isMarketingText(`${title}\n${body}`);
}

function isMarketingCandidate(candidate) {
  const reason = String(candidate?.reason || '');
  const name = String(candidate?.name || '');
  return isMarketingText(`${name}\n${reason}`);
}

function filterMarketingGuides(guides) {
  const kept = [];
  let skipped = 0;
  for (const guide of guides || []) {
    if (isMarketingGuide(guide)) {
      skipped += 1;
      continue;
    }
    kept.push(guide);
  }
  return { guides: kept, skipped };
}

function extractPrepTips(guides, limit = 3) {
  const tips = [];
  const seen = new Set();
  for (const guide of guides || []) {
    for (const line of String(guide?.text || '').split(/\n/)) {
      const text = line.replace(/https?:\/\/\S+/g, '').trim();
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
  const prep = extractPrepTips(guides, 2);
  if (prep.length) {
    const label = locale === 'zh' ? '出发前提示' : 'Before you go';
    parts.push(`${label}：${prep.join('；')}`);
  }
  const sources = formatGuideSources(item?.fromGuideIds, guides, locale);
  if (sources) parts.push(sources);
  return parts.join('\n\n').slice(0, 2000);
}

module.exports = {
  isMarketingGuide,
  isMarketingCandidate,
  filterMarketingGuides,
  extractPrepTips,
  buildTrekPlaceNotes,
  formatGuideSources,
};
