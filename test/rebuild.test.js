const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

const {
  candidatesFromGuideText,
  splitRoutePlaceNames,
  matchDayHeader,
  inferDayCountFromGuides,
  normalizeInput,
  looksLikeShareCard,
  stripShareBoilerplate,
  resolveExtractCandidates,
} = require('../server/pipeline');
const {
  parseGuideLlmPayload,
  sanitizeTraceText,
  sanitizeTraceHeaders,
  buildAiTrace,
  invokeGuideLlm,
  classifyLlmError,
  collectGuideImageUrls,
  shouldTryMultimodal,
  extractFailureCopy,
  joinFailureCopy,
} = require('../server/llm');
const { parseInitialState, collectPublicImageUrls } = require('../server/xhs/url');

const workspaceSdk = path.resolve(__dirname, '../../plugin-sdk/dist/cjs/index.js');
const sdk = require(fs.existsSync(workspaceSdk) ? workspaceSdk : 'trek-plugin-sdk');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'trek-plugin-sdk' ? sdk : originalLoad.call(this, request, parent, isMain);
};
const plugin = require('../server/index');
Module._load = originalLoad;

const BEIJING_INTENT = { destination: '北京', dayCount: 2, pace: 'balanced', interests: [], mustSee: [] };
const LONGQUAN_INTENT = { destination: '龙泉', dayCount: 2, pace: 'balanced', interests: [], mustSee: [] };

test('A1 [一R]第一天 与横杠路线会拆成地点', () => {
  assert.deepEqual(matchDayHeader('[一R]第一天：天坛-故宫-景山'), { day: 1, rest: '天坛-故宫-景山' });
  assert.equal(matchDayHeader('📅第二天：颐和园').day, 2);
  assert.equal(matchDayHeader('Day1：陶溪川 -> 西街').day, 1);
  assert.deepEqual(
    splitRoutePlaceNames('[一R]第一天：天坛-故宫-景山', BEIJING_INTENT),
    ['天坛', '故宫', '景山'],
  );
  const parsed = candidatesFromGuideText([{
    id: 'g_syn_bj',
    title: '合成北京两日（夹具）',
    text: '[一R]第一天：天坛-故宫-景山\n[一R]第二天：1. 颐和园\n2) 北海',
  }], BEIJING_INTENT);
  const names = parsed.map((item) => item.name);
  assert.ok(names.includes('天坛'));
  assert.ok(names.includes('故宫'));
  assert.ok(names.includes('景山'));
  assert.ok(names.includes('颐和园'));
  assert.ok(names.includes('北海'));
  assert.equal(parsed.find((item) => item.name === '天坛').dayHint, 1);
  assert.equal(parsed.find((item) => item.name === '颐和园').dayHint, 2);
  assert.ok(!parsed.some((item) => item.name.includes('-')));
});

test('A4 龙泉风格 Day1：A → B 回归仍通过', () => {
  const text = 'Day1：龙泉青瓷博物馆 → 凤阳山\nDay2：安仁古街';
  assert.equal(inferDayCountFromGuides([{ title: '合成龙泉夹具', text }]), 2);
  const names = splitRoutePlaceNames('Day1：龙泉青瓷博物馆 → 凤阳山', LONGQUAN_INTENT);
  assert.deepEqual(names, ['龙泉青瓷博物馆', '凤阳山']);
  const parsed = candidatesFromGuideText([{ id: 'g_lq', title: '合成龙泉', text }], LONGQUAN_INTENT);
  assert.ok(parsed.some((item) => item.name === '龙泉青瓷博物馆' && item.dayHint === 1));
  assert.ok(parsed.some((item) => item.name === '凤阳山' && item.dayHint === 1));
  assert.ok(parsed.some((item) => item.name === '安仁古街' && item.dayHint === 2));
});

