function foldText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function moneyAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

function detectCurrency(destination, clues) {
  const dest = String(destination || '');
  if (/日本|京都|大阪|东京|東京|北海道|沖縄|冲绳|japan|tokyo|kyoto|osaka/i.test(dest)) return 'JPY';
  if (/韩国|首尔|釜山|korea|seoul/i.test(dest)) return 'KRW';
  if (/美国|纽约|洛杉矶|usa|united states|new york/i.test(dest)) return 'USD';
  if (/法国|意大利|西班牙|德国|欧洲|paris|rome|europe|伦敦|london/i.test(dest)) return 'EUR';
  if ((clues || []).some((item) => item.currency === 'JPY')) return 'JPY';
  if ((clues || []).some((item) => item.currency === 'USD')) return 'USD';
  return 'CNY';
}

function normalizeCurrencyLabel(raw) {
  const text = String(raw || '').trim();
  if (/日元|円|jpy/i.test(text)) return 'JPY';
  if (/\$|usd|美元/i.test(text)) return 'USD';
  if (/€|eur|欧元/i.test(text)) return 'EUR';
  if (/₩|krw|韩元|韓元/i.test(text)) return 'KRW';
  if (/元|块|rmb|cny|¥/i.test(text)) return 'CNY';
  return '';
}

function clueKind(prefix) {
  const text = String(prefix || '');
  if (/门票|票价|门票钱/.test(text)) return 'tickets';
  if (/住宿|酒店|民宿|旅馆/.test(text)) return 'lodging';
  if (/交通|地铁|巴士|电车|机票|高铁/.test(text)) return 'transport';
  if (/人均|餐饮|吃饭|美食/.test(text)) return 'food';
  return 'other';
}

function extractPriceClues(guides, limit = 12) {
  const clues = [];
  const seen = new Set();
  const blobs = [];
  for (const guide of guides || []) {
    blobs.push(String(guide?.text || ''));
    for (const tip of guide?.commentInsights || []) blobs.push(String(tip || ''));
  }
  const re = /((?:人均|门票|票价|住宿|酒店|民宿|交通|地铁|餐饮|吃饭)[^\d]{0,12})(\d{2,6})(?:\s*)(元|日元|円|块|RMB|CNY|JPY|USD|\$|₩|韩元)?/gi;
  for (const blob of blobs) {
    re.lastIndex = 0;
    let match = re.exec(blob);
    while (match && clues.length < limit) {
      const amount = moneyAmount(match[2]);
      if (amount != null && amount >= 5) {
        const key = `${clueKind(match[1])}:${amount}:${normalizeCurrencyLabel(match[3])}`;
        if (!seen.has(key)) {
          seen.add(key);
          clues.push({
            kind: clueKind(match[1]),
            amount,
            currency: normalizeCurrencyLabel(match[3]) || '',
            text: foldText(match[0]).slice(0, 40),
          });
        }
      }
      match = re.exec(blob);
    }
  }
  return clues;
}

const DAILY = {
  CNY: {
    economy: { transport: 40, lodging: 180, tickets: 60, food: 80 },
    comfort: { transport: 80, lodging: 450, tickets: 120, food: 160 },
    luxury: { transport: 220, lodging: 1200, tickets: 260, food: 420 },
  },
  JPY: {
    economy: { transport: 800, lodging: 6000, tickets: 1500, food: 2500 },
    comfort: { transport: 1500, lodging: 12000, tickets: 2500, food: 4500 },
    luxury: { transport: 4000, lodging: 28000, tickets: 5000, food: 10000 },
  },
  USD: {
    economy: { transport: 15, lodging: 80, tickets: 25, food: 35 },
    comfort: { transport: 30, lodging: 180, tickets: 45, food: 70 },
    luxury: { transport: 80, lodging: 450, tickets: 90, food: 160 },
  },
  EUR: {
    economy: { transport: 12, lodging: 70, tickets: 20, food: 30 },
    comfort: { transport: 25, lodging: 160, tickets: 40, food: 60 },
    luxury: { transport: 70, lodging: 380, tickets: 80, food: 140 },
  },
  KRW: {
    economy: { transport: 8000, lodging: 50000, tickets: 15000, food: 25000 },
    comfort: { transport: 15000, lodging: 110000, tickets: 25000, food: 45000 },
    luxury: { transport: 40000, lodging: 280000, tickets: 50000, food: 90000 },
  },
};

function roundNice(value) {
  const amount = Number(value) || 0;
  if (amount >= 10000) return Math.round(amount / 100) * 100;
  if (amount >= 1000) return Math.round(amount / 50) * 50;
  if (amount >= 100) return Math.round(amount / 10) * 10;
  return Math.round(amount);
}

function scaleTier(daily, days) {
  const nights = Math.max(0, days - 1);
  return {
    transport: roundNice(daily.transport * days),
    lodging: roundNice(daily.lodging * Math.max(nights, days > 1 ? nights : 1)),
    tickets: roundNice(daily.tickets * days),
    food: roundNice(daily.food * days),
  };
}

function normalizeLlmTier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const transport = moneyAmount(raw.transport);
  const lodging = moneyAmount(raw.lodging);
  const tickets = moneyAmount(raw.tickets);
  const food = moneyAmount(raw.food);
  if ([transport, lodging, tickets, food].every((value) => value == null)) return null;
  return {
    transport: transport ?? 0,
    lodging: lodging ?? 0,
    tickets: tickets ?? 0,
    food: food ?? 0,
    notes: String(raw.notes || '').trim().slice(0, 200),
  };
}

function withTotal(tier) {
  return {
    ...tier,
    total: (Number(tier.transport) || 0)
      + (Number(tier.lodging) || 0)
      + (Number(tier.tickets) || 0)
      + (Number(tier.food) || 0),
  };
}

function estimateBudget({ destination, dayCount, guides, llm } = {}) {
  const clues = extractPriceClues(guides);
  const requested = String(llm?.currency || detectCurrency(destination, clues)).toUpperCase();
  const currency = DAILY[requested] ? requested : 'CNY';
  const days = Math.max(1, Number(dayCount) || 1);
  const table = DAILY[currency];
  let usedModel = false;
  const tiers = {};
  for (const name of ['economy', 'comfort', 'luxury']) {
    const fromLlm = normalizeLlmTier(llm?.[name]);
    const base = scaleTier(table[name], days);
    const merged = fromLlm || base;
    if (fromLlm) usedModel = true;
    if (fromLlm?.notes) merged.notes = fromLlm.notes;
    else merged.notes = '';
    tiers[name] = withTotal(merged);
  }
  return {
    currency,
    days,
    estimated: true,
    source: usedModel ? 'notes+model' : 'heuristic',
    clues: clues.slice(0, 8).map((item) => ({ kind: item.kind, amount: item.amount, currency: item.currency })),
    economy: tiers.economy,
    comfort: tiers.comfort,
    luxury: tiers.luxury,
  };
}

module.exports = {
  extractPriceClues,
  detectCurrency,
  estimateBudget,
};
