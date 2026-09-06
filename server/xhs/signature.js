'use strict';

const crypto = require('node:crypto');
const { Client, PUBLIC_USER_AGENT } = require('./vendor/xhshow.cjs');

const XHS_ORIGIN = 'https://www.xiaohongshu.com';
const XSEC_APP_ID = 'xhs-pc-web';
const signer = new Client();

function parseCookieHeader(value) {
  const cookies = Object.create(null);
  for (const part of String(value || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function serializeCookies(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function randomHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

/**
 * Build the same signed browser-shaped POST used by TripStar, backed by the
 * small MIT-licensed xhshow-js engine rather than TripStar's GPL bundle.
 */
function createSignedGet(path, params, cookie, options = {}) {
  const cookies = parseCookieHeader(cookie);
  if (!cookies.a1) throw new Error('Xiaohongshu Cookie is missing the a1 value');
  if (!cookies.web_session) throw new Error('Xiaohongshu Cookie is missing the web_session value');

  const timestamp = Number.isFinite(options.timestamp) ? options.timestamp : Date.now();
  const client = options.signer || signer;
  const appId = cookies.xsecappid || XSEC_APP_ID;
  const query = params && typeof params === 'object' ? params : {};

  return {
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      cookie: serializeCookies(cookies),
      pragma: 'no-cache',
      referer: `${XHS_ORIGIN}/`,
      'sec-ch-ua': '"Chromium";v="142", "Not_A Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': PUBLIC_USER_AGENT,
      'x-b3-traceid': client.getB3TraceId(),
      'x-mns': 'unload',
      'x-s': client.signXS('GET', path, cookies.a1, appId, query, timestamp),
      'x-s-common': client.signXSCommon(cookies),
      'x-t': String(timestamp),
      'x-xray-traceid': client.getXrayTraceId(timestamp),
    },
  };
}

function createSignedPost(path, payload, cookie, options = {}) {
  const cookies = parseCookieHeader(cookie);
  if (!cookies.a1) throw new Error('Xiaohongshu Cookie is missing the a1 value');
  if (!cookies.web_session) throw new Error('Xiaohongshu Cookie is missing the web_session value');

  const timestamp = Number.isFinite(options.timestamp) ? options.timestamp : Date.now();
  const client = options.signer || signer;
  const appId = cookies.xsecappid || XSEC_APP_ID;
  const body = JSON.stringify(payload);

  return {
    body,
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      'content-type': 'application/json;charset=UTF-8',
      cookie: serializeCookies(cookies),
      origin: XHS_ORIGIN,
      pragma: 'no-cache',
      referer: `${XHS_ORIGIN}/`,
      'sec-ch-ua': '"Chromium";v="142", "Not_A Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': PUBLIC_USER_AGENT,
      'x-b3-traceid': client.getB3TraceId(),
      'x-mns': 'unload',
      'x-s': client.signXS('POST', path, cookies.a1, appId, payload, timestamp),
      'x-s-common': client.signXSCommon(cookies),
      'x-t': String(timestamp),
      'x-xray-traceid': client.getXrayTraceId(timestamp),
    },
  };
}

function createSearchId() {
  return randomHex(21);
}

module.exports = {
  XHS_ORIGIN,
  createSearchId,
  createSignedGet,
  createSignedPost,
  parseCookieHeader,
};
