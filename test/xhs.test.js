const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { searchNotes, fetchSessionNote, formatXhsWarning, isXhsAuthError, isXhsVerificationError, XhsSessionError } = require('../server/xhs/session');
const { createSignedPost, parseCookieHeader } = require('../server/xhs/signature');
const { extractXhsUrls, fetchPublicNote } = require('../server/xhs/url');
const { setXhsThrottleForTests, isXhsRateLimitError } = require('../server/xhs/throttle');

setXhsThrottleForTests({ baseIntervalMs: 0, jitterMs: 0, backoffDelayMs: 0 });

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const VALID_COOKIE = `a1=${'a'.repeat(52)}; web_session=fixture-session; xsecappid=xhs-pc-web`;

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
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return calls.length === 1 ? response(fixture('search.json')) : response(fixture('note-detail.json'));
  };
  try {
    const notes = await searchNotes('京都 景点 旅游 景点攻略', VALID_COOKIE, 4);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].xsecToken, 'fixture-token');
    assert.match(notes[0].url, /xsec_token=fixture-token/);
    const note = await fetchSessionNote(notes[0], VALID_COOKIE);
    assert.match(note.text, /伏见稻荷/);
    assert.match(calls[0].headers['x-s'], /^XYS_/);
    assert.match(calls[0].headers['x-s-common'], /^[A-Za-z0-9+/=]+$/);
    assert.match(calls[0].headers['x-t'], /^\d{13}$/);
    assert.match(calls[0].headers['x-b3-traceid'], /^[a-f0-9]{16}$/);
    assert.match(calls[0].headers['x-xray-traceid'], /^[a-f0-9]{32}$/);
    assert.equal(calls[0].headers.origin, 'https://www.xiaohongshu.com');
    assert.equal(calls[0].body.page_size, 20);
    assert.equal(calls[0].body.search_id.length, 21);
    assert.equal(calls[0].body.filters.length, 5);
    assert.equal(calls[1].body.xsec_token, 'fixture-token');
    assert.equal(calls[1].body.source_note_id, '64f000000000000000000001');
  } finally {
    global.fetch = originalFetch;
  }
});

test('搜索结果可从 note_card.note_id 解析，并忽略非笔记条目', () => {
  const { parseSearchNotes } = require('../server/xhs/session');
  const notes = parseSearchNotes({
    data: {
      items: [
        { model_type: 'user', id: 'u1' },
        { model_type: 'note', note_card: { note_id: '64f000000000000000000099', display_title: '洛阳两日' }, xsec_token: 'tok' },
        { note_card: { id: 'bad' } },
      ],
    },
  }, 4);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].noteId, '64f000000000000000000099');
  assert.equal(notes[0].title, '洛阳两日');
  assert.equal(notes[0].xsecToken, 'tok');
  assert.match(notes[0].url, /xsec_token=tok/);
});

