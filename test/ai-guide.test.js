const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

const workspaceSdk = path.resolve(__dirname, '../../plugin-sdk/dist/cjs/index.js');
const sdk = require(fs.existsSync(workspaceSdk) ? workspaceSdk : 'trek-plugin-sdk');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'trek-plugin-sdk' ? sdk : originalLoad.call(this, request, parent, isMain);
};
const plugin = require('../server/index');
Module._load = originalLoad;
const { gateAndSchedule, normalizeCandidates, extractionText, extractionInstruction, isGenericPlaceName, publicDraft, placeSearchQuery } = require('../server/pipeline');
const { normalizeXhsCookie } = require('../server/xhs/session');
const { parseInitialState } = require('../server/xhs/url');
const { setGeoThrottleInterval, scoreRow, searchPlaces } = require('../server/geo/nominatim');

setGeoThrottleInterval(0);

const GRANTS = [
  'ai:invoke', 'db:own', 'db:create:trips', 'db:read:trips',
  'db:write:places', 'db:write:itinerary', 'db:meta', 'hook:user-data',
];

const NOMINATIM_ROWS = {
  京都: { name: 'Kyoto', lat: 35, lng: 135, category: 'boundary', type: 'administrative' },
  近点A: { name: 'Near A', lat: 35, lng: 135 },
  近点B: { name: 'Near B', lat: 35.01, lng: 135.01 },
  远点: { name: 'Far', lat: 36, lng: 136 },
  河南: { name: 'Henan', lat: 34.75, lng: 113.62, category: 'boundary', type: 'administrative' },
  河南省: { name: 'Henan', lat: 34.75, lng: 113.62, category: 'boundary', type: 'administrative' },
  龙门石窟: { name: 'Longmen Grottoes', lat: 34.55, lng: 112.47, category: 'tourism', type: 'attraction' },
  少林寺: { name: 'Shaolin Temple', lat: 34.51, lng: 112.94, category: 'tourism', type: 'attraction' },
  白马寺: { name: 'White Horse Temple', lat: 34.72, lng: 112.60, category: 'historic', type: 'temple' },
  清明上河园: { name: 'Millennium City Park', lat: 34.81, lng: 114.35, category: 'tourism', type: 'theme_park' },
};

function lookupGeoRow(query) {
  if (NOMINATIM_ROWS[query]) return NOMINATIM_ROWS[query];
  const head = query.split(/\s+/).filter(Boolean)[0];
  return (head && NOMINATIM_ROWS[head]) || null;
}

function stubGeoFetch(fallback) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith('https://nominatim.openstreetmap.org/')) {
      const query = new URL(href).searchParams.get('q') || '';
      calls.push(query);
      const row = lookupGeoRow(query);
      const body = row
        ? [{
          name: row.name,
          lat: String(row.lat),
          lon: String(row.lng),
          display_name: `${row.name}, fixture`,
          osm_id: 1000,
          category: row.category || 'tourism',
          type: row.type || 'attraction',
        }]
        : [];
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
      };
    }
    if (fallback) return fallback(url);
    throw new Error(`Unexpected fetch: ${href}`);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('manifest 声明 page 导航、LLM addon、最小权限与唯一用户 Cookie', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'trek-plugin.json'), 'utf8'));
  assert.equal(manifest.type, 'page');
  assert.equal(manifest.icon, 'Sparkles');
  assert.deepEqual(manifest.requiredAddons, ['llm_parsing']);
  assert.equal(manifest.nativeModules, false);
  assert.deepEqual(manifest.egress, ['www.xiaohongshu.com', 'edith.xiaohongshu.com', 'xhslink.com', 'nominatim.openstreetmap.org']);
  assert.ok(!manifest.permissions.includes('maps:read'));
  assert.ok(manifest.permissions.includes('http:outbound:nominatim.openstreetmap.org'));
  const cookieFields = manifest.settings.filter((field) => field.key === 'xhs_cookie');
  assert.deepEqual(cookieFields.map(({ scope, secret }) => ({ scope, secret })), [{ scope: 'user', secret: true }]);
});

