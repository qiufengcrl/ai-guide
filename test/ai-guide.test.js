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
const { gateAndSchedule, splitRegions, normalizeCandidates, candidatesFromGuideText, resolveExtractCandidates, normalizeInput, extractionText, extractionInstruction, isGenericPlaceName, isWeakPlaceName, publicDraft, placeSearchQuery, placeSearchNames, looksLikeShareCard, noteDisplayTitle, evidenceFromSearch, resolveXhsKeywordSearch, truthySetting, remainingXhsNoteSlots, message, mapConcurrent, progressForJob, inferDestinationFromGuides, mergeGuideTexts, isLowQualityPlace, sortDayPlacesByDistance, PLACE_SEARCH_ALIASES } = require('../server/pipeline');
const { normalizeXhsCookie, formatXhsWarning, formatXhsDegradedWarning, isXhsAuthError, XhsSessionError } = require('../server/xhs/session');
const { parseInitialState } = require('../server/xhs/url');
const { setGeoThrottleInterval, scoreRow, searchPlaces, isRateLimitError } = require('../server/geo/nominatim');
const {
  isXhsRateLimitError,
  withXhsRetry,
  xhsThrottle,
  xhsBackoffDelayMs,
  setXhsThrottleForTests,
  BASE_INTERVAL_MS,
  MAX_INTERVAL_MS,
} = require('../server/xhs/throttle');
const { readXhsCookieUpdatedAt } = require('../server/xhs/freshness');
const { isMarketingGuide, filterMarketingGuides, buildTrekPlaceNotes, extractCommentInsights, commentTipsForPlace, attachPreviewTips, extractPrepTips, categorizePrepTip } = require('../server/guide-quality');
const { buildTrekPlacePayload } = require('../server/trek-handoff');

setGeoThrottleInterval(0);
setXhsThrottleForTests({ baseIntervalMs: 0, jitterMs: 0, backoffDelayMs: 0 });

