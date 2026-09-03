const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { searchNotes, fetchSessionNote, XhsSessionError } = require('../server/xhs/session');
const { fetchPublicNote } = require('../server/xhs/url');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return String(body); },
    headers: { get() { return null; } },
  };
}

test('会话搜索只保留 model_type=note，并把 xsec_token 带到详情接口', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return calls.length === 1 ? response(fixture('search.json')) : response(fixture('note-detail.json'));
  };
  try {
    const notes = await searchNotes('京都 景点 旅游 景点攻略', 'sid=fixture', 4);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].xsecToken, 'fixture-token');
    const note = await fetchSessionNote(notes[0], 'sid=fixture');
    assert.match(note.text, /伏见稻荷/);
    assert.equal(calls[1].body.xsec_token, 'fixture-token');
    assert.equal(calls[1].body.source_note_id, '64f000000000000000000001');
  } finally {
    global.fetch = originalFetch;
  }
});

test('300011 或异常文案被识别为会话失效', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response({ success: false, code: 300011, msg: '账号异常' });
  try {
    await assert.rejects(searchNotes('旅行', 'sid=fixture', 1), XhsSessionError);
  } finally {
    global.fetch = originalFetch;
  }
});

test('xhslink 仅跟随到允许域名并读取公开页', async () => {
  const originalFetch = global.fetch;
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: false,
        status: 302,
        headers: { get(name) { return name === 'location' ? 'https://www.xiaohongshu.com/explore/64f000000000000000000001' : null; } },
      };
    }
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
  };
  try {
    const note = await fetchPublicNote('https://xhslink.com/a/test', '');
    assert.equal(note.noteId, '64f000000000000000000001');
    assert.equal(note.via, 'url');
  } finally {
    global.fetch = originalFetch;
  }
});

test('xhslink 不跟随到 egress 外域名', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 302,
    headers: { get() { return 'https://evil.example/note'; } },
  });
  try {
    await assert.rejects(fetchPublicNote('https://xhslink.com/a/test', ''), /left the allowed hosts/);
  } finally {
    global.fetch = originalFetch;
  }
});
