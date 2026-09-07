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
    'plan-form', 'destination', 'interests', 'must-see', 'start-date', 'end-date', 'day-count',
    'pace', 'urls', 'source-text', 'xhs-keyword-search', 'xhs-search-field', 'generate', 'status', 'progress', 'warnings',
    'warning-list', 'preview', 'sources', 'days', 'trip-title', 'commit',
    'prep-tips', 'stage-plan', 'stage-preview', 'cookie-help', 'day-rail', 'inspector',
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id=["']${id}["']`), id);

  for (const hook of [
    "trek.onContext", "trek.invoke('/prefs'", "trek.invoke('/plan'", "trek.invoke('/commit'",
    "progress.message", "place-photo", "photoUrl",
    "trek.navigate('/settings?tab=plugins')", "trek.openExternal",
    'renderWarnings', 'renderSources', 'renderDays', 'syncDayState',
    'showStage', 'renderPrepTips', 'renderPlaceDetail', 'setActiveDay',
    'invokeErrorMessage', 'conflict', 'isTransientInvokeError', 'stillWorking',
    'sourceSummary', 'sourcesEmpty', 'trek.session.set', 'restorePlanForm',
  ]) assert.ok(appScript.includes(hook), hook);
  assert.match(appScript, /if \(!xhsSearchAllowed\) checkbox\.checked = false/);
  assert.doesNotMatch(appScript, /checkbox\.checked = false;\s*checkbox\.disabled/);
  assert.match(appScript, /event\.key === 'Escape'/);
  assert.match(appScript, /function safeExternalUrl/);
  assert.match(appScript, /function safePhotoUrl/);
  assert.match(appScript, /createElement\('div'\)/);
  assert.doesNotMatch(appScript, /createElement\('button'\);\s*chip\.type = 'button'/);
  assert.doesNotMatch(appScript, /source-card'\)\.classList\.toggle\('hidden', guides\.length === 0\)/);
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
    'applyLayoutMode',
    'isPhoneLayout',
    'resolveLocale',
  ]) assert.ok(html.includes(selector), selector);

  assert.match(html, /role=["']status["'][^>]+aria-live=["']polite["']/);
  assert.match(html, /role=["']progressbar["']/);
  assert.match(html, /role=["']alert["']/);
  assert.match(html, /<body class="trek-ui">/);
  assert.match(html, /font-family:\s*var\(--font-system\)/);
  assert.match(html, /html\.layout-phone \.page/);
  assert.match(html, /--ai-guide-dock/);
  assert.match(appScript, /function syncDockInset/);
  assert.match(appScript, /Math\.max\(readHostBottomInset\(ctx\), 120\)/);
  assert.match(html, /input\[type="date"\]\.trek-input/);
  assert.match(html, /color: inherit/);
  assert.match(appScript, /TREK UI kit is not loaded/);
  assert.match(html, /:focus-visible|\.trek-ui :focus-visible|trek-ui/);
});

test('AGENTS.md: kit classes first, tokens only, trek.session, native select', () => {
  const markerAt = html.indexOf('<!-- trek:ui -->');
  assert.ok(markerAt >= 0, 'missing trek:ui marker');
  assert.ok(html.indexOf('<style') > markerAt, 'plugin CSS must come after trek:ui so kit tokens win');
  assert.match(html, /<html lang="zh-CN">/);
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/i);
  assert.doesNotMatch(html, /<link[^>]+\brel=["']?stylesheet/i);
  assert.doesNotMatch(html, /googleapis|cdn\.jsdelivr|unpkg\.com|tailwindcss/i);
  assert.doesNotMatch(html, /#111827|#2563eb|#64748b|#ffffff|#fffbeb|#f8fafc/);
  assert.doesNotMatch(html, /body\s*\{[^}]*background:\s*#fff/i);
  assert.doesNotMatch(appScript, /localStorage|sessionStorage/);
  assert.match(appScript, /trek\.session\.set\('planForm'/);
  assert.match(appScript, /trek\.session\.get\('planForm'\)/);
  assert.match(appScript, /scope:\s*'plugin'/);
  assert.match(html, /class="[^"]*trek-label/);
  assert.match(html, /class="[^"]*trek-stack/);
  assert.match(html, /class="[^"]*trek-cluster/);
  assert.match(html, /class="[^"]*trek-title/);
  assert.match(html, /class="[^"]*trek-glass/);
  assert.match(html, /class="[^"]*trek-card/);
  assert.match(html, /class="[^"]*trek-btn trek-btn--primary/);
  assert.match(html, /class="[^"]*trek-segmented/);
  assert.match(html, /<select id="pace">/);
  assert.doesNotMatch(html, /\.app-shell \.trek-select \{/);
  assert.doesNotMatch(html, /class="app-shell trek-scroll"/);
  assert.match(html, /class="page trek-scroll/);
  assert.match(html, /padding-bottom:\s*calc\(16px \+ var\(--ai-guide-dock/);
  assert.doesNotMatch(html, /\.trek-btn\s*\{[^}]*background:\s*var\(--accent\)/);
});
