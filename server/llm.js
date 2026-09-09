'use strict';

const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'object',
      properties: {
        destination: { type: 'string' },
      },
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          nameZh: { type: 'string' },
          nameEn: { type: 'string' },
          reason: { type: 'string' },
          durationMinutes: { type: 'number' },
          reservationRequired: { type: 'boolean' },
          reservationTips: { type: 'string' },
          dayHint: { type: 'number' },
          guideId: { type: 'string' },
        },
        required: ['name'],
      },
    },
    budget: {
      type: 'object',
      properties: {
        currency: { type: 'string' },
        economy: { type: 'object' },
        comfort: { type: 'object' },
        luxury: { type: 'object' },
      },
    },
  },
  required: ['candidates'],
};

const TRACE_PROMPT_MAX = 8000;
const TRACE_RESPONSE_MAX = 8000;
const TRACE_SYSTEM_MAX = 2000;
const SECRET_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const SECRET_TEXT_RE = /(authorization\s*[:=]\s*)\S+|((?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)\S+|(cookie\s*[:=]\s*)[^\n]+|bearer\s+[a-z0-9._\-+=\/]+/gi;
const OUTBOUND_EGRESS_HOSTS = new Set(['api.deepseek.com', 'api.openai.com']);

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function truncate(text, max) {
  const raw = String(text || '');
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}\n…[truncated ${raw.length - max} chars]`;
}

function sanitizeTraceText(value) {
  return String(value == null ? '' : value).replace(SECRET_TEXT_RE, (match, a, b, c) => {
    if (a) return `${a}[redacted]`;
    if (b) return `${b}[redacted]`;
    if (c) return `${c}[redacted]`;
    return '[redacted]';
  });
}

function sanitizeTraceHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_HEADER_RE.test(key)) out[key] = '[redacted]';
    else out[key] = sanitizeTraceText(value);
  }
  return out;
}

function buildAiTrace(entry) {
  const imageUrls = (entry.imageUrls || []).filter(isHttpsUrl).slice(0, 8);
  return {
    at: Date.now(),
    channel: entry.channel || 'unknown',
    prompt: truncate(sanitizeTraceText(entry.prompt), TRACE_PROMPT_MAX),
    system: truncate(sanitizeTraceText(entry.system), TRACE_SYSTEM_MAX),
    response: truncate(sanitizeTraceText(entry.response), TRACE_RESPONSE_MAX),
    emptyContent: entry.emptyContent === true,
    recoveredFromReasoning: entry.recoveredFromReasoning === true,
    retry: entry.retry === true,
    imageUrls,
    headers: sanitizeTraceHeaders(entry.headers),
  };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeCompletePayload(result) {
  if (result == null) return { content: '', reasoning: '' };
  if (typeof result === 'string') return { content: result, reasoning: '' };
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  const message = choice?.message || result.message || result;
  let content = result.text ?? result.content ?? message?.content ?? '';
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  const reasoning = String(
    result.reasoning_content
    || message?.reasoning_content
    || choice?.reasoning_content
    || '',
  );
  return { content: String(content || ''), reasoning };
}

function parseGuideLlmPayload(result) {
  const { content, reasoning } = normalizeCompletePayload(result);
  const fromContent = extractJsonObject(content);
  if (fromContent && typeof fromContent === 'object') {
    return {
      parsed: fromContent,
      emptyContent: !String(content).trim(),
      recoveredFromReasoning: false,
      content,
      reasoning,
    };
  }
  if (!String(content).trim() && reasoning) {
    const fromReasoning = extractJsonObject(reasoning);
    if (fromReasoning && typeof fromReasoning === 'object') {
      return {
        parsed: fromReasoning,
        emptyContent: true,
        recoveredFromReasoning: true,
        content,
        reasoning,
      };
    }
  }
  return {
    parsed: null,
    emptyContent: !String(content).trim(),
    recoveredFromReasoning: false,
    content,
    reasoning,
  };
}

function isForbiddenError(error) {
  const msg = String(error?.message || error || '');
  const code = String(error?.code || error?.name || '');
  return /RESOURCE_FORBIDDEN|PERMISSION_DENIED/i.test(msg)
    || /RESOURCE_FORBIDDEN|PERMISSION_DENIED/i.test(code);
}

function isLlmAuthError(error) {
  if (isForbiddenError(error)) return true;
  const msg = String(error?.message || error || '');
  return /\b401\b|\b403\b|unauthorized|invalid api key|incorrect api key/i.test(msg);
}

function classifyLlmError(error) {
  if (!error) return null;
  if (isForbiddenError(error)) return 'resource_forbidden';
  if (isLlmAuthError(error)) return 'llm_auth';
  return 'llm_error';
}

function extractFailureCopy(kind, locale, extra = {}) {
  const zh = String(locale || '').toLowerCase().startsWith('zh');
  const detail = extra.detail ? `（${extra.detail}）` : '';
  const detailEn = extra.detail ? ` (${extra.detail})` : '';
  switch (kind) {
    case 'body_parsed_0':
      return zh
        ? '攻略正文规则解析到 0 个地点。请检查是否有「第N天 / DayN」标题和用 → 或 - 分隔的路线。'
        : 'Rule parsing found 0 places in the guide body. Check for Day N headers and routes separated by → or -.';
    case 'llm_empty':
      return zh
        ? '模型返回了空候选（content 为空或不含地点 JSON）。已跳过预订抽取路径，请确认 llm_parsing 使用非推理模型或提高 max_tokens。'
        : 'The model returned empty candidates (no content or no place JSON). Reservation extract was not used. Prefer a non-reasoning model or raise max_tokens.';
    case 'llm_auth':
      return zh
        ? `模型认证失败${detail}。请检查 TREK AI 供应商或插件里的 llm_api_key。`
        : `Model authentication failed${detailEn}. Check the TREK AI provider or the plugin llm_api_key.`;
    case 'resource_forbidden':
      return zh
        ? `模型调用被拒绝 RESOURCE_FORBIDDEN${detail}。需要 ai:invoke，且不要走预订 extract。`
        : `Model call was refused RESOURCE_FORBIDDEN${detailEn}. ai:invoke is required; reservation extract is not used.`;
    case 'geocode_0':
      return zh
        ? '地理编码得到 0 个可定位点。模型或规则提出了地名，但地图检索没有坐标。'
        : 'Geocoding returned 0 mapped places. Names were proposed, but map lookup found no coordinates.';
    case 'llm_error':
      return zh
        ? `模型调用失败${detail}。将仅使用正文规则解析。`
        : `Model call failed${detailEn}. Falling back to guide-text rules.`;
    default:
      return zh
        ? '没有可发布的地图证据。'
        : 'No publishable map evidence was found.';
  }
}

function joinFailureCopy(kinds, locale, extra) {
  const unique = [...new Set((kinds || []).filter(Boolean))];
  if (!unique.length) return extractFailureCopy('geocode_0', locale, extra);
  return unique.map((kind) => extractFailureCopy(kind, locale, extra)).join(' ');
}

function jsonModeSystem(system) {
  return [
    String(system || '').trim(),
    'You extract visitable place candidates from travel notes, NOT hotel/flight reservations.',
    'Do not emit a reservation list. Do not use chain-of-thought.',
    'If you are a reasoning model, still put the final JSON in content (not only reasoning_content).',
    'Reply with a single JSON object: {"candidates":[{"name":"","nameZh":"","dayHint":1,"durationMinutes":90,"reason":"","reservationRequired":false,"reservationTips":"","guideId":""}],"budget":null,"intent":{}}.',
    'No markdown fences, no commentary.',
  ].filter(Boolean).join('\n');
}

function outboundChatUrl(base) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  if (!root) return '';
  if (/\/chat\/completions$/i.test(root)) return root;
  if (/\/v1$/i.test(root)) return `${root}/chat/completions`;
  return `${root}/v1/chat/completions`;
}

function assertOutboundHostAllowed(url) {
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {
    throw new Error('llm_api_base is not a valid URL');
  }
  if (!OUTBOUND_EGRESS_HOSTS.has(hostname)) {
    throw new Error(`llm_api_base host ${hostname} is not in plugin egress; use TREK llm_parsing (ctx.ai.complete) or api.deepseek.com / api.openai.com`);
  }
  return hostname;
}

function userContentWithImages(prompt, imageUrls) {
  const urls = (imageUrls || []).filter(isHttpsUrl).slice(0, 4);
  if (!urls.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

async function outboundChatCompletions(limits, { system, prompt, imageUrls, maxTokens, jsonMode }) {
  const url = outboundChatUrl(limits.llmApiBase);
  assertOutboundHostAllowed(url);
  const messages = [
    { role: 'system', content: jsonModeSystem(system) },
    { role: 'user', content: userContentWithImages(prompt, imageUrls) },
  ];
  const body = {
    model: limits.llmModel || 'deepseek-chat',
    messages,
    temperature: 0,
    max_tokens: maxTokens || limits.llmMaxTokens || 4096,
  };
  if (jsonMode !== false) body.response_format = { type: 'json_object' };
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${limits.llmApiKey}`,
  };
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload = raw;
  try { payload = JSON.parse(raw); } catch { /* keep text */ }
  if (!response.ok) {
    const err = new Error(`LLM HTTP ${response.status}: ${String(raw).slice(0, 240)}`);
    err.status = response.status;
    if (response.status === 401 || response.status === 403) err.code = 'llm_auth';
    throw err;
  }
  return { payload, rawText: typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

async function hostComplete(ctx, prompt, system) {
  if (typeof ctx?.ai?.complete !== 'function') {
    const err = new Error('RESOURCE_FORBIDDEN: host does not expose ai.complete');
    err.code = 'RESOURCE_FORBIDDEN';
    throw err;
  }
  return ctx.ai.complete(prompt, jsonModeSystem(system));
}

function emptyExtracted() {
  return { candidates: [] };
}

async function invokeGuideLlm(ctx, limits, request = {}) {
  const prompt = String(request.prompt || '');
  const system = String(request.system || '');
  const imageUrls = request.allowMultimodal === false ? [] : (request.imageUrls || []).filter(isHttpsUrl).slice(0, 4);
  const traces = [];
  const maxTokens = request.maxTokens || limits.llmMaxTokens || 4096;
  const useOutbound = Boolean(String(limits.llmApiBase || '').trim() && String(limits.llmApiKey || '').trim());

  const finish = (parsed, meta) => ({
    extracted: parsed && typeof parsed === 'object' ? parsed : emptyExtracted(),
    traces,
    channel: meta.channel,
    emptyContent: meta.emptyContent === true,
    recoveredFromReasoning: meta.recoveredFromReasoning === true,
    multimodalUsed: meta.multimodalUsed === true,
    multimodalDegraded: meta.multimodalDegraded === true,
  });

  const record = (entry) => {
    traces.push(buildAiTrace(entry));
  };

  const parseOrRetry = async (payload, channel, opts = {}) => {
    const parsedOnce = parseGuideLlmPayload(payload);
    record({
      channel,
      prompt,
      system,
      response: parsedOnce.content || parsedOnce.reasoning,
      emptyContent: parsedOnce.emptyContent,
      recoveredFromReasoning: parsedOnce.recoveredFromReasoning,
      retry: opts.retry === true,
      imageUrls: opts.imageUrls || [],
    });
    if (parsedOnce.parsed) return parsedOnce;
    if (parsedOnce.emptyContent && parsedOnce.reasoning && !opts.retry) {
      return { ...parsedOnce, parsed: null, needsRetry: true };
    }
    if (parsedOnce.emptyContent && !opts.retry) return { ...parsedOnce, needsRetry: true };
    return parsedOnce;
  };

  if (useOutbound) {
    try {
      const first = await outboundChatCompletions(limits, {
        system, prompt, imageUrls, maxTokens, jsonMode: true,
      });
      let parsed = await parseOrRetry(first.payload, 'outbound', { imageUrls });
      if (!parsed.parsed && parsed.needsRetry) {
        const retry = await outboundChatCompletions(limits, {
          system: `${system}\nReply with JSON only. Do not think out loud.`,
          prompt,
          imageUrls: [],
          maxTokens: Math.max(maxTokens, 8192),
          jsonMode: true,
        });
        parsed = await parseOrRetry(retry.payload, 'outbound', { retry: true });
      }
      if (!parsed.parsed && parsed.emptyContent) {
        const err = new Error('LLM returned empty content (reasoning-only is not success)');
        err.code = 'llm_empty';
        throw err;
      }
      return finish(parsed.parsed || emptyExtracted(), {
        channel: 'outbound',
        emptyContent: parsed.emptyContent,
        recoveredFromReasoning: parsed.recoveredFromReasoning,
        multimodalUsed: imageUrls.length > 0,
      });
    } catch (error) {
      if (imageUrls.length) {
        try {
          const fallback = await outboundChatCompletions(limits, {
            system, prompt, imageUrls: [], maxTokens, jsonMode: true,
          });
          const parsed = await parseOrRetry(fallback.payload, 'outbound', { retry: true });
          return finish(parsed.parsed || emptyExtracted(), {
            channel: 'outbound',
            emptyContent: parsed.emptyContent,
            recoveredFromReasoning: parsed.recoveredFromReasoning,
            multimodalDegraded: true,
          });
        } catch {
          // fall through to host complete
        }
      }
      if (!ctx?.ai?.complete) throw error;
    }
  }

  const textPrompt = imageUrls.length
    ? `${prompt}\n\nPublic note image URLs (do not fetch private/login-walled images; text fallback if you cannot see them):\n${imageUrls.join('\n')}`
    : prompt;
  const first = await hostComplete(ctx, textPrompt, system);
  let parsed = await parseOrRetry(first, 'host_complete', { imageUrls });
  if (!parsed.parsed && parsed.needsRetry) {
    const retry = await hostComplete(
      ctx,
      textPrompt,
      `${system}\nReply with JSON only. Do not think out loud. Put the JSON in content, not reasoning_content.`,
    );
    parsed = await parseOrRetry(retry, 'host_complete', { retry: true, imageUrls });
  }
  if (!parsed.parsed && parsed.emptyContent) {
    const err = new Error('LLM returned empty content (reasoning-only is not success)');
    err.code = 'llm_empty';
    err.traces = traces;
    throw err;
  }
  return finish(parsed.parsed || emptyExtracted(), {
    channel: 'host_complete',
    emptyContent: parsed.emptyContent,
    recoveredFromReasoning: parsed.recoveredFromReasoning,
    multimodalUsed: false,
    multimodalDegraded: imageUrls.length > 0,
  });
}

function collectGuideImageUrls(guides) {
  const urls = [];
  const seen = new Set();
  for (const guide of guides || []) {
    for (const value of guide?.imageUrls || []) {
      if (!isHttpsUrl(value) || seen.has(value)) continue;
      seen.add(value);
      urls.push(value);
    }
  }
  return urls.slice(0, 6);
}

function shouldTryMultimodal(guides, enabled) {
  if (!enabled) return false;
  return collectGuideImageUrls(guides).length > 0;
}

function multimodalPrompt(guides, intent) {
  const titles = (guides || []).map((guide) => `[${guide.id}] ${guide.title || ''}`).join('\n');
  return [
    `Destination: ${intent.destination || '(unknown)'}`,
    `Days: ${intent.dayCount}`,
    'These public note images may include a route card (day-by-day place list).',
    'Extract visitable place names per day. One candidate per place, with dayHint matching 第N天/Day N if shown.',
    'If an image is not a route card, return {"candidates":[]}.',
    'Do not invent places that are not visible. Map/geo will referee later.',
    titles,
  ].join('\n');
}

module.exports = {
  CANDIDATES_SCHEMA,
  OUTBOUND_EGRESS_HOSTS,
  extractJsonObject,
  parseGuideLlmPayload,
  normalizeCompletePayload,
  sanitizeTraceText,
  sanitizeTraceHeaders,
  buildAiTrace,
  invokeGuideLlm,
  classifyLlmError,
  isForbiddenError,
  isLlmAuthError,
  extractFailureCopy,
  joinFailureCopy,
  collectGuideImageUrls,
  shouldTryMultimodal,
  multimodalPrompt,
  jsonModeSystem,
};
