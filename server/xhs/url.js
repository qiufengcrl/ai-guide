const NOTE_ID = /^[a-f0-9]{24}$/i;
const ALLOWED_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIN_INTERVAL_MS = 900;

let lastCallAt = 0;
let minIntervalMs = MIN_INTERVAL_MS;

function setXhsThrottleInterval(ms) {
  minIntervalMs = Math.max(0, Number(ms) || 0);
}

function jitterMs() {
  if (!minIntervalMs) return 0;
  return Math.floor(Math.random() * 400);
}

async function paceOutbound() {
  if (!minIntervalMs) return;
  const wait = Math.max(0, minIntervalMs + jitterMs() - (Date.now() - lastCallAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

function noteIdFromUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i);
    return match && NOTE_ID.test(match[1]) ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function searchKeywordFromUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || !url.pathname.includes('/search_result')) return null;
    return String(url.searchParams.get('keyword') || '').trim() || null;
  } catch {
    return null;
  }
}

function xsecFromUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return {
      xsecToken: queryValue(url, 'xsec_token'),
      xsecSource: queryValue(url, 'xsec_source'),
    };
  } catch {
    return { xsecToken: '', xsecSource: '' };
  }
}

function queryValue(url, name) {
  const query = url.search ? url.search.slice(1) : '';
  if (!query) return '';
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=');
    const rawName = decodeURIComponent((separator < 0 ? pair : pair.slice(0, separator)).replace(/\+/g, '%20'));
    if (rawName !== name) continue;
    const rawValue = separator < 0 ? '' : pair.slice(separator + 1);
    return decodeURIComponent(rawValue.replace(/\+/g, '%2B'));
  }
  return '';
}

function exploreNoteUrl(noteId, xsecToken = '', xsecSource = 'pc_search') {
  const url = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  if (xsecToken) {
    url.searchParams.set('xsec_token', xsecToken);
    url.searchParams.set('xsec_source', xsecSource || 'pc_search');
  }
  return url.href;
}

function parseInitialState(html, noteId) {
  const match = String(html).match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script/i);
  if (!match) throw new Error('Xiaohongshu page did not contain initial note data');
  const state = JSON.parse(match[1].replace(/\bundefined\b/g, 'null'));
  const note = state?.note?.noteDetailMap?.[noteId]?.note;
  if (!note || (!String(note.title || '').trim() && !String(note.desc || '').trim())) {
    throw new Error('Xiaohongshu note text was unavailable');
  }
  return { noteId, title: String(note.title || '').trim(), text: String(note.desc || '').trim() };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchXhs(url, init = {}, timeoutMs = 15000) {
  await paceOutbound();
  return fetchWithTimeout(url, init, timeoutMs);
}

function publicPageHeaders() {
  return {
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': UA,
  };
}

async function resolveNoteUrl(value) {
  let url = new URL(String(value).trim());
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new Error('Unsupported Xiaohongshu URL');
  if (url.hostname.toLowerCase() === 'xhslink.com') {
    const response = await fetchXhs(url.href, {
      redirect: 'manual',
      headers: publicPageHeaders(),
    }, 8000);
    const location = response.headers.get('location');
    if (location) {
      url = new URL(location, url);
    } else if (response.ok) {
      const html = await response.text();
      const embedded = html.match(/https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/[a-f0-9]{24}[^"'<\s]*/i);
      if (!embedded) throw new Error('Xiaohongshu short link did not redirect');
      url = new URL(embedded[0]);
    } else {
      throw new Error('Xiaohongshu short link did not redirect');
    }
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new Error('Xiaohongshu short link left the allowed hosts');
  }
  const noteId = noteIdFromUrl(url.href);
  if (!noteId) throw new Error('Unsupported Xiaohongshu note URL');
  const xsecToken = queryValue(url, 'xsec_token');
  const xsecSource = queryValue(url, 'xsec_source') || 'pc_share';
  return {
    noteId,
    xsecToken,
    xsecSource,
    url: exploreNoteUrl(noteId, xsecToken, xsecSource),
  };
}

async function fetchPublicNote(value) {
  const resolved = await resolveNoteUrl(value);
  const response = await fetchXhs(resolved.url, { headers: publicPageHeaders() });
  if (!response.ok) throw new Error(`Xiaohongshu page returned ${response.status}`);
  return { ...parseInitialState(await response.text(), resolved.noteId), url: resolved.url, via: 'url' };
}

module.exports = {
  UA,
  noteIdFromUrl,
  searchKeywordFromUrl,
  xsecFromUrl,
  parseInitialState,
  resolveNoteUrl,
  fetchPublicNote,
  fetchWithTimeout,
  fetchXhs,
  exploreNoteUrl,
  setXhsThrottleInterval,
  publicPageHeaders,
};
