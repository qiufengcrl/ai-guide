const BASE_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 12000;
const JITTER_MS = 500;
const RESTORE_SUCCESS_STREAK = 3;

let baseIntervalMs = BASE_INTERVAL_MS;
let maxIntervalMs = MAX_INTERVAL_MS;
let jitterMs = JITTER_MS;
let sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nowFn = () => Date.now();
let backoffFn = (attempt) => Math.min(20000, 5000 * (2 ** Math.max(0, attempt)));

let intervalMs = baseIntervalMs;
let successStreak = 0;
let lastAt = 0;
let waitChain = Promise.resolve();

function isXhsRateLimitError(error) {
  const text = String(error?.message || error || '');
  return /429|461|频繁|风控|cuqps|too many requests|rate limit/i.test(text);
}

function xhsBackoffDelayMs(attempt) {
  return backoffFn(Math.max(0, attempt));
}

function resetThrottleState() {
  intervalMs = baseIntervalMs;
  successStreak = 0;
  lastAt = 0;
  waitChain = Promise.resolve();
}

function penalize() {
  intervalMs = Math.min(maxIntervalMs, Math.max(baseIntervalMs, intervalMs) * 2);
  successStreak = 0;
}

function recordSuccess() {
  if (intervalMs <= baseIntervalMs) {
    intervalMs = baseIntervalMs;
    successStreak = 0;
    return;
  }
  successStreak += 1;
  if (successStreak >= RESTORE_SUCCESS_STREAK) {
    intervalMs = Math.max(baseIntervalMs, Math.floor(intervalMs / 2));
    successStreak = 0;
  }
}

async function waitOnce() {
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  const minDelay = intervalMs + jitter;
  const now = nowFn();
  const waitMs = lastAt ? Math.max(0, minDelay - (now - lastAt)) : minDelay;
  if (waitMs > 0) await sleepFn(waitMs);
  lastAt = nowFn();
}

async function wait() {
  const run = waitChain.then(waitOnce, waitOnce);
  waitChain = run.catch(() => {});
  return run;
}

async function withXhsRetry(fn, { maxRetries = 2, onRateLimit } = {}) {
  let attempt = 0;
  for (;;) {
    await wait();
    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (error) {
      if (!isXhsRateLimitError(error) || attempt >= maxRetries) throw error;
      penalize();
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
  get intervalMs() { return intervalMs; },
  get successStreak() { return successStreak; },
  get lastAt() { return lastAt; },
  wait,
  penalize,
  recordSuccess,
  reset: resetThrottleState,
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