test('A2 打开【小红书】分享口令不会变成第二份正文', () => {
  const share = '打开【小红书】App 查看笔记 https://xhslink.cn/o/SYNTHETIC12 复制本条口令';
  assert.ok(looksLikeShareCard(share));
  const intent = normalizeInput(
    { destination: '北京', sourceText: share, dayCount: 1 },
    { maxDays: 14, maxPlacesPerDay: 6, maxNotes: 4 },
  );
  assert.deepEqual(intent.urls, ['https://xhslink.cn/o/SYNTHETIC12']);
  assert.equal(intent.sourceText, null);
  assert.equal(stripShareBoilerplate('打开【小红书】发现更多内容~ 天坛'), '天坛');
});

test('A3 分层失败文案可区分正文/模型/地理/权限', () => {
  assert.match(extractFailureCopy('body_parsed_0', 'zh'), /0 个地点/);
  assert.match(extractFailureCopy('llm_empty', 'zh'), /空候选/);
  assert.match(extractFailureCopy('geocode_0', 'zh'), /地理编码/);
  assert.match(extractFailureCopy('resource_forbidden', 'zh'), /RESOURCE_FORBIDDEN/);
  assert.match(extractFailureCopy('llm_auth', 'en'), /authentication failed/i);
  const joined = joinFailureCopy(['body_parsed_0', 'llm_empty', 'geocode_0'], 'zh');
  assert.match(joined, /正文规则/);
  assert.match(joined, /空候选/);
  assert.match(joined, /地理编码/);
  const resolved = resolveExtractCandidates({ candidates: [] }, [{
    id: 'g_empty',
    text: '今天天气真好，没有景点名。',
  }], BEIJING_INTENT);
  assert.equal(resolved.guideCandidateCount, 0);
  assert.ok(resolved.failKinds.includes('body_parsed_0'));
  assert.ok(resolved.failKinds.includes('llm_empty'));
});

test('B1/B3 解析 candidates JSON，空 content+reasoning 可回收，空两者不当成功', () => {
  const ok = parseGuideLlmPayload({
    text: JSON.stringify({ candidates: [{ name: '天坛', dayHint: 1 }] }),
  });
  assert.equal(ok.parsed.candidates[0].name, '天坛');
  assert.equal(ok.emptyContent, false);

  const recovered = parseGuideLlmPayload({
    text: '',
    reasoning_content: '```json\n{"candidates":[{"name":"故宫","dayHint":1}]}\n```',
  });
  assert.equal(recovered.recoveredFromReasoning, true);
  assert.equal(recovered.parsed.candidates[0].name, '故宫');

  const empty = parseGuideLlmPayload({ content: '', reasoning_content: 'thinking about the weather' });
  assert.equal(empty.parsed, null);
  assert.equal(empty.emptyContent, true);
  assert.equal(empty.recoveredFromReasoning, false);
});

test('B4 ai-trace 去掉 Cookie / Authorization / API key', () => {
  const trace = buildAiTrace({
    channel: 'outbound',
    prompt: 'Cookie: a1=secret; Authorization: Bearer sk-live\napi_key=abc',
    system: 'authorization: Bearer xyz',
    response: 'ok',
    imageUrls: ['https://sns-webpic-qc.xhscdn.com/fixture/route-card.jpg', 'data:image/png;base64,AAAA'],
    headers: { Authorization: 'Bearer sk-live', Cookie: 'a1=secret', 'content-type': 'application/json' },
  });
  assert.doesNotMatch(trace.prompt, /sk-live/);
  assert.doesNotMatch(trace.prompt, /a1=secret/);
  assert.doesNotMatch(JSON.stringify(trace), /sk-live/);
  assert.equal(trace.headers.Authorization, '[redacted]');
  assert.equal(trace.headers.Cookie, '[redacted]');
  assert.deepEqual(trace.imageUrls, ['https://sns-webpic-qc.xhscdn.com/fixture/route-card.jpg']);
  assert.match(sanitizeTraceText('Bearer sk-test-123'), /\[redacted\]/);
  assert.equal(sanitizeTraceHeaders({ 'x-api-key': 'nope' })['x-api-key'], '[redacted]');
});