test('300011 或异常文案被识别为会话失效', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response({ success: false, code: 300011, msg: '账号异常' });
  try {
    await assert.rejects(searchNotes('旅行', VALID_COOKIE, 1), (error) => {
      assert.match(error.message, /signed session.*300011/);
      assert.equal(error.code, 'auth');
      return true;
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('461 被识别为验证错误并格式化警告', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 461, headers: { get() { return null; } }, async json() { return {}; } });
  try {
    await assert.rejects(searchNotes('旅行', VALID_COOKIE, 1), (error) => {
      assert.equal(error.code, 'verification');
      return true;
    });
    const warning = formatXhsWarning(new XhsSessionError('Xiaohongshu requested verification (461)', 'verification'), 'zh', (locale, zh) => zh);
    assert.match(warning, /【需要验证】/);
    assert.ok(isXhsVerificationError(new XhsSessionError('461', 'verification')));
    assert.ok(isXhsAuthError(new XhsSessionError('bad cookie', 'auth')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('签名请求绑定同一 payload、时间戳和完整 Cookie', () => {
  const timestamp = 1788490800123;
  const payload = { keyword: '旅行', page: 1 };
  const signed = createSignedPost('/api/sns/web/v1/search/notes', payload, VALID_COOKIE, { timestamp });
  assert.deepEqual(JSON.parse(signed.body), payload);
  assert.equal(signed.headers['x-t'], String(timestamp));
  assert.match(signed.headers['x-s'], /^XYS_/);
  assert.ok(signed.headers['x-s-common'].length > 100);
  assert.match(signed.headers.cookie, /web_session=fixture-session/);
  assert.deepEqual(parseCookieHeader('a=1; token=x=y=z'), { __proto__: null, a: '1', token: 'x=y=z' });
});

test('缺少 a1 或 web_session 时在发出网络请求前拒绝', async () => {
  await assert.rejects(searchNotes('旅行', 'web_session=fixture', 1), /missing the a1 value/);
  await assert.rejects(searchNotes('旅行', `a1=${'a'.repeat(52)}`, 1), /missing the web_session value/);
});

test('xhslink.cn 分享口令会抽出短链并跟随到笔记页', async () => {
  const share = '上海出发5天4晚，追上大兴安岭的秋🍂 9月下旬看了圈机... https://xhslink.cn/o/4YIkUR0MNXN 进入【小红书】发现更多内容~';
  assert.deepEqual(extractXhsUrls('', share), ['https://xhslink.cn/o/4YIkUR0MNXN']);
  const originalFetch = global.fetch;
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  let call = 0;
  global.fetch = async (url) => {
    call += 1;
    if (call === 1) {
      assert.match(String(url), /xhslink\.cn/);
      return {
        ok: false,
        status: 302,
        headers: { get(name) { return name === 'location' ? 'https://www.xiaohongshu.com/discovery/item/64f000000000000000000001?xsec_token=tok' : null; } },
      };
    }
    assert.match(String(url), /explore\/64f000000000000000000001/);
    assert.match(String(url), /xsec_token=tok/);
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
  };
  try {
    const note = await fetchPublicNote('https://xhslink.cn/o/4YIkUR0MNXN');
    assert.equal(note.noteId, '64f000000000000000000001');
    assert.equal(note.via, 'url');
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
    const note = await fetchPublicNote('https://xhslink.com/a/test');
    assert.equal(note.noteId, '64f000000000000000000001');
    assert.equal(note.via, 'url');
  } finally {
    global.fetch = originalFetch;
  }
});

test('xhslink 在运行时已跟随跳转时仍能读出笔记页', async () => {
  const originalFetch = global.fetch;
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        url: 'https://www.xiaohongshu.com/discovery/item/64f000000000000000000001?xsec_token=tok',
        headers: { get() { return null; } },
        async text() { return html; },
      };
    }
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
  };
  try {
    const note = await fetchPublicNote('https://xhslink.cn/o/followed');
    assert.equal(note.noteId, '64f000000000000000000001');
    assert.equal(note.via, 'url');
  } finally {
    global.fetch = originalFetch;
  }
});

test('公开页读取不携带 Cookie', async () => {
  const originalFetch = global.fetch;
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
  };
  try {
    await require('../server/xhs/url').fetchPublicNote('https://www.xiaohongshu.com/explore/64f000000000000000000001?xsec_token=abc%2Bdef');
    assert.equal(calls[0].headers.cookie, undefined);
    assert.match(calls[0].url, /xsec_token=/);
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
    await assert.rejects(fetchPublicNote('https://xhslink.com/a/test'), /left the allowed hosts/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('session 笔记 429 会重试 signed feed，并保留公开页兜底', async () => {
  const originalFetch = global.fetch;
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'note.html'), 'utf8');
  let signedCalls = 0;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('edith.xiaohongshu.com')) {
      signedCalls += 1;
      return { ok: false, status: 429, headers: { get() { return null; } }, async json() { return {}; } };
    }
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
  };
  try {
    await assert.rejects(
      fetchSessionNote({
        noteId: '64f000000000000000000001',
        xsecToken: 'tok',
        url: 'https://www.xiaohongshu.com/explore/64f000000000000000000001',
      }, VALID_COOKIE),
      (error) => {
        assert.equal(isXhsRateLimitError(error), true);
        assert.equal(error.fallbackNote.noteId, '64f000000000000000000001');
        return true;
      },
    );
    assert.ok(signedCalls >= 2);
  } finally {
    global.fetch = originalFetch;
  }
});
