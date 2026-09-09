const { PUBLIC_USER_AGENT } = require('./signature');
const { throwForHttpStatus } = require('./errors');

const NOTE_ID = /^[a-f0-9]{24}$/i;
const UA = PUBLIC_USER_AGENT;

function canonicalHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function isAllowedHost(hostname) {
  const host = canonicalHost(hostname);
  return host === 'xiaohongshu.com' || host === 'xhslink.com' || host === 'xhslink.cn';
}

function isShortLinkHost(hostname) {
  const host = canonicalHost(hostname);
  return host === 'xhslink.com' || host === 'xhslink.cn';
}

function noteIdFromUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!isAllowedHost(url.hostname) || isShortLinkHost(url.hostname)) return null;
    const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i);
    return match && NOTE_ID.test(match[1]) ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function searchKeywordFromUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!isAllowedHost(url.hostname) || !url.pathname.includes('/search_result')) return null;
    return String(url.searchParams.get('keyword') || '').trim() || null;
  } catch {
    return null;
  }
}

function extractXhsUrls(...blobs) {
  const found = [];
  const seen = new Set();
  for (const blob of blobs) {
    const matches = String(blob || '').match(/https?:\/\/[^\s<>"'）)】]+/gi) || [];
    for (let raw of matches) {
      raw = raw.replace(/[.,;:!?，。！？~～]+$/g, '');
      let url;
      try { url = new URL(raw); } catch { continue; }
      if (!isAllowedHost(url.hostname)) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      found.push(url.href);
    }
  }
  return found;
}

function splitGuidePaste(...blobs) {
  const combined = blobs.map((blob) => String(blob || '').trim()).filter(Boolean).join('\n');
  const urls = extractXhsUrls(combined);
  let rest = combined;
  for (const url of urls) rest = rest.split(url).join(' ');
  rest = rest.replace(/https?:\/\/[^\s<>"']+/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { urls, sourceText: rest.slice(0, 12000) };
}

function parseInitialState(html, noteId) {
  const source = String(html || '');
  if (!/noteDetailMap/i.test(source)) {
    throw new Error('Xiaohongshu page did not contain initial note data');
  }
  const match = source.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script/i);
  if (!match) throw new Error('Xiaohongshu page did not contain initial note data');
  const state = JSON.parse(match[1].replace(/\bundefined\b/g, '""'));
  const map = state?.note?.noteDetailMap || state?.note?.note_detail_map;
  const wrapped = map?.[noteId] || map?.[String(noteId)];
  const note = wrapped?.note;
  const title = String(note?.title || note?.displayTitle || note?.display_title || '').trim();
  const text = String(note?.desc || note?.description || '').trim();
  if (!note || (!title && !text)) {
    throw new Error('Xiaohongshu note text was unavailable');
  }
  return { noteId, title, text };
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
  const href = `https://www.xiaohongshu.com/explore/${noteId}`;
  if (!xsecToken) return href;
  return `${href}?xsec_token=${xsecToken}&xsec_source=${xsecSource || 'pc_search'}`;
}

function publicPageHeaders() {
  return {
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': UA,
  };
}

function nextRedirectUrl(current, response) {
  const location = response?.headers?.get?.('location');
  if (location) return new URL(location, current);
  const finalHref = typeof response?.url === 'string' ? response.url : '';
  if (finalHref && finalHref !== current.href) return new URL(finalHref);
  return null;
}

async function resolveNoteUrl(value) {
  let url = new URL(String(value).trim());
  for (let hop = 0; hop < 4; hop += 1) {
    if (!isAllowedHost(url.hostname)) throw new Error('Unsupported Xiaohongshu URL');
    if (isShortLinkHost(url.hostname)) {
      const response = await fetchWithTimeout(url.href, { redirect: 'manual', headers: publicPageHeaders() }, 4000);
      const next = nextRedirectUrl(url, response);
      if (!next) throw new Error('Xiaohongshu short link did not redirect');
      if (!isAllowedHost(next.hostname)) throw new Error('Xiaohongshu short link left the allowed hosts');
      url = next;
      continue;
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
  throw new Error('Xiaohongshu short link redirected too many times');
}

async function fetchHtmlNote(resolved, options = {}) {
  const headers = publicPageHeaders();
  const cookie = String(options.cookie || '').trim();
  if (cookie) headers.cookie = cookie;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  const response = await fetchWithTimeout(resolved.url, { headers }, timeoutMs);
  throwForHttpStatus(response);
  return {
    ...parseInitialState(await response.text(), resolved.noteId),
    url: resolved.url,
    via: options.via || 'url',
    xsecToken: resolved.xsecToken || '',
  };
}

async function fetchPublicNoteFromResolved(resolved) {
  try {
    return await fetchHtmlNote(resolved, { timeoutMs: 5000, via: 'url' });
  } catch (error) {
    error.noteId = resolved.noteId;
    error.xsecToken = resolved.xsecToken || '';
    error.resolvedUrl = resolved.url;
    throw error;
  }
}

async function fetchPublicNote(value) {
  return fetchPublicNoteFromResolved(await resolveNoteUrl(value));
}

module.exports = {
  UA,
  isAllowedHost,
  isShortLinkHost,
  extractXhsUrls,
  splitGuidePaste,
  noteIdFromUrl,
  searchKeywordFromUrl,
  parseInitialState,
  resolveNoteUrl,
  fetchHtmlNote,
  fetchPublicNoteFromResolved,
  fetchPublicNote,
  fetchWithTimeout,
  exploreNoteUrl,
  queryValue,
};