function memoryDb() {
  const jobs = new Map();
  const api = {
    async migrate() { return { applied: true }; },
    async exec(sql, ...args) {
      if (sql.startsWith('INSERT INTO jobs')) {
        const [id, userId, status, stage, payloadJson, draftJson, workJson, createdAt, updatedAt] = args;
        jobs.set(id, {
          id, user_id: userId, status, stage, payload_json: payloadJson, draft_json: draftJson,
          work_json: workJson, error: null, committed_trip_id: null, created_at: createdAt, updated_at: updatedAt,
        });
        return { changes: 1 };
      }
      if (sql.startsWith('UPDATE jobs SET')) {
        const [status, stage, draftJson, workJson, error, tripId, updatedAt, id, userId] = args;
        const row = jobs.get(id);
        if (row && row.user_id === userId) Object.assign(row, {
          status, stage, draft_json: draftJson, work_json: workJson, error,
          committed_trip_id: tripId, updated_at: updatedAt,
        });
        return { changes: row ? 1 : 0 };
      }
      if (sql.startsWith('DELETE FROM jobs')) {
        let changes = 0;
        for (const [id, row] of jobs) if (row.user_id === args[0]) { jobs.delete(id); changes += 1; }
        return { changes };
      }
      throw new Error(`Unexpected exec: ${sql}`);
    },
    async query(sql, ...args) {
      const rows = [...jobs.values()];
      if (sql.includes('WHERE id = ? AND user_id = ?')) return rows.filter((row) => row.id === args[0] && row.user_id === args[1]);
      if (sql.includes("status IN ('queued', 'running')")) {
        return rows.filter((row) => row.user_id === args[0] && ['queued', 'running'].includes(row.status))
          .sort((a, b) => b.created_at - a.created_at).slice(0, 1);
      }
      if (sql.includes("status = 'ready'")) {
        return rows.filter((row) => row.user_id === args[0] && row.status === 'ready')
          .sort((a, b) => b.updated_at - a.updated_at).slice(0, 1);
      }
      if (sql.includes('WHERE user_id = ? ORDER BY created_at')) {
        return rows.filter((row) => row.user_id === args[0]).sort((a, b) => a.created_at - b.created_at);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async tx() { return { results: [] }; },
    jobs,
  };
  return api;
}

function buildHost(options = {}) {
  const trips = {};
  const host = sdk.createMockHost({
    grants: GRANTS,
    actingUserId: 7,
    config: { max_days: 8, max_places_per_day: 6, max_notes: 4, xhs_enabled: false },
    userSettings: {},
    aiResults: options.aiResults || [{
      intent: { destination: '京都' },
      candidates: [
        { name: 'Near A', nameZh: '近点A', dayHint: 1, durationMinutes: 60 },
        { name: 'Near B', nameZh: '近点B', dayHint: 1, durationMinutes: 75 },
        { name: 'Far', nameZh: '远点', dayHint: 1, durationMinutes: 90 },
        { name: 'Missing', nameZh: '无坐标店', dayHint: 1 },
      ],
    }, { candidates: [{ name: 'MUST NOT USE' }] }],
    aiText: 'Keep the day flexible.',
    trips,
  });
  const db = memoryDb();
  host.ctx.db = db;
  host.userlessCtx.db = db;
  const originalCreate = host.ctx.trips.create.bind(host.ctx.trips);
  host.ctx.trips.create = async (input) => {
    const trip = await originalCreate(input);
    trips[trip.id].days = Array.from({ length: input.day_count }, (_, index) => ({ id: index + 1, trip_id: trip.id }));
    return trip;
  };
  return { host, db, trips, app: host.run(plugin) };
}

async function makeReady(fixture, input = {}, fallback) {
  await fixture.app.load();
  const created = await fixture.app.route({ method: 'POST', path: '/plan' }, {
    body: { destination: '京都', dayCount: 2, pace: 'relaxed', locale: 'zh', ...input },
  });
  const jobId = created.body.jobId;
  const geo = stubGeoFetch(fallback);
  let state;
  try {
    for (let index = 0; index < 28; index += 1) {
      state = (await fixture.app.route({ method: 'GET', path: '/plan' }, { query: { jobId } })).body;
      if (state.status === 'ready' || state.status === 'failed') break;
    }
  } finally {
    geo.restore();
  }
  assert.equal(state.status, 'ready');
  return { jobId, state, geoCalls: geo.calls };
}

test('公开页夹具解析 undefined，并规范化 Cookie', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  const note = parseInitialState(html, '64f000000000000000000001');
  assert.equal(note.title, '京都五天不赶路');
  assert.match(note.text, /伏见稻荷/);
  assert.equal(normalizeXhsCookie('"sid=abc; a=1"'), 'sid=abc; a=1');
  assert.equal(normalizeXhsCookie('[{"name":"sid","value":"abc"},{"name":"a","value":"1"}]'), 'sid=abc; a=1');
  assert.equal(normalizeXhsCookie('{"name":"sid","value":"abc"}'), 'sid=abc');
});

test('Gate 丢弃无坐标/重复，并保留过远点且默认不选', () => {
  const evidence = [
    { id: 'ev_1', name: 'A', lat: 35, lng: 135, dayHint: 1 },
    { id: 'ev_dup', name: 'A', lat: 35, lng: 135, dayHint: 1 },
    { id: 'ev_2', name: 'B', lat: 36, lng: 136, dayHint: 1 },
    { id: 'ev_bad', name: 'Bad', lat: null, lng: null, dayHint: 1 },
  ];
  const result = gateAndSchedule(
    { dayCount: 1, pace: 'balanced', startDate: null },
    evidence,
    { maxPlacesPerDay: 6 },
    'zh',
    '',
  );
  assert.deepEqual(result.days[0].places.map((place) => place.evidenceId), ['ev_1', 'ev_2']);
  assert.equal(result.days[0].places[1].tooFar, true);
  assert.equal(result.days[0].places[1].selected, false);
  assert.equal(result.warnings.length, 2);
});

test('无攻略时抽取具体景点，丢掉省/市名，并把地点分到各天', () => {
  const intent = {
    destination: '河南',
    dayCount: 2,
    pace: 'relaxed',
    interests: ['历史'],
    mustSee: [],
  };
  const text = extractionText([], intent);
  assert.match(text, /Destination: 河南/);
  assert.match(text, /specific visitable places/);
  assert.match(extractionInstruction(intent, false), /No notes were supplied/);
  assert.equal(isGenericPlaceName('河南省', '河南'), true);
  assert.equal(isGenericPlaceName('河南', '河南省'), true);
  assert.equal(isGenericPlaceName('龙门石窟', '河南'), false);

  const candidates = normalizeCandidates({ candidates: [{ name: '河南省', dayHint: 1 }] }, intent);
  const names = candidates.map((item) => item.name);
  assert.ok(!names.includes('河南省'));
  assert.ok(!names.includes('历史'));
  assert.ok(names.includes('龙门石窟'));
  assert.ok(candidates.length >= 4);
  assert.deepEqual([...new Set(candidates.map((item) => item.dayHint))].sort(), [1, 2]);
  assert.equal(placeSearchQuery({ name: '龙门石窟' }, '河南'), '龙门石窟 河南');

  const gated = gateAndSchedule(
    intent,
    [
      { id: 'ev_1', name: '龙门石窟', lat: 34.55, lng: 112.47, dayHint: 1 },
      { id: 'ev_2', name: '少林寺', lat: 34.51, lng: 112.94, dayHint: 1 },
      { id: 'ev_3', name: '白马寺', lat: 34.72, lng: 112.60, dayHint: 1 },
      { id: 'ev_4', name: '清明上河园', lat: 34.81, lng: 114.35, dayHint: 1 },
    ],
    { maxPlacesPerDay: 6 },
    'zh',
    '',
  );
  assert.equal(gated.days.length, 2);
  assert.ok(gated.days[0].places.length >= 1);
  assert.ok(gated.days[1].places.length >= 1);
});

test('公开草稿始终带上来源说明', () => {
  const draft = publicDraft({
    id: 'job-1',
    status: 'ready',
    stage: 'ready',
    draft: {
      intent: { destination: '河南', guideQuery: '河南 历史 旅游 景点攻略', dayCount: 2 },
      guides: [],
      warnings: [],
      days: [],
    },
    work: {},
  });
  assert.equal(draft.sourceSummary.basis, 'destination');
  assert.match(draft.sourceSummary.query, /河南/);
  assert.deepEqual(draft.guides, []);
});

test('无 Cookie 的纯表单仍形成地图预览，并只使用 extract.results[0]', async () => {
  const fixture = buildHost();
  const { state, geoCalls } = await makeReady(fixture);
  assert.ok(state.days.flatMap((day) => day.places).length >= 3);
  assert.ok(state.warnings.some((warning) => warning.includes('Cookie')));
  assert.equal(state.sourceSummary.basis, 'destination');
  assert.ok(state.sourceSummary.query);
  assert.ok(fixture.host.calls.some((call) => call.method === 'ai.extract'));
  assert.ok(!geoCalls.includes('MUST NOT USE'));
  assert.ok(geoCalls.includes('京都'));
  const far = state.days.flatMap((day) => day.places).find((place) => place.name === 'Far');
  assert.equal(far.tooFar, true);
  assert.equal(far.selected, false);
  assert.ok(state.warnings.some((warning) => warning.includes('无坐标店')));
});

test('模型只返回省名时，仍补上具体景点、分到两天，并说明未读攻略', async () => {
  const fixture = buildHost({
    aiResults: [{ candidates: [{ name: '河南省', dayHint: 1 }] }],
  });
  const { state, geoCalls } = await makeReady(fixture, {
    destination: '河南',
    dayCount: 2,
    pace: 'relaxed',
    interests: '历史',
  });
  const places = state.days.flatMap((day) => day.places);
  const names = places.map((place) => place.name);
  assert.ok(!names.some((name) => /河南省?/.test(name)));
  assert.ok(places.length >= 3);
  assert.ok(state.days[0].places.length >= 1);
  assert.ok(state.days[1].places.length >= 1);
  assert.ok(geoCalls.some((query) => query.includes('龙门石窟')));
  assert.equal(state.guides.length, 0);
  assert.equal(state.sourceSummary.basis, 'destination');
  assert.match(state.sourceSummary.query, /河南/);
});

test('公开 URL 和粘贴正文进入同一预览，公开草稿不泄露正文', async () => {
  const fixture = buildHost();
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  const xhsFallback = () => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    async text() { return html; },
  });
  const { state } = await makeReady(fixture, {
    destination: '',
    urls: 'https://www.xiaohongshu.com/explore/64f000000000000000000001',
    sourceText: '清水寺值得清晨前往。',
  }, xhsFallback);
  assert.equal(state.intent.destination, '京都');
  assert.deepEqual(state.guides.map((guide) => guide.via).sort(), ['paste', 'url']);
  assert.equal(state.sourceSummary.basis, 'guides');
  assert.equal(JSON.stringify(state.guides).includes('第一天'), false);
});

