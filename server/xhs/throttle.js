const { cookieFingerprint } = require('./freshness');

const BASE_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 12000;
const JITTER_MS = 500;
const RESTORE_SUCCESS_STREAK = 3;
const MAX_SCOPES = 64;
const SIGNED_BLOCK_MS = 2 * 60 * 1000;

let baseIntervalMs = BASE_INTERVAL_MS;
let maxIntervalMs = MAX_INTERVAL_MS;
let jitterMs = JITTER_MS;
let sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nowFn = () => Date.now();
let backoffFn = (attempt) => Math.min(20000, 5000 * (2 ** Math.max(0, attempt)));

const scopes = new Map();

function isXhsRateLimitError(error) {
  const text = String(error?.message || error || '');
  return /429|461|频繁|风控|cuqps|too many requests|rate limit/i.test(text);
}

function xhsBackoffDelayMs(attempt) {
  return backoffFn(Math.max(0, attempt));
}

function scopeKey(cookie) {
  return cookieFingerprint(cookie) || 'public';
}

function createScope() {
  return {
    intervalMs: baseIntervalMs,
    successStreak: 0,
    lastAt: null,
    waitChain: Promise.resolve(),
    signedBlockedUntil: 0,
  };
}

function getScope(cookie) {
  const key = scopeKey(cookie);
  let scope = scopes.get(key);
  if (!scope) {
    if (scopes.size >= MAX_SCOPES) {
      const oldest = scopes.keys().next().value;
      if (oldest) scopes.delete(oldest);
    }
    scope = createScope();
    scopes.set(key, scope);
  }
  return scope;
}

function resetThrottleState() {
  scopes.clear();
}

function penalize(cookie) {
  const scope = getScope(cookie);
  scope.intervalMs = Math.min(maxIntervalMs, Math.max(baseIntervalMs, scope.intervalMs) * 2);
  scope.successStreak = 0;
}

function recordSuccess(cookie) {
  const scope = getScope(cookie);
  if (scope.intervalMs <= baseIntervalMs) {
    scope.intervalMs = baseIntervalMs;
    scope.successStreak = 0;
    return;
  }
  scope.successStreak += 1;
  if (scope.successStreak >= RESTORE_SUCCESS_STREAK) {
    scope.intervalMs = Math.max(baseIntervalMs, Math.floor(scope.intervalMs / 2));
    scope.successStreak = 0;
  }
}

function markSignedBlocked(cookie) {
  getScope(cookie).signedBlockedUntil = nowFn() + SIGNED_BLOCK_MS;
}

function isSignedBlocked(cookie) {
  return nowFn() < (getScope(cookie).signedBlockedUntil || 0);
}

async function waitOnce(scope) {
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  const minDelay = scope.intervalMs + jitter;
  const now = nowFn();
  const waitMs = scope.lastAt != null ? Math.max(0, minDelay - (now - scope.lastAt)) : 0;
  if (waitMs > 0) await sleepFn(waitMs);
  scope.lastAt = nowFn();
}

async function wait(cookie) {
  const scope = getScope(cookie);
  const run = scope.waitChain.then(() => waitOnce(scope), () => waitOnce(scope));
  scope.waitChain = run.catch(() => {});
  return run;
}

async function withXhsRetry(fn, { maxRetries = 2, onRateLimit, cookie, wait: doWait = true } = {}) {
  let attempt = 0;
  for (;;) {
    if (doWait) await wait(cookie);
    try {
      const result = await fn();
      recordSuccess(cookie);
      return result;
    } catch (error) {
      if (!isXhsRateLimitError(error) || attempt >= maxRetries) {
        if (isXhsRateLimitError(error)) markSignedBlocked(cookie);
        throw error;
      }
      penalize(cookie);
      if (typeof onRateLimit === 'function') onRateLimit(error, attempt);
      await sleepFn(xhsBackoffDelayMs(attempt));
      attempt += 1;
    }
  }
}

function setXhsThrottleForTests(options = {}) {
  if (options.baseIntervalMs != null) baseIntervalMs = Math.max(0, Number(options.baseIntervalMs) || 0);
  if (options.maxIntervalMs != null) maxIntervalMs = Math.max(baseIntervalMs, Number(options.maxIntervalMs) || baseIntervalMs);
  if (options.jitterMs != null) jitterMs = Math.max(0, Number(options.jitterMs) || 0);
  if (typeof options.sleep === 'function') sleepFn = options.sleep;
  else sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (typeof options.now === 'function') nowFn = options.now;
  else nowFn = () => Date.now();
  if (options.backoffDelayMs != null) {
    backoffFn = typeof options.backoffDelayMs === 'function'
      ? options.backoffDelayMs
      : () => Math.max(0, Number(options.backoffDelayMs) || 0);
  } else {
    backoffFn = (attempt) => Math.min(20000, 5000 * (2 ** Math.max(0, attempt)));
  }
  resetThrottleState();
}

const xhsThrottle = {
  get intervalMs() { return getScope('').intervalMs; },
  get successStreak() { return getScope('').successStreak; },
  intervalMsFor(cookie) { return getScope(cookie).intervalMs; },
  wait,
  penalize,
  recordSuccess,
  reset: resetThrottleState,
  markSignedBlocked,
  isSignedBlocked,
};

module.exports = {
  BASE_INTERVAL_MS,
  MAX_INTERVAL_MS,
  isXhsRateLimitError,
  xhsBackoffDelayMs,
  withXhsRetry,
  xhsThrottle,
  setXhsThrottleForTests,
};
