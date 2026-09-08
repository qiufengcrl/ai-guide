const { fetchWithTimeout } = require('./url');
const { createSignedGet, createSignedPost } = require('./signature');
const { XhsSessionError, throwForHttpStatus, assertSessionResponse } = require('./errors');

const HOST = 'https://edith.xiaohongshu.com';
const SELFINFO_PATH = '/api/sns/web/v1/user/selfinfo';

function signingError(error) {
  const detail = error instanceof Error ? error.message : 'Xiaohongshu request signing failed';
  const code = /missing the a1|missing the web_session|cookie is empty/i.test(detail) ? 'auth' : 'fetch';
  return new XhsSessionError(detail, code);
}

async function send(url, init, timeoutMs) {
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (error) {
    throw new XhsSessionError(error instanceof Error ? error.message : 'Xiaohongshu network error', 'fetch');
  }
  throwForHttpStatus(response);
  return assertSessionResponse(await response.json());
}

async function post(path, payload, cookie, options = {}) {
  let signed;
  try {
    signed = createSignedPost(path, payload, cookie, options);
  } catch (error) {
    throw signingError(error);
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000;
  return send(`${HOST}${path}`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  }, timeoutMs);
}

async function get(path, params, cookie, options = {}) {
  let signed;
  try {
    signed = createSignedGet(path, params, cookie, options);
  } catch (error) {
    throw signingError(error);
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  return send(signed.url, {
    method: 'GET',
    headers: signed.headers,
  }, timeoutMs);
}

function pongOk(data) {
  if (!data || typeof data !== 'object') return false;
  const nested = data.data && typeof data.data === 'object' ? data.data : {};
  if (nested.result && nested.result.success === false) return false;
  if (nested.result && nested.result.success === true) return true;
  return Boolean(nested.user_id || nested.userid || nested.userId || nested.basic_info || nested.basicInfo);
}

async function pong(cookie, options = {}) {
  if (!cookie) throw new XhsSessionError('Xiaohongshu Cookie is empty', 'auth');
  const data = await get(SELFINFO_PATH, {}, cookie, options);
  if (!pongOk(data)) {
    throw new XhsSessionError('Xiaohongshu session pong failed', 'auth');
  }
  return data;
}

module.exports = {
  HOST,
  SELFINFO_PATH,
  post,
  get,
  pong,
  pongOk,
};