test('commit 与草稿 evidenceIds 求交，只创建新行程和勾选地点', async () => {
  const fixture = buildHost();
  const { jobId, state } = await makeReady(fixture);
  const selectedId = state.days.flatMap((day) => day.places).find((place) => place.tooFar).evidenceId;
  const committed = await fixture.app.route({ method: 'POST', path: '/commit' }, {
    body: { jobId, title: '京都测试', evidenceIds: [selectedId, 'unknown'] },
  });
  assert.equal(committed.status, 200);
  assert.ok(committed.body.tripId);
  const createCalls = fixture.host.calls.filter((call) => call.method === 'places.create');
  const assignCalls = fixture.host.calls.filter((call) => call.method === 'itinerary.assign');
  assert.equal(createCalls.length, 1);
  assert.equal(assignCalls.length, 1);
  assert.ok(fixture.host.calls.some((call) => call.method === 'trips.create'));
  const order = fixture.host.calls.map((call) => call.method);
  assert.ok(order.indexOf('trips.create') < order.indexOf('trips.getDays'));
  assert.ok(order.indexOf('trips.getDays') < order.indexOf('places.create'));
  assert.ok(order.indexOf('places.create') < order.indexOf('itinerary.assign'));
  assert.ok(order.indexOf('itinerary.assign') < order.indexOf('meta.set'));
});

