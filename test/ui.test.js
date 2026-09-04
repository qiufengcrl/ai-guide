const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
const appScript = inlineScripts.at(-1)?.[1] || '';

test('page keeps the TREK kit contract and has valid application JavaScript', () => {
  assert.match(html, /<!-- trek:ui -->/);
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/i);
  assert.doesNotMatch(html, /<link[^>]+\brel=["']?stylesheet/i);
  assert.ok(appScript.length > 1000);
  assert.doesNotThrow(() => new vm.Script(appScript, { filename: 'client/index.html' }));
});

test('redesign covers the complete planning and preview workflow', () => {
  const requiredIds = [
    'plan-form', 'destination', 'interests', 'start-date', 'end-date', 'day-count',
    'pace', 'urls', 'source-text', 'generate', 'status', 'progress', 'warnings',
    'warning-list', 'preview', 'sources', 'days', 'trip-title', 'commit',
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id=["']${id}["']`), id);

  for (const hook of [
    "trek.onContext", "trek.invoke('/plan'", "trek.invoke('/commit'",
    "trek.navigate('/settings?tab=plugins')", "trek.openExternal",
    'renderWarnings', 'renderSources', 'renderDays', 'syncDayState',
    'invokeErrorMessage', 'conflict',
  ]) assert.ok(appScript.includes(hook), hook);
});

test('every id is unique', () => {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);
});

test('all static copy exists in both English and Chinese', () => {
  const en = appScript.match(/\ben:\s*\{([\s\S]*?)\n\s*\},\n\s*zh:/)?.[1] || '';
  const zh = appScript.match(/\bzh:\s*\{([\s\S]*?)\n\s*\}\n\s*\};/)?.[1] || '';
  const keys = (block) => [...block.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
  const enKeys = keys(en);
  const zhKeys = keys(zh);
  assert.deepEqual([...enKeys].sort(), [...zhKeys].sort());

  const attributeKeys = new Set(
    [...html.matchAll(/data-i18n(?:-placeholder|-aria-label)?=["']([^"']+)["']/g)]
      .map((match) => match[1]),
  );
  for (const key of attributeKeys) {
    assert.ok(enKeys.includes(key), `missing English copy: ${key}`);
    assert.ok(zhKeys.includes(key), `missing Chinese copy: ${key}`);
  }
});

test('theme, accessibility, and responsive host states are explicitly supported', () => {
  for (const selector of [
    '[data-form-factor="phone"]',
    '[data-no-transparency]',
    '[data-density="compact"]',
    '[data-reduce-motion]',
    '@media (prefers-reduced-motion: reduce)',
  ]) assert.ok(html.includes(selector), selector);

  assert.match(html, /role=["']status["'][^>]+aria-live=["']polite["']/);
  assert.match(html, /role=["']progressbar["']/);
  assert.match(html, /role=["']alert["']/);
  assert.match(html, /:focus-visible|\.trek-ui :focus-visible/);
});
