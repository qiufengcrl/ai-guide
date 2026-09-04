const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { searchNotes, fetchSessionNote, XhsSessionError, SEARCH_PAGE_SIZE } = require('../server/xhs/session');
const { fetchPublicNote, resolveNoteUrl, setXhsThrottleInterval } = require('../server/xhs/url');

setXhsThrottleInterval(0);

const COOKIE = 'a1=fixture-a1; web_session=fixture-session';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

function response(body, status = 200, extraHeaders = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return String(body); },
    headers: { get(name) { return extraHeaders[String(name).toLowerCase()] || null; } },
  };
}

test('会话搜索固定 page_size=20，带 search_id/filters，并把 xsec_token 写进详情和公开 URL', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return calls.length === 1 ? response(fixture('search.json')) : response(fixture('note-detail.json'));
  };
  try {
    const notes = await searchNotes('京都 景点 旅游 景点攻略', COOKIE, 4);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].xsecToken, 'fixture-token');
    assert.match(notes[0].url, /xsec_token=fixture-token/);
    assert.equal(calls[0].body.page_size, SEARCH_PAGE_SIZE);
    assert.equal(calls[0].body.page_size, 20);
    assert.match(String(calls[0].body.search_id), /^[a-f0-9]{21}$/);
    assert.equal(calls[0].body.filters[0].type, 'sort_type');
    assert.equal(calls[0].headers.origin, 'https://www.xiaohongshu.com');
    assert.equal(calls[0].headers.referer, 'https://www.xiaohongshu.com/');
    const note = await fetchSessionNote(notes[0], COOKIE);
    assert.match(note.text, /伏见稻荷/);
    assert.equal(calls[1].body.xsec_token, 'fixture-token');
    assert.equal(calls[1].body.source_note_id, '64f000000000000000000001');
  } finally {
    global.fetch = originalFetch;
  }
});

test('缺少 a1 或 web_session 的 Cookie 直接拒绝', async () => {
  await assert.rejects(searchNotes('旅行', 'sid=fixture', 1), /a1 or web_session/);
});

test('300011、验证码和异常文案被识别为会话失效', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => response({ success: false, code: 300011, msg: '账号异常' });
    await assert.rejects(searchNotes('旅行', COOKIE, 1), XhsSessionError);
    global.fetch = async () => response({}, 471);
    await assert.rejects(searchNotes('旅行', COOKIE, 1), /verification/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('公开页读取不携带 Cookie，并保留短链上的 xsec_token', async () => {
  const originalFetch = global.fetch;
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, redirect: init.redirect });
    if (calls.length === 1) {
      return response('', 302, { location: 'https://www.xiaohongshu.com/explore/64f000000000000000000001?xsec_token=share-token&xsec_source=pc_share' });
    }
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
  };
  try {
    const note = await fetchPublicNote('https://xhslink.com/a/test');
    assert.equal(note.noteId, '64f000000000000000000001');
    assert.equal(note.via, 'url');
    assert.match(note.url, /xsec_token=share-token/);
    assert.equal(calls[0].headers.cookie, undefined);
    assert.equal(calls[1].headers.cookie, undefined);
    assert.equal(calls[1].headers.accept, 'text/html,application/xhtml+xml');
  } finally {
    global.fetch = originalFetch;
  }
});

test('用户粘贴的 explore 链接会保留 xsec_token', async () => {
  const resolved = await resolveNoteUrl('https://www.xiaohongshu.com/explore/64f000000000000000000001?xsec_token=abc%2Bdef&xsec_source=pc_share');
  assert.equal(resolved.noteId, '64f000000000000000000001');
  assert.equal(resolved.xsecToken, 'abc+def');
  assert.match(resolved.url, /xsec_token=/);
});

test('xhslink 不跟随到 egress 外域名', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 302,
    headers: { get() { return 'https://evil.example/note'; } },
  });
  try {
    await assert.rejects(fetchPublicNote('https://xhslink.com/a/test'), /left the allowed hosts/);
  } finally {
    global.fetch = originalFetch;
  }
});