test('零个 evidenceId 不能 commit，空 Cookie testXhs 失败', async () => {
  const fixture = buildHost();
  const { jobId } = await makeReady(fixture);
  const committed = await fixture.app.route({ method: 'POST', path: '/commit' }, {
    body: { jobId, title: 'No places', evidenceIds: [] },
  });
  assert.equal(committed.status, 400);
  assert.deepEqual(await fixture.app.action('testXhs'), {
    ok: false,
    message: '未配置小红书 Cookie',
  });
});

test('再次生成会替换未完成任务，重新打开续跑最新任务', async () => {
  const fixture = buildHost();
  await fixture.app.load();
  const first = await fixture.app.route({ method: 'POST', path: '/plan' }, {
    body: { destination: '京都', locale: 'zh' },
  });
  const replacement = await fixture.app.route({ method: 'POST', path: '/plan' }, {
    body: { destination: '大阪', locale: 'zh' },
  });
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.body.jobId, first.body.jobId);
  const previous = await fixture.app.route({ method: 'GET', path: '/plan' }, { query: { jobId: first.body.jobId } });
  assert.equal(previous.body.status, 'failed');
  assert.match(String(previous.body.error || ''), /替换/);
  const reopened = fixture.host.run(plugin);
  const resumed = await reopened.route({ method: 'GET', path: '/plan' }, { query: {} });
  assert.equal(resumed.body.jobId, replacement.body.jobId);
  assert.equal(resumed.body.status, 'running');
});

