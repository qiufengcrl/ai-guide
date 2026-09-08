const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { get, ids } = require('../server/crawler/registry');
const cache = require('../server/xhs/cache');
const { setXhsThrottleForTests } = require('../server/xhs/throttle');

setXhsThrottleForTests({ baseIntervalMs: 0, jitterMs: 0, backoffDelayMs: 0 });

const VALID_COOKIE = `a1=${'a'.repeat(52)}; web_session=fixture-session; xsecappid=xhs-pc-web`;
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

function memoryCacheDb() {
  const notes = new Map();
  const comments = new Map();
  const key = (userId, noteId) => `${userId}::${noteId}`;
  return {
    async exec(sql, ...args) {
      if (/INSERT INTO xhs_note_cache/i.test(sql)) {
        notes.set(key(args[0], args[1]), { payload_json: args[2], fetched_at: args[3], user_id: args[0], note_id: args[1] });
        return { changes: 1 };
      }
      if (/INSERT INTO xhs_comment_cache/i.test(sql)) {
        comments.set(key(args[0], args[1]), { payload_json: args[2], fetched_at: args[3], user_id: args[0], note_id: args[1] });
        return { changes: 1 };
      }
      if (/DELETE FROM xhs_note_cache/i.test(sql)) {
        if (sql.includes('note_id')) return { changes: notes.delete(key(args[0], args[1])) ? 1 : 0 };
        let changes = 0;
        for (const [id, row] of notes) if (row.user_id === args[0]) { notes.delete(id); changes += 1; }
        return { changes };
      }
      if (/DELETE FROM xhs_comment_cache/i.test(sql)) {
        if (sql.includes('note_id')) return { changes: comments.delete(key(args[0], args[1])) ? 1 : 0 };
        let changes = 0;
        for (const [id, row] of comments) if (row.user_id === args[0]) { comments.delete(id); changes += 1; }
        return { changes };
      }
      throw new Error(`Unexpected exec: ${sql}`);
    },
    async query(sql, ...args) {
      const table = /xhs_comment_cache/.test(sql) ? comments : notes;
      const row = table.get(key(args[0], args[1]));
      return row ? [row] : [];
    },
    notes,
    comments,
  };
}

test('crawler registry 只注册 xhs，未知平台抛错', () => {
  assert.deepEqual(ids(), ['xhs']);
  const xhs = get('xhs');
  assert.equal(xhs.id, 'xhs');
  assert.equal(typeof xhs.search, 'function');
  assert.equal(typeof xhs.fetchNote, 'function');
  assert.equal(typeof xhs.fetchComments, 'function');
  assert.throws(() => get('douyin'), /Unknown crawler platform/);
});

test('笔记缓存按 user_id 隔离，过期后 miss', async () => {
  const db = memoryCacheDb();
  const ctx = { db };
  await cache.writeNote(ctx, 7, 'n1', { noteId: 'n1', title: '京都', text: '伏见稻荷', via: 'search' });
  const hit = await cache.readNote(ctx, 7, 'n1');
  assert.equal(hit.text, '伏见稻荷');
  assert.equal(await cache.readNote(ctx, 8, 'n1'), null);
  const row = [...db.notes.values()][0];
  row.fetched_at = Date.now() - cache.TTL_MS - 1;
  assert.equal(await cache.readNote(ctx, 7, 'n1'), null);
});

test('同一用户二次 fetchNote 走缓存，不重复打 feed', async () => {
  const xhs = get('xhs');
  const db = memoryCacheDb();
  const ctx = { db };
  const originalFetch = global.fetch;
  let feedCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/feed')) {
      feedCalls += 1;
      return response(fixture('note-detail.json'));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const item = { noteId: '64f000000000000000000001', xsecToken: 'tok', url: 'https://www.xiaohongshu.com/explore/64f000000000000000000001', via: 'search' };
    const first = await xhs.fetchNote(item, VALID_COOKIE, { ctx, userId: 7 });
    const second = await xhs.fetchNote(item, VALID_COOKIE, { ctx, userId: 7 });
    const other = await xhs.fetchNote(item, VALID_COOKIE, { ctx, userId: 8 });
    assert.match(first.text, /伏见稻荷/);
    assert.match(second.text, /伏见稻荷/);
    assert.equal(feedCalls, 2);
    assert.match(other.text, /伏见稻荷/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('评论缓存命中后不再请求 comment/page', async () => {
  const xhs = get('xhs');
  const db = memoryCacheDb();
  const ctx = { db };
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return response(fixture('comments.json'));
  };
  try {
    const first = await xhs.fetchComments('64f000000000000000000001', VALID_COOKIE, { ctx, userId: 7, maxComments: 10 });
    const second = await xhs.fetchComments('64f000000000000000000001', VALID_COOKIE, { ctx, userId: 7, maxComments: 10 });
    assert.ok(first.some((line) => /门票/.test(line)));
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
