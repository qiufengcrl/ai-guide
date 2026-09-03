const NOTE_ID = /^[a-f0-9]{24}$/i;
const ALLOWED_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

async function resolveNoteUrl(value) {
  let url = new URL(String(value).trim());
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new Error('Unsupported Xiaohongshu URL');
  if (url.hostname.toLowerCase() === 'xhslink.com') {
    const response = await fetchWithTimeout(url.href, { redirect: 'manual', headers: { 'user-agent': UA } }, 8000);
    const location = response.headers.get('location');
    if (!location) throw new Error('Xiaohongshu short link did not redirect');
    url = new URL(location, url);
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new Error('Xiaohongshu short link left the allowed hosts');
  }
  const noteId = noteIdFromUrl(url.href);
  if (!noteId) throw new Error('Unsupported Xiaohongshu note URL');
  return { noteId, url: `https://www.xiaohongshu.com/explore/${noteId}` };
}

async function fetchPublicNote(value, cookie) {
  const resolved = await resolveNoteUrl(value);
  const headers = { 'user-agent': UA };
  if (cookie) headers.cookie = cookie;
  const response = await fetchWithTimeout(resolved.url, { headers });
  if (!response.ok) throw new Error(`Xiaohongshu page returned ${response.status}`);
  return { ...parseInitialState(await response.text(), resolved.noteId), url: resolved.url, via: 'url' };
}

module.exports = { UA, noteIdFromUrl, searchKeywordFromUrl, parseInitialState, resolveNoteUrl, fetchPublicNote, fetchWithTimeout };