test('同一规划步骤进行中时，第二次 GET /plan 不会重入', async () => {
  const fixture = buildHost();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = fixture.host.ctx.ai.extract.bind(fixture.host.ctx.ai);
  let extractCalls = 0;
  fixture.host.ctx.ai.extract = async (...args) => {
    extractCalls += 1;
    await gate;
    return original(...args);
  };
  await fixture.app.load();
  await fixture.app.route({ method: 'POST', path: '/plan' }, { body: { destination: '京都', locale: 'zh' } });
  for (let index = 0; index < 6; index += 1) {
    const state = (await fixture.app.route({ method: 'GET', path: '/plan' }, { query: {} })).body;
    if (state.stage === 'extract') break;
  }
  const first = fixture.app.route({ method: 'GET', path: '/plan' }, { query: {} });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await fixture.app.route({ method: 'GET', path: '/plan' }, { query: {} });
  assert.equal(second.body.stage, 'extract');
  assert.equal(extractCalls, 1);
  release();
  const finished = await first;
  assert.equal(finished.body.stage, 'gather_evidence');
  assert.equal(extractCalls, 1);
});

test('没有进行中的任务时，GET /plan 会恢复最近一份就绪预览', async () => {
  const fixture = buildHost();
  const { jobId } = await makeReady(fixture);
  const restored = await fixture.app.route({ method: 'GET', path: '/plan' }, { query: {} });
  assert.equal(restored.body.status, 'ready');
  assert.equal(restored.body.jobId, jobId);
});

test('deleteUserData 幂等清除该用户任务，export 不含 Cookie 或正文', async () => {
  const fixture = buildHost();
  await makeReady(fixture);
  const before = await fixture.app.exportUserData(7);
  assert.equal(JSON.stringify(before).includes('第一天'), false);
  assert.equal(JSON.stringify(before).toLowerCase().includes('cookie'), false);
  await fixture.app.deleteUserData(7);
  await fixture.app.deleteUserData(7);
  assert.equal(fixture.db.jobs.size, 0);
});

test('Nominatim 优先返回景点而不是行政区', async () => {
  assert.ok(scoreRow({ category: 'tourism', type: 'attraction', importance: 0.2 })
    > scoreRow({ category: 'boundary', type: 'administrative', importance: 0.9 }));
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    async json() {
      return [
        { name: 'Henan', lat: '34.75', lon: '113.62', display_name: 'Henan, China', category: 'boundary', type: 'administrative', addresstype: 'state', importance: 0.9 },
        { name: 'Longmen Grottoes', lat: '34.55', lon: '112.47', display_name: 'Longmen Grottoes, Luoyang', category: 'tourism', type: 'attraction', importance: 0.4 },
      ];
    },
  });
  try {
    const result = await searchPlaces('龙门石窟 河南', { lang: 'zh' });
    assert.equal(result.places[0].name, 'Longmen Grottoes');
  } finally {
    global.fetch = original;
  }
});