const GRANTS = [
  'ai:invoke', 'db:own', 'db:create:trips', 'db:read:trips', 'db:read:categories',
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

function stubGeoFetch(fallback, options = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith('https://nominatim.openstreetmap.org/')) {
      const query = new URL(href).searchParams.get('q') || '';
      calls.push(query);
      const row = options.exact ? NOMINATIM_ROWS[query] : lookupGeoRow(query);
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
  assert.deepEqual(manifest.egress, ['www.xiaohongshu.com', 'edith.xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'nominatim.openstreetmap.org', 'trek-amap-bridge']);
  assert.ok(manifest.permissions.includes('http:outbound:xhslink.cn'));
  assert.ok(!manifest.permissions.includes('maps:read'));
  assert.ok(manifest.permissions.includes('http:outbound:nominatim.openstreetmap.org'));
  assert.ok(manifest.permissions.includes('http:outbound:trek-amap-bridge'));
  const xhsEnabled = manifest.settings.find((field) => field.key === 'xhs_enabled');
  assert.equal(xhsEnabled.input_type, 'checkbox');
  assert.equal(xhsEnabled.default, false);
  assert.ok(!manifest.settings.some((field) => field.key === 'xhs_keyword_search'));
  const cookieFields = manifest.settings.filter((field) => field.key === 'xhs_cookie');
  assert.deepEqual(cookieFields.map(({ scope, secret }) => ({ scope, secret })), [{ scope: 'user', secret: true }]);
  const cookieUpdatedAt = manifest.settings.find((field) => field.key === 'xhs_cookie_updated_at');
  assert.equal(cookieUpdatedAt.scope, 'user');
  assert.equal(manifest.version, '1.1.35');
});

function memoryDb() {
  const jobs = new Map();
  const userMeta = new Map();
  const cookieClock = new Map();
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
      if (/INSERT INTO user_meta/i.test(sql)) {
        const [userId, at] = args;
        userMeta.set(userId, { user_id: userId, xhs_cookie_updated_at: at });
        return { changes: 1 };
      }
      if (/DELETE FROM user_meta/i.test(sql)) {
        const existed = userMeta.delete(args[0]);
        return { changes: existed ? 1 : 0 };
      }
      if (/INSERT INTO xhs_cookie_clock/i.test(sql)) {
        const [fp, userId, at] = args;
        const prev = cookieClock.get(fp) || {};
        cookieClock.set(fp, {
          fp,
          user_id: userId != null ? userId : prev.user_id,
          updated_at: at,
        });
        return { changes: 1 };
      }
      if (/DELETE FROM xhs_cookie_clock/i.test(sql)) {
        let changes = 0;
        for (const [fp, row] of cookieClock) {
          if (row.user_id === args[0]) { cookieClock.delete(fp); changes += 1; }
        }
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
      if (/FROM xhs_cookie_clock/i.test(sql)) {
        const row = cookieClock.get(args[0]);
        return row ? [row] : [];
      }
      if (/FROM user_meta/i.test(sql)) {
        const row = userMeta.get(args[0]);
        return row ? [row] : [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async tx() { return { results: [] }; },
    jobs,
    userMeta,
    cookieClock,
  };
  return api;
}

function buildHost(options = {}) {
  const trips = {};
  const host = sdk.createMockHost({
    grants: GRANTS,
    actingUserId: 7,
    config: { max_days: 8, max_places_per_day: 6, max_notes: 4, xhs_enabled: false, ...options.config },
    userSettings: options.userSettings || {},
    categories: options.categories,
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
  host.ctx.user = { id: 7 };
  const originalCreate = host.ctx.trips.create.bind(host.ctx.trips);
  host.ctx.trips.create = async (input) => {
    const trip = await originalCreate(input);
    trips[trip.id].days = Array.from({ length: input.day_count }, (_, index) => ({ id: index + 1, trip_id: trip.id }));
    return trip;
  };
  return { host, db, trips, app: host.run(plugin) };
}

async function makeReady(fixture, input = {}, fallback, geoOptions) {
  await fixture.app.load();
  const created = await fixture.app.route({ method: 'POST', path: '/plan' }, {
    body: { destination: '京都', dayCount: 2, pace: 'relaxed', locale: 'zh', ...input },
  });
  const jobId = created.body.jobId;
  const geo = stubGeoFetch(fallback, geoOptions);
  let state;
  try {
    for (let index = 0; index < 96; index += 1) {
      state = (await fixture.app.route({ method: 'GET', path: '/plan' }, { query: { jobId } })).body;
      if (state.status === 'ready' || state.status === 'failed') break;
      if (index % 2 === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
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

test('无攻略时过滤省/市名与兴趣词，mustSee 仍可补点', () => {
  const intent = {
    destination: '河南',
    dayCount: 2,
    pace: 'relaxed',
    interests: ['历史'],
    mustSee: ['龙门石窟'],
  };
  const text = extractionText([], intent);
  assert.match(text, /Destination: 河南/);
  assert.match(text, /specific visitable places/);
  assert.match(extractionInstruction(intent, false), /No notes were supplied/);
  assert.equal(isGenericPlaceName('河南省', '河南'), true);
  assert.equal(isGenericPlaceName('河南', '河南省'), true);
  assert.equal(isGenericPlaceName('龙门石窟', '河南'), false);
  assert.equal(isWeakPlaceName('历史', intent), true);
  assert.equal(isWeakPlaceName('龙门石窟', intent), false);

  const filtered = normalizeCandidates({ candidates: [{ name: '河南省', dayHint: 1 }] }, intent);
  assert.deepEqual(filtered.map((item) => item.name), ['龙门石窟']);
  assert.equal(placeSearchQuery({ name: '龙门石窟' }, '河南'), '龙门石窟 河南');

  const llmCandidates = normalizeCandidates({
    candidates: [
      { name: '龙门石窟', dayHint: 1 },
      { name: '少林寺', dayHint: 1 },
      { name: '白马寺', dayHint: 1 },
      { name: '清明上河园', dayHint: 1 },
    ],
  }, { ...intent, mustSee: [] });
  assert.ok(llmCandidates.length >= 4);
  assert.deepEqual([...new Set(llmCandidates.map((item) => item.dayHint))].sort(), [1, 2]);

  const evidence = [
    { id: 'ev_1', name: '龙门石窟', lat: 34.55, lng: 112.47, dayHint: 1, address: '河南省洛阳市洛龙区' },
    { id: 'ev_2', name: '少林寺', lat: 34.51, lng: 112.94, dayHint: 1, address: '河南省郑州市登封市' },
    { id: 'ev_3', name: '白马寺', lat: 34.72, lng: 112.60, dayHint: 1, address: '河南省洛阳市瀍河回族区' },
    { id: 'ev_4', name: '清明上河园', lat: 34.81, lng: 114.35, dayHint: 1, address: '河南省开封市龙亭区' },
  ];
  const split = splitRegions(intent, evidence, 'zh');
  assert.equal(split.regions.length, 2);
  assert.ok(split.regions.some((region) => /洛阳/.test(region.name)));
  assert.ok(split.regions.some((region) => /开封/.test(region.name)));
  assert.deepEqual([...new Set(evidence.filter((item) => item.id !== 'ev_4').map((item) => item.dayHint))], [1]);
  assert.equal(evidence.find((item) => item.id === 'ev_4').dayHint, 2);

  const gated = gateAndSchedule(
    intent,
    evidence,
    { maxPlacesPerDay: 6 },
    'zh',
    '',
  );
  assert.equal(gated.days.length, 2);
  assert.ok(gated.days[0].places.length >= 1);
  assert.ok(gated.days[1].places.length >= 1);
  assert.match(gated.days[0].title, /洛阳/);
  assert.match(gated.days[1].title, /开封/);
});

test('小范围景点不会被拆成多个区域', () => {
  const intent = { destination: '京都', dayCount: 2, pace: 'balanced' };
  const evidence = [
    { id: 'ev_1', name: 'Near A', lat: 35, lng: 135, dayHint: 1 },
    { id: 'ev_2', name: 'Near B', lat: 35.01, lng: 135.01, dayHint: 1 },
  ];
  const split = splitRegions(intent, evidence, 'zh');
  assert.equal(split.regions.length, 0);
  assert.equal(evidence[0].regionName, undefined);
});

test('LLM 返回空时从衡阳东洲岛攻略正文规则提取景点', () => {
  const intent = { destination: '衡阳', dayCount: 2, pace: 'balanced', interests: [], mustSee: [] };
  const guideText = `东洲岛是衡阳湘江上的一江心岛，与长沙橘子洲 、 岳阳君山并称湘江三大洲。
🗺️推荐路线：
廊桥登岛 → 船山书院 → 罗汉寺/三面观音 → 夫之楼登顶 → 环岛散步 → 欣赏夜景灯光/喷泉
▪️船山书院
晚清名臣彭玉麟捐建的书院。
▪️罗汉寺
岛上现存最古老的建筑之一。
▪️夫之楼
全岛的最高点。
▪️环岛步道与夜景
沿着4.2公里的环岛步道散步。`;
  const guides = [{ id: 'g_1', title: '📍衡阳｜东洲岛 游玩攻略📝', text: guideText }];
  const parsed = candidatesFromGuideText(guides, intent);
  const names = parsed.map((item) => item.name);
  assert.ok(names.includes('船山书院'));
  assert.ok(names.includes('罗汉寺'));
  assert.ok(names.includes('夫之楼'));
  assert.ok(!names.includes('廊桥登岛'));
  assert.ok(!names.includes('欣赏夜景'));

  const resolved = resolveExtractCandidates({ candidates: [] }, guides, intent);
  assert.equal(resolved.source, 'guide_text');
  assert.ok(resolved.candidates.some((item) => item.name === '船山书院'));
  assert.equal(resolved.candidates[0].guideId, 'g_1');
});

test('分享口令里的 xhslink.cn 会被抽成笔记链接，大兴安岭有具体景点', () => {
  const share = '上海出发5天4晚，追上大兴安岭的秋🍂 9月下旬看了圈机... https://xhslink.cn/o/4YIkUR0MNXN 进入【小红书】发现更多内容~';
  const intent = normalizeInput(
    { destination: '大兴安岭', sourceText: share, dayCount: 5, pace: 'relaxed' },
    { maxDays: 14, maxPlacesPerDay: 6, maxNotes: 4 },
  );
  assert.deepEqual(intent.urls, ['https://xhslink.cn/o/4YIkUR0MNXN']);
  assert.equal(placeSearchQuery({ name: '北极村' }, '大兴安岭'), '北极镇 漠河 大兴安岭');
  assert.deepEqual(placeSearchNames({ name: '洛古河' }, '大兴安岭')[0], '洛古河村 大兴安岭');
  assert.equal(isGenericPlaceName('漠河市', '大兴安岭'), false);
  assert.equal(isGenericPlaceName('河南省', '河南'), true);
  assert.ok(looksLikeShareCard(share));
  assert.equal(noteDisplayTitle({ title: '', text: '上海出发5天4晚，追上大兴安岭的秋\n正文' }, '小红书笔记'), '上海出发5天4晚，追上大兴安岭的秋');
  const candidates = normalizeCandidates({ candidates: [{ name: '大兴安岭' }] }, intent);
  assert.ok(!candidates.some((item) => item.name === '大兴安岭'));
  assert.equal(candidates.length, 0);
});

test('地图证据会丢掉远离目的地的误匹配', () => {
  const candidate = { name: '洛古河', durationMinutes: 90, dayHint: 1 };
  const bias = { lat: 52.3, lng: 124.7 };
  assert.equal(evidenceFromSearch(candidate, {
    source: 'nominatim',
    places: [{ name: '古塔', lat: 48.95, lng: 27.05, types: ['tourism'], address: '乌克兰' }],
  }, 0, '大兴安岭', bias), null);
  const labeled = evidenceFromSearch(candidate, {
    source: 'nominatim',
    places: [{ name: '北极镇', lat: 53.48, lng: 122.35, types: ['town'], address: '北极镇, 漠河市, 大兴安岭地区, 黑龙江省, 中国' }],
  }, 0, '大兴安岭', { lat: 43.0, lng: 118.0 });
  assert.equal(labeled.name, '北极镇');
  const near = evidenceFromSearch(candidate, {
    source: 'nominatim',
    places: [{ name: '洛古河村', lat: 53.3, lng: 122.35, types: ['village'], address: '洛古河村, 漠河市, 大兴安岭地区' }],
  }, 0, '大兴安岭', bias);
  assert.equal(near.name, '洛古河村');
});

test('组合检索无结果时下一拍改搜景点本名', async () => {
  NOMINATIM_ROWS['漠河'] = { name: '漠河', lat: 52.97, lng: 122.54, category: 'place', type: 'town' };
  try {
    const fixture = buildHost({
      aiResults: [{ candidates: [{ name: '漠河', dayHint: 1 }] }],
    });
    const { state, geoCalls } = await makeReady(fixture, {
      destination: '测试城',
      dayCount: 1,
    }, undefined, { exact: true });
    assert.ok(geoCalls.includes('漠河 测试城'));
    assert.ok(geoCalls.includes('漠河'));
    assert.ok(state.days.flatMap((day) => day.places).some((place) => /漠河/.test(place.name)));
  } finally {
    delete NOMINATIM_ROWS['漠河'];
  }
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
  assert.deepEqual(draft.prepTips, []);
});

test('无 Cookie 的纯表单仍形成地图预览，并只使用 extract.results[0]', async () => {
  const fixture = buildHost();
  const { state, geoCalls } = await makeReady(fixture);
  assert.ok(state.days.flatMap((day) => day.places).length >= 3);
  assert.ok(!state.warnings.some((warning) => warning.includes('Cookie')));
  assert.equal(state.sourceSummary.basis, 'destination');
  assert.ok(state.sourceSummary.query);
  assert.ok(fixture.host.calls.some((call) => call.method === 'ai.extract'));
  assert.ok(!geoCalls.includes('MUST NOT USE'));
  assert.ok(geoCalls.includes('京都'));
  assert.match(state.days[0].notes || '', /Near A/);
  const far = state.days.flatMap((day) => day.places).find((place) => place.name === 'Far');
  assert.equal(far.tooFar, true);
  assert.equal(far.selected, false);
  assert.ok(state.warnings.some((warning) => warning.includes('无坐标店')));
});

test('模型只返回省名时会被过滤，需靠 LLM/攻略给出具体景点', async () => {
  const fixture = buildHost({
    aiResults: [{ candidates: [
      { name: '龙门石窟', dayHint: 1 },
      { name: '少林寺', dayHint: 1 },
      { name: '白马寺', dayHint: 2 },
    ] }],
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

test('Cookie 搜索为空时给出说明，兴趣词不会变成景点', async () => {
  const fixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
    aiResults: [{ candidates: [
      { name: '龙门石窟', dayHint: 1 },
      { name: '少林寺', dayHint: 1 },
      { name: '白马寺', dayHint: 2 },
    ] }],
  });
  const xhsFallback = async (url) => {
    const href = String(url);
    if (href.includes('edith.xiaohongshu.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return { success: true, data: { items: [] } }; },
      };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  const { state } = await makeReady(fixture, {
    destination: '河南',
    dayCount: 2,
    pace: 'relaxed',
    interests: '历史',
    xhsKeywordSearch: true,
  }, xhsFallback);
  assert.ok(state.warnings.some((warning) => /没有返回笔记/.test(warning)));
  const names = state.days.flatMap((day) => day.places).map((place) => place.name);
  assert.ok(!names.includes('历史'));
  assert.ok(names.some((name) => /龙门|Longmen/i.test(name)));
  assert.ok(state.days.flatMap((day) => day.places).length >= 3);
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

test('粘贴 xhslink.cn 分享口令会拆出短链并读成链接笔记', async () => {
  const fixture = buildHost();
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  const share = '上海出发5天4晚，追上大兴安岭的秋🍂 9月下旬看了圈机... https://xhslink.cn/o/4YIkUR0MNXN 进入【小红书】发现更多内容~';
  const xhsFallback = (url) => {
    if (/xhslink\.cn/.test(String(url))) {
      return {
        ok: false,
        status: 302,
        headers: { get(name) { return name === 'location' ? 'https://www.xiaohongshu.com/discovery/item/64f000000000000000000001?xsec_token=tok' : null; } },
      };
    }
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
  };
  const { state } = await makeReady(fixture, { sourceText: share }, xhsFallback);
  assert.ok(!state.guides.some((guide) => guide.via === 'paste'));
  assert.ok(state.guides.some((guide) => guide.via === 'url' && guide.noteId === '64f000000000000000000001'));
  assert.equal(state.sourceSummary.noteCount, 1);
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
    message: '【认证失败】未配置小红书 Cookie',
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
  assert.ok(['queued', 'running'].includes(resumed.body.status));
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
  while (extractCalls === 0) {
    await fixture.app.route({ method: 'GET', path: '/plan' }, { query: {} });
  }
  assert.equal(extractCalls, 1);
  const overlapping = fixture.app.route({ method: 'GET', path: '/plan' }, { query: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(extractCalls, 1);
  release();
  await overlapping;
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

test('Places API bridge 会映射 Google 兼容响应为 WGS-84 坐标', async () => {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'http://trek-amap-bridge:8080/v1/places:searchText');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-goog-api-key'], 'amap-bridge');
    return {
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async json() {
        return {
          places: [{
            id: 'amap_test',
            displayName: { text: '故宫博物院' },
            formattedAddress: '景山前街4号, 北京市, 东城区',
            location: { latitude: 39.916435, longitude: 116.390784 },
            types: ['风景名胜'],
            businessStatus: 'OPERATIONAL',
          }],
        };
      },
    };
  };
  try {
    const result = await searchPlaces('故宫 北京', {
      lang: 'zh',
      placesApiBase: 'http://trek-amap-bridge:8080',
      placesApiKey: 'amap-bridge',
    });
    assert.equal(result.source, 'places');
    assert.equal(result.places[0].name, '故宫博物院');
    assert.ok(Math.abs(result.places[0].lat - 39.916435) < 0.001);
  } finally {
    global.fetch = original;
  }
});

test('关键词搜索默认关闭，需显式开启', () => {
  assert.equal(resolveXhsKeywordSearch(undefined), false);
  assert.equal(resolveXhsKeywordSearch(false), false);
  assert.equal(resolveXhsKeywordSearch(true), true);
  assert.equal(truthySetting('false'), false);
});

test('Prefs 接口返回管理员是否允许关键词搜索', async () => {
  const allowed = buildHost({ config: { xhs_enabled: true } });
  await allowed.app.load();
  const res = await allowed.app.route({ method: 'GET', path: '/prefs' }, {});
  assert.deepEqual(res.body, { xhsSearchAllowed: true });

  const blocked = buildHost({ config: { xhs_enabled: false } });
  await blocked.app.load();
  const denied = await blocked.app.route({ method: 'GET', path: '/prefs' }, {});
  assert.deepEqual(denied.body, { xhsSearchAllowed: false });
});

test('extract prompt 强调预约、避坑与中英名称', () => {
  const instruction = extractionInstruction({ destination: '京都', dayCount: 3 }, true);
  assert.match(instruction, /nameZh/);
  assert.match(instruction, /reservationRequired/);
  assert.match(instruction, /reason/);
  const text = extractionText([{ id: 'g_1', title: '测试', text: '需要提前预约故宫' }], {
    destination: '北京',
    dayCount: 2,
    pace: 'balanced',
    interests: ['历史'],
    mustSee: [],
  });
  assert.match(text, /reservationTips/);
  assert.match(text, /pitfalls/);
});

test('勾选搜索时会与链接和粘贴正文合并', async () => {
  const fixture = buildHost({
    config: { xhs_enabled: true, max_notes: 4 },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  const xhsFallback = (url) => {
    const href = String(url);
    if (href.includes('edith.xiaohongshu.com') && href.includes('search/notes')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() {
          return {
            success: true,
            data: {
              items: [{
                model_type: 'note',
                id: '64f000000000000000000002',
                xsec_token: 'tok2',
                note_card: { display_title: '搜索笔记' },
              }],
            },
          };
        },
      };
    }
    if (href.includes('edith.xiaohongshu.com') && href.includes('/feed')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() {
          return {
            success: true,
            data: { items: [{ note_card: { display_title: '搜索笔记', desc: '搜索正文内容' } }] },
          };
        },
      };
    }
    if (href.includes('xiaohongshu.com')) {
      return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return html; } };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  const { state } = await makeReady(fixture, {
    destination: '京都',
    urls: 'https://www.xiaohongshu.com/explore/64f000000000000000000001',
    sourceText: '清水寺值得清晨前往。',
    xhsKeywordSearch: true,
  }, xhsFallback);
  assert.deepEqual(state.guides.map((guide) => guide.via).sort(), ['paste', 'search', 'url']);
});

test('461 与 Cookie 失效会返回分级警告', async () => {
  const fixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  const authFallback = (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return { success: false, code: 300011, msg: '账号异常' }; },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const { state: authState } = await makeReady(fixture, {
    destination: '京都',
    xhsKeywordSearch: true,
  }, authFallback);
  assert.ok(authState.warnings.some((warning) => /【认证失败】/.test(warning)));

  const verifyFixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  const verifyFallback = (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      return { ok: false, status: 461, headers: { get() { return null; } }, async json() { return {}; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const { state: verifyState } = await makeReady(verifyFixture, {
    destination: '京都',
    xhsKeywordSearch: true,
  }, verifyFallback);
  assert.ok(verifyState.warnings.some((warning) => /【需要验证】/.test(warning)));
});

test('remainingXhsNoteSlots 会扣除已有笔记名额', () => {
  assert.equal(remainingXhsNoteSlots(
    [{ noteId: 'a' }, { noteId: 'b' }],
    [{ noteId: 'c' }],
    4,
  ), 1);
});

test('mapConcurrent 会并行处理任务', async () => {
  const order = [];
  const results = await mapConcurrent([1, 2, 3], 2, async (value) => {
    order.push(value);
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30]);
  assert.equal(order.length, 3);
});

test('progressForJob 会返回分阶段进度文案', () => {
  const job = {
    stage: 'fetch_guides',
    payload: { locale: 'zh' },
    draft: { guides: [], intent: { destination: '京都' } },
    work: { urls: ['a'], urlIndex: 0, searchAttempted: false, pendingNotes: [], noteIndex: 0 },
  };
  assert.match(progressForJob(job, 'zh'), /正在读取链接/);
  job.work.urlIndex = 1;
  job.stage = 'extract';
  assert.match(progressForJob(job, 'zh'), /提取景点/);
});

test('gateAndSchedule 会保留 photoUrl', () => {
  const gated = gateAndSchedule(
    { destination: '京都', dayCount: 1, pace: 'balanced', startDate: null },
    [{ id: 'ev_1', name: '清水寺', lat: 35, lng: 135, photoUrl: 'https://example.test/photo.jpg', dayHint: 1 }],
    { maxPlacesPerDay: 6 },
    'zh',
    '',
  );
  assert.equal(gated.days[0].places[0].photoUrl, 'https://example.test/photo.jpg');
});

test('衡阳景点别名与停车场降权', () => {
  assert.equal(PLACE_SEARCH_ALIASES['船山书院'], '衡阳东洲岛 船山书院');
  assert.equal(placeSearchQuery({ name: '夫之楼' }, '衡阳'), '衡阳东洲岛 夫之楼');
  assert.ok(isLowQualityPlace({ name: '船山书院停车场', types: ['parking'] }));
  const evidence = evidenceFromSearch(
    { name: '船山书院', durationMinutes: 60, dayHint: 1 },
    {
      source: 'places',
      places: [
        { name: '船山书院停车场', lat: 26.89, lng: 112.61, types: ['parking'], address: '衡阳市' },
        { name: '船山书院', lat: 26.894, lng: 112.615, types: ['风景名胜'], address: '衡阳市珠晖区东洲岛' },
      ],
    },
    0,
    '衡阳',
    { lat: 26.9, lng: 112.6 },
  );
  assert.equal(evidence.name, '船山书院');
});

test('同天内按距离排序减少折返', () => {
  const ordered = sortDayPlacesByDistance([
    { name: 'A', lat: 35, lng: 135 },
    { name: 'C', lat: 35.02, lng: 135.02 },
    { name: 'B', lat: 35.01, lng: 135.01 },
  ]);
  assert.deepEqual(ordered.map((item) => item.name), ['A', 'B', 'C']);
});

test('gateAndSchedule 会保留预约标记', () => {
  const gated = gateAndSchedule(
    { destination: '北京', dayCount: 1, pace: 'balanced', startDate: null },
    [{
      id: 'ev_1', name: '故宫', lat: 39.9, lng: 116.4, dayHint: 1,
      reservationRequired: true, reservationHint: '需提前预约',
    }],
    { maxPlacesPerDay: 6 },
    'zh',
    '',
  );
  assert.equal(gated.days[0].places[0].reservationRequired, true);
  assert.match(gated.days[0].places[0].reservationTips, /预约/);
});

test('可从笔记标题推断目的地并去重攻略', () => {
  assert.equal(inferDestinationFromGuides([{ title: '📍衡阳｜东洲岛 游玩攻略📝' }]), '衡阳');
  const merged = mergeGuideTexts([
    { id: 'g_1', noteId: 'n1', title: 'A', text: 'one' },
    { id: 'g_2', noteId: 'n1', title: 'A duplicate', text: 'two' },
    { id: 'g_3', noteId: 'n2', title: 'B', text: 'three' },
  ]);
  assert.equal(merged.length, 2);
});

test('publicDraft 会暴露 extractMeta', () => {
  const draft = publicDraft({
    id: 'job-1',
    status: 'running',
    stage: 'gather_evidence',
    draft: { intent: { destination: '衡阳' }, guides: [], warnings: [], days: [] },
    work: { extractMeta: { source: 'guide_text', llmCandidateCount: 0, llmError: null } },
  });
  assert.deepEqual(draft.extractMeta, { source: 'guide_text', llmCandidateCount: 0, llmError: null });
});

test('地图检索限流错误可被识别', () => {
  assert.equal(isRateLimitError(new Error('CUQPS has exceeded the limit')), true);
  assert.ok(scoreRow({ name: '停车场', category: 'amenity', type: 'parking' })
    < scoreRow({ name: '船山书院', category: 'tourism', type: 'attraction' }));
});

test('攻略正文含预约提示会标记 reservationRequired', () => {
  const guides = [{
    id: 'g_1',
    title: '北京攻略',
    text: '▪️故宫博物院\n需要提前预约，周末约满较快',
  }];
  const parsed = candidatesFromGuideText(guides, {
    destination: '北京',
    dayCount: 1,
    pace: 'balanced',
    interests: [],
    mustSee: [],
  });
  const palace = parsed.find((item) => /故宫/.test(item.name));
  assert.ok(palace);
  assert.equal(palace.reservationRequired, true);
  assert.match(palace.reservationTips, /预约/);
});

test('mergeGuideTexts 会按 url 去重', () => {
  const merged = mergeGuideTexts([
    { id: 'g_1', url: 'https://www.xiaohongshu.com/explore/abc', title: 'A', text: 'one' },
    { id: 'g_2', url: 'https://www.xiaohongshu.com/explore/abc', title: 'B', text: 'two' },
  ]);
  assert.equal(merged.length, 1);
});

test('splitRegions 聚类数超过天数时会合并', () => {
  const intent = { destination: '河南', dayCount: 2, pace: 'balanced' };
  const evidence = [
    { id: 'ev_1', name: '洛阳A', lat: 34.55, lng: 112.47, dayHint: 1, address: '河南省洛阳市' },
    { id: 'ev_2', name: '洛阳B', lat: 34.56, lng: 112.48, dayHint: 1, address: '河南省洛阳市' },
    { id: 'ev_3', name: '开封A', lat: 34.81, lng: 114.35, dayHint: 1, address: '河南省开封市' },
    { id: 'ev_4', name: '郑州A', lat: 34.75, lng: 113.62, dayHint: 1, address: '河南省郑州市' },
  ];
  const split = splitRegions(intent, evidence, 'zh');
  assert.ok(split.regions.length <= intent.dayCount);
});

test('Places API 会优先景点而不是停车场', async () => {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('/v1/places:searchText')) {
      assert.equal(init.method, 'POST');
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() {
          return {
            places: [
              {
                id: 'parking',
                displayName: { text: '船山书院停车场' },
                formattedAddress: '衡阳市',
                location: { latitude: 26.89, longitude: 112.61 },
                types: ['parking'],
                businessStatus: 'OPERATIONAL',
              },
              {
                id: 'sight',
                displayName: { text: '船山书院' },
                formattedAddress: '衡阳市珠晖区东洲岛',
                location: { latitude: 26.894, longitude: 112.615 },
                types: ['风景名胜', 'tourist_attraction'],
                businessStatus: 'OPERATIONAL',
              },
            ],
          };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  try {
    const result = await searchPlaces('船山书院 衡阳', {
      lang: 'zh',
      placesApiBase: 'http://trek-amap-bridge:8080',
      placesApiKey: 'amap-bridge',
    });
    assert.equal(result.places[0].name, '船山书院');
  } finally {
    global.fetch = original;
  }
});

test('commit 中途失败会回滚已写入地点', async () => {
  const fixture = buildHost();
  const { jobId, state } = await makeReady(fixture);
  const evidenceIds = state.days.flatMap((day) => day.places.map((place) => place.evidenceId));
  const deleted = [];
  const originalCreate = fixture.host.ctx.places.create.bind(fixture.host.ctx.places);
  let calls = 0;
  fixture.host.ctx.places.create = async (tripId, input) => {
    calls += 1;
    if (calls >= 2) throw new Error('write failed');
    return originalCreate(tripId, input);
  };
  fixture.host.ctx.places.delete = async (tripId, placeId) => {
    deleted.push(placeId);
    return { deleted: true };
  };
  const response = await fixture.app.route({ method: 'POST', path: '/commit' }, {
    body: { jobId, evidenceIds, locale: 'zh' },
  });
  assert.equal(response.status, 500);
  assert.equal(deleted.length, 1);
});

test('GET /plan 等待 tick 后会从数据库返回最新阶段', async () => {
  const fixture = buildHost();
  await fixture.app.load();
  const created = await fixture.app.route({ method: 'POST', path: '/plan' }, {
    body: { destination: '京都', locale: 'zh' },
  });
  const first = await fixture.app.route({ method: 'GET', path: '/plan' }, { query: { jobId: created.body.jobId } });
  const second = await fixture.app.route({ method: 'GET', path: '/plan' }, { query: { jobId: created.body.jobId } });
  assert.notEqual(first.body.stage, second.body.stage);
});

function restoreXhsThrottle() {
  setXhsThrottleForTests({ baseIntervalMs: 0, jitterMs: 0, backoffDelayMs: 0 });
}

test('isXhsRateLimitError 与 withXhsRetry：限流至少重试一次，认证错误不重试', async () => {
  assert.equal(isXhsRateLimitError(new Error('Xiaohongshu returned 429')), true);
  assert.equal(isXhsRateLimitError(new Error('请求过于频繁')), true);
  assert.equal(isXhsRateLimitError(new Error('Xiaohongshu requested verification (461)')), true);
  assert.equal(isXhsRateLimitError(new Error('CUQPS has exceeded the limit')), true);
  assert.equal(isXhsRateLimitError(new XhsSessionError('signed session code=300011', 'auth')), false);
  assert.equal(xhsBackoffDelayMs(0), 0);

  let rateCalls = 0;
  const retried = await withXhsRetry(async () => {
    rateCalls += 1;
    if (rateCalls === 1) throw new Error('Xiaohongshu returned 429');
    return 'ok';
  });
  assert.equal(retried, 'ok');
  assert.ok(rateCalls >= 2);

  let authCalls = 0;
  await assert.rejects(withXhsRetry(async () => {
    authCalls += 1;
    throw new XhsSessionError('Xiaohongshu rejected the signed session (code=300011)', 'auth');
  }), (error) => isXhsAuthError(error));
  assert.equal(authCalls, 1);
});

test('xhsThrottle 基础间隔与 penalize 加倍，三次成功后恢复', async () => {
  const sleeps = [];
  setXhsThrottleForTests({
    baseIntervalMs: BASE_INTERVAL_MS,
    maxIntervalMs: MAX_INTERVAL_MS,
    jitterMs: 0,
    backoffDelayMs: 0,
    now: () => 0,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  try {
    assert.equal(xhsThrottle.intervalMs, 3000);
    await xhsThrottle.wait();
    assert.equal(sleeps.length, 0);
    await xhsThrottle.wait();
    assert.equal(sleeps[0], 3000);
    xhsThrottle.penalize();
    assert.equal(xhsThrottle.intervalMs, 6000);
    xhsThrottle.penalize();
    assert.equal(xhsThrottle.intervalMs, 12000);
    xhsThrottle.penalize();
    assert.equal(xhsThrottle.intervalMs, 12000);
    xhsThrottle.recordSuccess();
    xhsThrottle.recordSuccess();
    assert.equal(xhsThrottle.intervalMs, 12000);
    xhsThrottle.recordSuccess();
    assert.equal(xhsThrottle.intervalMs, 6000);
    xhsThrottle.recordSuccess();
    xhsThrottle.recordSuccess();
    xhsThrottle.recordSuccess();
    assert.equal(xhsThrottle.intervalMs, 3000);
    assert.equal(xhsBackoffDelayMs(0), 0);
  } finally {
    restoreXhsThrottle();
  }
});

test('xhsBackoffDelayMs 生产值为 5s → 10s → 20s', () => {
  setXhsThrottleForTests({ baseIntervalMs: 0, jitterMs: 0 });
  try {
    assert.equal(xhsBackoffDelayMs(0), 5000);
    assert.equal(xhsBackoffDelayMs(1), 10000);
    assert.equal(xhsBackoffDelayMs(2), 20000);
  } finally {
    restoreXhsThrottle();
  }
});

test('Cookie 健康检查失败时跳过 signed API，粘贴路径仍 ready', async () => {
  const fixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  let edithCalls = 0;
  const authFallback = (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      edithCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return { success: false, code: 300011, msg: '账号异常' }; },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const { state } = await makeReady(fixture, {
    destination: '京都',
    sourceText: '清水寺值得清晨前往。金阁寺也很美。',
    xhsKeywordSearch: true,
  }, authFallback);
  assert.equal(state.status, 'ready');
  assert.ok(state.warnings.some((warning) => /【认证失败】/.test(warning)));
  assert.ok(state.guides.some((guide) => guide.via === 'paste'));
  assert.ok(!state.guides.some((guide) => guide.via === 'search'));
  assert.equal(edithCalls, 1);
  assert.ok(state.days.flatMap((day) => day.places).length >= 1);
});

test('Cookie 超过 7 天给出非阻断 warning', async () => {
  const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
  const fixture = buildHost({
    userSettings: {
      xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session`,
      xhs_cookie_updated_at: String(eightDaysAgo),
    },
  });
  const xhsFallback = (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return { success: true, data: { items: [] } }; },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const { state } = await makeReady(fixture, { destination: '京都', locale: 'zh' }, xhsFallback);
  assert.equal(state.status, 'ready');
  assert.ok(state.warnings.some((warning) => /超过 7 天/.test(warning)));
  assert.ok(state.days.flatMap((day) => day.places).length >= 1);
  assert.ok(!state.warnings.some((warning) => /中断/.test(warning) && /失败/.test(warning)));

  const enFixture = buildHost({
    userSettings: {
      xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session`,
      xhs_cookie_updated_at: String(eightDaysAgo),
    },
  });
  const { state: enState } = await makeReady(enFixture, { destination: '京都', locale: 'en' }, xhsFallback);
  assert.ok(enState.warnings.some((warning) => /more than 7 days/i.test(warning)));
});

test('限流降级文案区分认证与请求过快（中英），并说明继续/跳过搜索', () => {
  const authZh = formatXhsWarning(new XhsSessionError('signed session', 'auth'), 'zh', message, { scene: 'search' });
  const authEn = formatXhsWarning(new XhsSessionError('signed session', 'auth'), 'en', message, { scene: 'search' });
  assert.match(authZh, /【认证失败】/);
  assert.match(authZh, /插件设置/);
  assert.match(authZh, /跳过搜索/);
  assert.match(authEn, /【Auth failed】/);
  assert.match(authEn, /plugin settings/i);
  assert.match(authEn, /search was skipped/i);

  const rateZh = formatXhsWarning(new XhsSessionError('Xiaohongshu returned 429', 'fetch'), 'zh', message, { scene: 'search' });
  const rateEn = formatXhsWarning(new XhsSessionError('Xiaohongshu returned 429', 'fetch'), 'en', message, { scene: 'search' });
  assert.match(rateZh, /【请求过快】/);
  assert.match(rateZh, /跳过搜索|继续使用/);
  assert.match(rateEn, /【Rate limited】/);
  assert.match(rateEn, /search was skipped|continu/i);

  const signedZh = formatXhsWarning(new XhsSessionError('Xiaohongshu returned 429', 'fetch'), 'zh', message, { scene: 'signed' });
  assert.match(signedZh, /【请求过快】/);
  assert.doesNotMatch(signedZh, /已跳过搜索/);
  assert.doesNotMatch(signedZh, /关键词搜索/);
  const signedEn = formatXhsWarning(new XhsSessionError('Xiaohongshu returned 429', 'fetch'), 'en', message, { scene: 'signed' });
  assert.doesNotMatch(signedEn, /keyword search/i);

  const verifyZh = formatXhsDegradedWarning(new XhsSessionError('Xiaohongshu requested verification (461)', 'verification'), 'zh', message);
  const verifyEn = formatXhsDegradedWarning(new XhsSessionError('Xiaohongshu requested verification (461)', 'verification'), 'en', message);
  assert.match(verifyZh, /【需要验证】/);
  assert.match(verifyZh, /出口 IP|IP/);
  assert.match(verifyZh, /链接|粘贴|表单/);
  assert.match(verifyEn, /different IP|cloud host/i);
  assert.match(verifyEn, /skipped|links|pasted/i);
});

test('关键词搜索遇 429 会退避重试并降级继续表单路径', async () => {
  const fixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  let edithCalls = 0;
  const rateFallback = (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      edithCalls += 1;
      return { ok: false, status: 429, headers: { get() { return null; } }, async json() { return {}; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const { state } = await makeReady(fixture, {
    destination: '京都',
    xhsKeywordSearch: true,
    locale: 'zh',
  }, rateFallback);
  assert.equal(state.status, 'ready');
  assert.equal(edithCalls, 3);
  assert.ok(state.warnings.some((warning) => /请求过快|跳过搜索|继续使用/.test(warning)));
  assert.ok(state.days.flatMap((day) => day.places).length >= 1);
});

test('xhsThrottle penalize 按 Cookie 隔离，不影响其他用户', () => {
  setXhsThrottleForTests({
    baseIntervalMs: BASE_INTERVAL_MS,
    maxIntervalMs: MAX_INTERVAL_MS,
    jitterMs: 0,
    backoffDelayMs: 0,
  });
  try {
    const cookieA = `a1=${'a'.repeat(52)}; web_session=user-a`;
    const cookieB = `a1=${'b'.repeat(52)}; web_session=user-b`;
    xhsThrottle.penalize(cookieA);
    assert.equal(xhsThrottle.intervalMsFor(cookieA), 6000);
    assert.equal(xhsThrottle.intervalMsFor(cookieB), 3000);
    xhsThrottle.penalize('', 11);
    assert.equal(xhsThrottle.intervalMsFor('', 11), 6000);
    assert.equal(xhsThrottle.intervalMsFor('', 12), 3000);
  } finally {
    restoreXhsThrottle();
  }
});

test('readXhsCookieUpdatedAt 以 DB 为准，手填 settings 不能盖住旧值', async () => {
  const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
  const fresh = Date.now();
  const dbWins = {
    settings: { async get() { return String(eightDaysAgo); } },
    db: { async query() { return [{ xhs_cookie_updated_at: fresh }]; } },
  };
  assert.equal(await readXhsCookieUpdatedAt(dbWins, 7, ''), fresh);

  const settingsCannotHide = {
    settings: { async get() { return String(fresh); } },
    db: { async query() { return [{ xhs_cookie_updated_at: eightDaysAgo }]; } },
  };
  assert.equal(await readXhsCookieUpdatedAt(settingsCannotHide, 7, ''), eightDaysAgo);

  const futureSettings = {
    settings: { async get() { return String(Date.now() + 86400000); } },
    db: { async query() { return []; } },
  };
  assert.equal(await readXhsCookieUpdatedAt(futureSettings, 7, ''), 0);
});

test('POST /xhs/test 成功会写入 Cookie 时间戳', async () => {
  const fixture = buildHost({
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  delete fixture.host.ctx.user;
  await fixture.app.load();
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() {
          return {
            success: true,
            data: {
              items: [{
                model_type: 'note',
                id: '64f000000000000000000002',
                xsec_token: 'tok',
                note_card: { display_title: '旅行' },
              }],
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await fixture.app.route({ method: 'POST', path: '/xhs/test' }, { body: { locale: 'zh' } });
    assert.equal(result.body.ok, true);
    assert.ok(Number(fixture.db.userMeta.get(7)?.xhs_cookie_updated_at) > 0);
    assert.equal([...fixture.db.cookieClock.values()].every((row) => row.user_id === 7), true);
  } finally {
    global.fetch = original;
  }
});

test('设置页 testXhs 在无 userId 时不写无主 clock', async () => {
  const fixture = buildHost({
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  delete fixture.host.ctx.user;
  await fixture.app.load();
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return { success: true, data: { items: [] } }; },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await fixture.app.action('testXhs');
    assert.equal(result.ok, false);
    assert.equal(fixture.db.userMeta.size, 0);
    assert.equal(fixture.db.cookieClock.size, 0);
  } finally {
    global.fetch = original;
  }
});

test('设置页 testXhs 遇限流不重试，避免超过 TREK 15s action 超时', async () => {
  const fixture = buildHost({
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  await fixture.app.load();
  const original = global.fetch;
  let fetchCount = 0;
  global.fetch = async (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      fetchCount += 1;
      return {
        ok: false,
        status: 429,
        headers: { get() { return null; } },
        async json() { return {}; },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await fixture.app.action('testXhs');
    assert.equal(fetchCount, 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /请求过快/);
  } finally {
    global.fetch = original;
  }
});

test('settings 旧时间戳不会盖住健康检查写入的新值', async () => {
  const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
  const fixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: {
      xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session`,
      xhs_cookie_updated_at: String(eightDaysAgo),
    },
  });
  const xhsFallback = (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return { success: true, data: { items: [] } }; },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const first = await makeReady(fixture, {
    destination: '京都',
    locale: 'zh',
    xhsKeywordSearch: true,
  }, xhsFallback);
  assert.ok(first.state.warnings.some((warning) => /超过 7 天/.test(warning)));
  assert.ok(Number(fixture.db.userMeta.get(7)?.xhs_cookie_updated_at) > eightDaysAgo);

  const second = await makeReady(fixture, { destination: '京都', locale: 'zh' }, xhsFallback);
  assert.ok(!second.state.warnings.some((warning) => /超过 7 天/.test(warning)));
});

test('session 429 后剩余笔记改走公开页，且文案不再提关键词搜索', async () => {
  const fixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note.html'), 'utf8');
  let publicCalls = 0;
  const xhsFallback = (url) => {
    const href = String(url);
    if (href.includes('/search/notes')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() {
          return {
            success: true,
            data: {
              items: [
                { model_type: 'note', id: '64f000000000000000000001', xsec_token: 'tok', note_card: { display_title: '一' } },
                { model_type: 'note', id: '64f000000000000000000002', xsec_token: 'tok', note_card: { display_title: '二' } },
              ],
            },
          };
        },
      };
    }
    if (href.includes('edith.xiaohongshu.com')) {
      return { ok: false, status: 429, headers: { get() { return null; } }, async json() { return {}; } };
    }
    if (href.includes('xiaohongshu.com')) {
      publicCalls += 1;
      const body = href.includes('64f000000000000000000002')
        ? html.replaceAll('64f000000000000000000001', '64f000000000000000000002')
        : html;
      return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return body; } };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  const { state } = await makeReady(fixture, {
    destination: '京都',
    xhsKeywordSearch: true,
    locale: 'zh',
  }, xhsFallback);
  assert.equal(state.status, 'ready');
  assert.ok(publicCalls >= 2);
  assert.equal(state.guides.filter((guide) => guide.via === 'search' || guide.via === 'url').length, 2);
  assert.ok(state.warnings.some((warning) => /请求过快/.test(warning)));
  assert.equal(state.warnings.some((warning) => /请求过快/.test(warning) && /关键词搜索/.test(warning)), false);
});

test('deleteUserData 清除该用户 cookie clock', async () => {
  const fixture = buildHost({
    config: { xhs_enabled: true },
    userSettings: { xhs_cookie: `a1=${'a'.repeat(52)}; web_session=fixture-session` },
  });
  const xhsFallback = (url) => {
    if (String(url).includes('edith.xiaohongshu.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async json() { return { success: true, data: { items: [] } }; },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  await makeReady(fixture, { destination: '京都', xhsKeywordSearch: true, locale: 'zh' }, xhsFallback);
  assert.ok(fixture.db.cookieClock.size > 0);
  assert.ok([...fixture.db.cookieClock.values()].every((row) => row.user_id === 7));
  await fixture.app.deleteUserData(7);
  assert.equal(fixture.db.cookieClock.size, 0);
  assert.equal(fixture.db.userMeta.size, 0);
});

test('营销帖过滤与 TREK 地点备注构建', () => {
  assert.equal(isMarketingGuide({ title: '云南跟团私信定制', text: '加微信' }), true);
  assert.equal(isMarketingGuide({ title: '京都三日', text: '伏见稻荷清晨人少' }), false);
  const filtered = filterMarketingGuides([
    { title: '真实体验', text: '很好玩' },
    { title: '加微信定制游', text: '价格优惠' },
  ]);
  assert.equal(filtered.skipped, 1);
  assert.equal(filtered.guides.length, 1);
  const notes = buildTrekPlaceNotes({
    reason: '清晨人少',
    reservationRequired: true,
    reservationTips: '需提前预约',
    fromGuideIds: ['g_1'],
  }, [{
    id: 'g_1',
    title: '京都攻略',
    url: 'https://www.xiaohongshu.com/explore/abc',
    text: '门票需提前预约，周一闭馆',
  }], 'zh');
  assert.match(notes, /清晨人少/);
  assert.match(notes, /预约/);
  assert.match(notes, /出发前提示/);
  assert.match(notes, /来源/);
  const commentInsights = extractCommentInsights([
    '现在门票 60，建议提前预约',
    '加微信跟团',
    '周一闭馆别白跑',
  ]);
  assert.equal(commentInsights.length, 2);
  const placeTips = commentTipsForPlace('清水寺', [{
    id: 'g_1',
    commentInsights: ['清水寺早上人少', '京都巴士一日券划算'],
  }], ['g_1']);
  assert.ok(placeTips.length >= 1);
  const payload = buildTrekPlacePayload({
    name: '清水寺',
    lat: 35,
    lng: 135,
    address: '京都',
    reason: '清晨人少',
    photoUrl: 'https://example.test/photo.jpg',
    categoryHint: 'sight',
    stayMinutes: 90,
  }, [], { food: 5, sight: 2 }, 'zh');
  assert.equal(payload.category_id, 2);
  assert.equal(payload.image_url, 'https://example.test/photo.jpg');
  assert.equal(payload.duration_minutes, 90);
  assert.equal(payload.description, '清晨人少');
});

test('预览草稿会带上分类后的出发前提示', () => {
  assert.equal(categorizePrepTip('清水寺需提前预约'), 'booking');
  assert.equal(categorizePrepTip('穿衣建议带薄外套'), 'packing');
  assert.equal(categorizePrepTip('地铁交通卡很方便'), 'transit');
  const draft = attachPreviewTips({
    guides: [{
      id: 'g_1',
      text: '避坑：周一闭馆别白跑\n门票需提前预约\n穿衣建议带薄外套防晒\n地铁一日券划算\n签证和换汇提前准备',
    }],
    days: [{
      places: [{ name: '清水寺', fromGuideIds: ['g_1'] }],
    }],
  });
  assert.ok(draft.prepTips.length >= 3);
  assert.ok(draft.prepTips.some((tip) => tip.category === 'booking'));
  assert.ok(draft.prepTips.some((tip) => /闭馆|预约|穿衣|交通|签证/.test(tip.text)));
  assert.ok(draft.days[0].places[0].prepTips.length >= 1);
  const extracted = extractPrepTips(draft.guides, 8);
  assert.ok(extracted.length >= 3);
});

test('粘贴攻略生成的预览会带上 prepTips', async () => {
  const fixture = buildHost({
    aiResults: [{
      intent: { destination: '京都' },
      candidates: [
        { name: 'Near A', nameZh: '近点A', dayHint: 1, durationMinutes: 60, reason: '清晨人少', guideId: 'g_1' },
        { name: 'Near B', nameZh: '近点B', dayHint: 1, durationMinutes: 75, guideId: 'g_1' },
      ],
    }],
  });
  const { state } = await makeReady(fixture, {
    destination: '京都',
    sourceText: '避坑：周一闭馆别白跑\n门票需提前预约\n穿衣建议带薄外套',
    locale: 'zh',
  });
  assert.ok(Array.isArray(state.prepTips));
  assert.ok(state.prepTips.length >= 2);
  assert.ok(state.prepTips.some((tip) => /闭馆|预约|穿衣/.test(tip.text)));
});

test('营销景点候选会被过滤', () => {
  const intent = { destination: '京都', dayCount: 2, pace: 'balanced', interests: [], mustSee: [] };
  const candidates = normalizeCandidates({
    candidates: [{ name: '清水寺', reason: '加微信报名跟团', dayHint: 1 }],
  }, intent);
  assert.equal(candidates.length, 0);
});

test('commit 写入 TREK 分类与配图字段', async () => {
  const fixture = buildHost({
    categories: [
      { id: 2, name: 'Sightseeing', icon: 'MapPin' },
      { id: 5, name: 'Food', icon: 'Utensils' },
    ],
    aiResults: [{
      intent: { destination: '京都' },
      candidates: [
        { name: 'Near A', nameZh: '近点A', dayHint: 1, durationMinutes: 60, reason: '清晨人少，适合拍照' },
        { name: 'Near B', nameZh: '近点B', dayHint: 1, durationMinutes: 75 },
        { name: 'Far', nameZh: '远点', dayHint: 1, durationMinutes: 90 },
        { name: 'Missing', nameZh: '无坐标店', dayHint: 1 },
      ],
    }, { candidates: [{ name: 'MUST NOT USE' }] }],
  });
  const { jobId, state } = await makeReady(fixture);
  const place = state.days.flatMap((day) => day.places).find((item) => !item.tooFar);
  const evidenceId = place.evidenceId;
  const committed = await fixture.app.route({ method: 'POST', path: '/commit' }, {
    body: { jobId, title: '京都测试', evidenceIds: [evidenceId] },
  });
  assert.equal(committed.status, 200);
  const created = fixture.trips[committed.body.tripId].places[0];
  assert.equal(created.category_id, 2);
  assert.match(String(created.notes || ''), /清晨人少/);
  assert.equal(created.description, '清晨人少，适合拍照');
});