test('M1 公开笔记只收集 https 图片 URL，失败可降级', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/note-route-card.html'), 'utf8');
  const note = parseInitialState(html, '64f000000000000000000099');
  assert.deepEqual(note.imageUrls, ['https://sns-webpic-qc.xhscdn.com/fixture/route-card.jpg']);
  assert.deepEqual(collectPublicImageUrls({ imageList: [{ url: 'http://insecure.example/a.jpg' }] }), []);
  const guides = [{ id: 'g_img', title: '合成', text: '路线在图里', imageUrls: note.imageUrls }];
  assert.equal(shouldTryMultimodal(guides, true), true);
  assert.equal(shouldTryMultimodal(guides, false), false);
  assert.deepEqual(collectGuideImageUrls(guides), note.imageUrls);

  const ctx = {
    ai: {
      async complete() {
        throw new Error('vision unavailable');
      },
    },
  };
  await assert.rejects(
    () => invokeGuideLlm(ctx, { multimodalNotes: true, llmMaxTokens: 256 }, {
      prompt: 'extract',
      system: 'json',
      imageUrls: note.imageUrls,
      allowMultimodal: true,
    }),
    /vision unavailable|empty content/i,
  );
});

test('B1 invokeGuideLlm 走 complete 且不调用 extract', async () => {
  const calls = [];
  const ctx = {
    ai: {
      async complete(prompt, system) {
        calls.push({ method: 'complete', prompt, system });
        return { text: JSON.stringify({ candidates: [{ name: '天坛', nameZh: '天坛', dayHint: 1 }] }) };
      },
      async extract() {
        calls.push({ method: 'extract' });
        return { results: [{ candidates: [{ name: 'SHOULD_NOT' }] }] };
      },
    },
  };
  const result = await invokeGuideLlm(ctx, { llmMaxTokens: 1024 }, {
    prompt: 'notes',
    system: 'extract places',
  });
  assert.equal(result.channel, 'host_complete');
  assert.equal(result.extracted.candidates[0].name, '天坛');
  assert.ok(result.traces[0].prompt);
  assert.equal(calls.some((call) => call.method === 'extract'), false);
  assert.match(calls[0].system, /NOT hotel\/flight reservations/i);
});

test('B3 推理-only 空 content 会重试，仍空则失败', async () => {
  let n = 0;
  const ctx = {
    ai: {
      async complete() {
        n += 1;
        return { text: '', reasoning_content: 'still thinking' };
      },
    },
  };
  await assert.rejects(
    () => invokeGuideLlm(ctx, { llmMaxTokens: 256 }, { prompt: 'x', system: 'y' }),
    /empty content/i,
  );
  assert.ok(n >= 2);
});

test('B1 出站 HTTPS 使用设置中的 key，trace 不含密钥', async () => {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    assert.match(String(url), /api\.deepseek\.com/);
    assert.match(init.headers.authorization, /Bearer test-key/);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ candidates: [{ name: '景山', dayHint: 1 }] }) } }],
        });
      },
    };
  };
  try {
    const result = await invokeGuideLlm({}, {
      llmApiBase: 'https://api.deepseek.com/v1',
      llmApiKey: 'test-key',
      llmModel: 'deepseek-chat',
      llmMaxTokens: 512,
    }, { prompt: 'places', system: 'json' });
    assert.equal(result.channel, 'outbound');
    assert.equal(result.extracted.candidates[0].name, '景山');
    assert.doesNotMatch(JSON.stringify(result.traces), /test-key/);
  } finally {
    global.fetch = original;
  }
});

test('classifyLlmError 识别 RESOURCE_FORBIDDEN', () => {
  const err = new Error('RESOURCE_FORBIDDEN: ai.complete requires ai:invoke');
  err.code = 'RESOURCE_FORBIDDEN';
  assert.equal(classifyLlmError(err), 'resource_forbidden');
});
