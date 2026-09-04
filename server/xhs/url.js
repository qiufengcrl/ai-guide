const NOTE_ID = /^[a-f0-9]{24}$/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
      const response = await fetchWithTimeout(url.href, { redirect: 'manual', headers: { 'user-agent': UA } }, 4000);
      const next = nextRedirectUrl(url, response);
      if (!next) throw new Error('Xiaohongshu short link did not redirect');
      if (!isAllowedHost(next.hostname)) throw new Error('Xiaohongshu short link left the allowed hosts');
      url = next;
      continue;
    }
    const noteId = noteIdFromUrl(url.href);
    if (!noteId) throw new Error('Unsupported Xiaohongshu note URL');
    return {
      noteId,
      url: url.href,
      xsecToken: url.searchParams.get('xsec_token') || '',
    };
  }
  throw new Error('Xiaohongshu short link redirected too many times');
}

async function fetchPublicNoteFromResolved(resolved, cookie) {
  const headers = { 'user-agent': UA };
  if (cookie) headers.cookie = cookie;
  try {
    const response = await fetchWithTimeout(resolved.url, { headers }, 5000);
    if (!response.ok) throw new Error(`Xiaohongshu page returned ${response.status}`);
    return { ...parseInitialState(await response.text(), resolved.noteId), url: resolved.url, via: 'url' };
  } catch (error) {
    error.noteId = resolved.noteId;
    error.xsecToken = resolved.xsecToken || '';
    error.resolvedUrl = resolved.url;
    throw error;
  }
}

async function fetchPublicNote(value, cookie) {
  return fetchPublicNoteFromResolved(await resolveNoteUrl(value), cookie);
}

module.exports = {
  UA,
  isAllowedHost,
  isShortLinkHost,
  extractXhsUrls,
  noteIdFromUrl,
  searchKeywordFromUrl,
  parseInitialState,
  resolveNoteUrl,
  fetchPublicNoteFromResolved,
  fetchPublicNote,
  fetchWithTimeout,
};
