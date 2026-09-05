// Built plugin entry — runs in an isolated child process.
const crypto = require('node:crypto');
const { definePlugin } = require('trek-plugin-sdk');
const {
  EXTRACTION_SCHEMA,
  settings,
  message,
  normalizeInput,
  extractionText,
  extractionInstruction,
  resolveExtractCandidates,
  inferDestinationFromGuides,
  mergeGuideTexts,
  guideTextForExtractRetry,
  extractRetryInstruction,
  looksLikeShareCard,
  noteDisplayTitle,
  gateAndSchedule,
  splitRegions,
  publicDraft,
  geoSearchOptions,
  resolveXhsKeywordSearch,
  truthySetting,
  remainingXhsNoteSlots,
  collectXhsNoteIds,
  mapConcurrent,
  resolveCandidateEvidence,
} = require('./pipeline');
const { fetchPublicNote, fetchPublicNoteFromResolved, isShortLinkHost, noteIdFromUrl, resolveNoteUrl, searchKeywordFromUrl } = require('./xhs/url');
const {
  normalizeXhsCookie,
  searchNotes,
  searchNotesDetailed,
  fetchSessionNote,
  formatXhsWarning,
  isXhsAuthError,
  isXhsVerificationError,
} = require('./xhs/session');
const { withXhsRetry, xhsThrottle, isXhsRateLimitError } = require('./xhs/throttle');
const {
  XHS_COOKIE_STALE_MS,
  resolveActingUserId,
  readXhsCookieUpdatedAt,
  writeXhsCookieUpdatedAt,
} = require('./xhs/freshness');
const { getXhsPhoto } = require('./xhs/photos');
const { searchPlaces } = require('./geo/nominatim');

const JOB_FIELDS = 'id, user_id, status, stage, payload_json, draft_json, work_json, error, committed_trip_id, created_at, updated_at';
const ticks = new Map();
const JOB_STALE_MS = 30 * 60 * 1000;

const json = (value, fallback) => {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
};
const response = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body });

function blockSignedXhs(work, cookie) {
  if (work) work.xhsSignedApiBlocked = true;
  if (cookie) xhsThrottle.markSignedBlocked(cookie);
}

async function warnIfXhsCookieStale(job, ctx, cookie, locale) {
  const work = job.work || {};
  if (!cookie || work.xhsCookieAgeChecked) return;
  work.xhsCookieAgeChecked = true;
  const updatedAt = await readXhsCookieUpdatedAt(ctx, job.userId, cookie);
  if (!updatedAt) return;
  if (Date.now() - updatedAt <= XHS_COOKIE_STALE_MS) return;
  addWarning(job, message(locale,
    '小红书 Cookie 已超过 7 天未更新，可能已过期。建议重新登录 www.xiaohongshu.com 后在插件设置中更新 Cookie。生成不会因此中断。',
    'Your Xiaohongshu Cookie was last updated more than 7 days ago and may have expired. Log in at www.xiaohongshu.com and update it in plugin settings. Planning will continue.'));
}

async function ensureXhsSignedAccess(job, work, cookie, locale, ctx) {
  if (!cookie) return false;
  if (work.xhsSignedApiBlocked) return false;
  if (work.xhsHealthChecked) return true;
  work.xhsHealthChecked = true;
  try {
    await withXhsRetry(() => searchNotesDetailed('旅行', cookie, 1), { cookie });
    await writeXhsCookieUpdatedAt(ctx, job.userId, cookie);
    return true;
  } catch (error) {
    addWarning(job, formatXhsWarning(error, locale, message, { scene: 'search' }));
    if (isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)) {
      blockSignedXhs(work, cookie);
      return false;
    }
    return true;
  }
}

function isTransientTickError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  return /aborted|abort|timeout of \d+ms|timed?\s*out|ETIMEDOUT|ECONNRESET/i.test(String(error.message || error));
}

function rowToJob(row) {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    status: String(row.status),
    stage: String(row.stage),
    payload: json(row.payload_json, {}),
    draft: json(row.draft_json, {}),
    work: json(row.work_json, {}),
    error: row.error ? String(row.error) : null,
    committedTripId: row.committed_trip_id == null ? null : Number(row.committed_trip_id),
    updatedAt: Number(row.updated_at) || 0,
  };
}

async function findJob(ctx, userId, jobId) {
  const rows = await ctx.db.query(`SELECT ${JOB_FIELDS} FROM jobs WHERE id = ? AND user_id = ?`, jobId, userId);
  return rows[0] ? rowToJob(rows[0]) : null;
}

async function saveJob(ctx, job) {
  await ctx.db.exec(
    'UPDATE jobs SET status = ?, stage = ?, draft_json = ?, work_json = ?, error = ?, committed_trip_id = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    job.status,
    job.stage,
    JSON.stringify(job.draft || {}),
    JSON.stringify(job.work || {}),
    job.error || null,
    job.committedTripId || null,
    Date.now(),
    job.id,
    job.userId,
  );
}

function reviveStaleJob(job, locale) {
  if (!job || job.status !== 'running' || !job.updatedAt) return job;
  if (Date.now() - job.updatedAt < JOB_STALE_MS) return job;
  job.status = 'failed';
  job.stage = 'failed';
  job.error = message(locale, '规划任务超时，请重新生成', 'Planning timed out; please start again');
  return job;
}

async function rollbackCreatedPlaces(ctx, tripId, placeIds) {
  for (const placeId of placeIds) {
    try {
      await ctx.places.delete(tripId, placeId);
    } catch {
      // Best-effort cleanup after a partial commit failure.
    }
  }
}

function addWarning(job, text) {
  job.draft.warnings ||= [];
  if (!job.draft.warnings.includes(text)) job.draft.warnings.push(text);
}

async function ingestPendingNoteFromPublic(job, item, locale, userId) {
  if (!item?.url) return;
  try {
    await xhsThrottle.wait(null, userId);
    const note = await fetchPublicNote(item.url);
    if (!String(note?.text || '').trim() && !String(note?.title || '').trim()) return;
    job.draft.guides.push({
      ...note,
      id: `g_${job.draft.guides.length + 1}`,
      via: item.via || note.via || 'url',
      title: noteDisplayTitle(note, message(locale, '小红书笔记', 'Xiaohongshu note')),
      text: String(note.text || '').slice(0, 4000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || '');
    addWarning(job, message(locale, `链接读取失败：${detail}`, `Could not read link: ${detail}`));
  }
}

async function runKeywordSearch(job, work, cookie, limits, locale, ctx) {
  const wantsKeywordSearch = limits.xhsEnabled
    && resolveXhsKeywordSearch(job.payload.xhsKeywordSearch);
  if (!wantsKeywordSearch) return;
  if (!limits.xhsEnabled && truthySetting(job.payload.xhsKeywordSearch)) {
    addWarning(job, message(locale,
      '管理员已关闭小红书关键词搜索；已继续使用表单、链接或粘贴内容',
      'Xiaohongshu keyword search is disabled by the admin; continuing with form, links, or pasted text'));
    return;
  }
  if (!cookie) {
    addWarning(job, message(locale,
      '未配置小红书 Cookie，已跳过关键词搜索',
      'No Xiaohongshu Cookie is configured; keyword search was skipped'));
    return;
  }
  if (work.xhsSignedApiBlocked) return;
  if (!job.draft.intent.destination) return;

  const hasUserSources = (job.draft.guides || []).length > 0
    || (work.pendingNotes || []).length > 0;
  const remaining = remainingXhsNoteSlots(job.draft.guides, work.pendingNotes, limits.maxNotes);
  if (remaining <= 0) {
    if (hasUserSources) {
      addWarning(job, message(locale,
        '已有足够攻略来源，未再额外搜索小红书',
        'Enough guide sources already; skipped extra Xiaohongshu search'));
    }
    return;
  }

  if (!(await ensureXhsSignedAccess(job, work, cookie, locale, ctx))) return;

  const queries = (job.draft.intent.searchQueries || [job.draft.intent.guideQuery]).slice(0, 2);
  const seen = collectXhsNoteIds(job.draft.guides, work.pendingNotes);
  const beforePending = work.pendingNotes.length;
  let lastError = null;
  for (const query of queries) {
    try {
      const { notes: automatic } = await withXhsRetry(() => searchNotesDetailed(query, cookie, remaining), { cookie });
      work.lastSearchQuery = query;
      work.lastSearchCount = automatic.length;
      if (automatic.length) {
        for (const item of automatic) {
          if (seen.has(item.noteId) || seen.size >= limits.maxNotes) continue;
          seen.add(item.noteId);
          work.pendingNotes.push({ ...item, via: 'search' });
        }
        lastError = null;
        break;
      }
    } catch (error) {
      lastError = error;
      if (isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)) {
        blockSignedXhs(work, cookie);
        break;
      }
    }
  }

  const added = work.pendingNotes.length - beforePending;
  if (added > 0) return;
  if (lastError) {
    addWarning(job, formatXhsWarning(lastError, locale, message, { scene: 'search' }));
    return;
  }
  if (!hasUserSources) {
    addWarning(job, message(locale,
      `小红书搜索没有返回笔记（关键词：${work.lastSearchQuery || job.draft.intent.guideQuery}）。已按目的地生成具体景点。`,
      `Xiaohongshu search returned no notes (query: ${work.lastSearchQuery || job.draft.intent.guideQuery}). Places were proposed from the destination.`));
  }
}

async function advance(job, ctx) {
  const locale = job.payload.locale || 'en';
  const limits = settings(ctx.config);
  job.status = 'running';

  if (job.stage === 'parse_intent') {
    const intent = normalizeInput(job.payload, limits);
    job.draft = { intent, guides: [], warnings: [], days: [] };
    if (intent.sourceText && !looksLikeShareCard(intent.sourceText)) {
      job.draft.guides.push({
        id: 'g_1',
        noteId: null,
        title: message(locale, '粘贴的攻略正文', 'Pasted guide text'),
        url: null,
        text: intent.sourceText.slice(0, 4000),
        via: 'paste',
      });
    }
    job.work = { urls: intent.urls, urlIndex: 0, searchAttempted: false, pendingNotes: [], noteIndex: 0 };
    job.stage = 'fetch_guides';
    return;
  }

  if (job.stage === 'fetch_guides') {
    const cookie = normalizeXhsCookie(await ctx.settings.get('xhs_cookie'));
    const work = job.work;
    await warnIfXhsCookieStale(job, ctx, cookie, locale);
    if (work.urlIndex < work.urls.length) {
      const value = work.urls[work.urlIndex];
      let consumed = false;
      try {
        const keyword = searchKeywordFromUrl(value);
        if (keyword) {
          consumed = true;
          work.urlIndex += 1;
          if (!cookie) throw new Error(message(locale, '搜索结果链接需要用户 Cookie', 'A search-result link requires the user Cookie'));
          if (!(await ensureXhsSignedAccess(job, work, cookie, locale, ctx))) return;
          const remaining = remainingXhsNoteSlots(job.draft.guides, work.pendingNotes, limits.maxNotes);
          const seen = collectXhsNoteIds(job.draft.guides, work.pendingNotes);
          for (const item of await withXhsRetry(() => searchNotes(keyword, cookie, remaining || limits.maxNotes), { cookie })) {
            if (seen.has(item.noteId) || seen.size >= limits.maxNotes) continue;
            seen.add(item.noteId);
            work.pendingNotes.push(item);
          }
        } else {
          const host = (() => { try { return new URL(value).hostname; } catch { return ''; } })();
          if (isShortLinkHost(host) && !work.resolvedNote) {
            await xhsThrottle.wait(cookie, job.userId);
            work.resolvedNote = await resolveNoteUrl(value);
            return;
          }
          const resolved = work.resolvedNote || await resolveNoteUrl(value);
          work.resolvedNote = null;
          consumed = true;
          work.urlIndex += 1;
          let note;
          try {
            await xhsThrottle.wait(cookie, job.userId);
            note = await fetchPublicNoteFromResolved(resolved);
          } catch (publicError) {
            const noteId = publicError.noteId || resolved.noteId || noteIdFromUrl(resolved.url || value);
            if (!cookie || !noteId) throw publicError;
            work.pendingNotes.push({
              noteId,
              xsecToken: publicError.xsecToken || resolved.xsecToken || '',
              title: '',
              url: publicError.resolvedUrl || resolved.url || `https://www.xiaohongshu.com/explore/${noteId}`,
              via: 'url',
            });
            return;
          }
          job.draft.guides.push({
            ...note,
            id: `g_${job.draft.guides.length + 1}`,
            title: noteDisplayTitle(note, message(locale, '小红书笔记', 'Xiaohongshu note')),
            text: note.text.slice(0, 4000),
          });
        }
      } catch (error) {
        work.resolvedNote = null;
        if (!consumed) work.urlIndex += 1;
        const detail = error instanceof Error ? error.message : String(error || '');
        const warning = error?.name === 'XhsSessionError' || isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)
          ? formatXhsWarning(error, locale, message, { scene: 'signed' })
          : message(locale, `链接读取失败：${detail}`, `Could not read link: ${detail}`);
        addWarning(job, warning);
        if (isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)) {
          blockSignedXhs(work, cookie);
        }
      }
      return;
    }
    if (!work.searchAttempted) {
      work.searchAttempted = true;
      await runKeywordSearch(job, work, cookie, limits, locale, ctx);
      return;
    }
    if (work.noteIndex < work.pendingNotes.length) {
      const signedOk = await ensureXhsSignedAccess(job, work, cookie, locale, ctx);
      const item = work.pendingNotes[work.noteIndex++];
      if (!signedOk) {
        await ingestPendingNoteFromPublic(job, item, locale, job.userId);
        return;
      }
      try {
        const note = await fetchSessionNote(item, cookie);
        job.draft.guides.push({
          ...note,
          id: `g_${job.draft.guides.length + 1}`,
          via: item.via || note.via || 'search',
          title: noteDisplayTitle(note, message(locale, '小红书笔记', 'Xiaohongshu note')),
          text: note.text.slice(0, 4000),
        });
      } catch (error) {
        if (error.fallbackNote) {
          job.draft.guides.push({
            ...error.fallbackNote,
            id: `g_${job.draft.guides.length + 1}`,
            via: item.via || error.fallbackNote.via || 'search',
            title: noteDisplayTitle(error.fallbackNote, message(locale, '小红书笔记', 'Xiaohongshu note')),
            text: String(error.fallbackNote.text || '').slice(0, 4000),
          });
        }
        addWarning(job, formatXhsWarning(error, locale, message, { scene: 'signed' }));
        if (isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)) {
          blockSignedXhs(work, cookie);
        }
      }
      return;
    }
    job.stage = 'extract';
    return;
  }

  if (job.stage === 'extract') {
    job.draft.guides = mergeGuideTexts(job.draft.guides);
    if (!job.draft.intent.destination) {
      const inferred = inferDestinationFromGuides(job.draft.guides);
      if (inferred) {
        job.draft.intent.destination = inferred;
        job.draft.intent.guideQuery = `${inferred} ${job.draft.intent.interests.length ? job.draft.intent.interests.join(' ') : '景点'} 旅游 景点攻略`.trim();
        addWarning(job, message(locale,
          `未填写目的地，已从笔记标题推断为「${inferred}」。`,
          `Destination was empty; inferred "${inferred}" from note titles.`));
      }
    }
    const hasGuides = (job.draft.guides || []).some((guide) => String(guide.text || '').trim());
    let extracted = {};
    let llmError = null;
    try {
      const result = await ctx.ai.extract(
        extractionText(job.draft.guides, job.draft.intent),
        EXTRACTION_SCHEMA,
        extractionInstruction(job.draft.intent, hasGuides),
      );
      extracted = result.results[0] || {};
    } catch (error) {
      llmError = error instanceof Error ? error.message : String(error);
      addWarning(job, message(locale,
        `模型抽取失败（${llmError}），将尝试从攻略正文提取。`,
        `Model extraction failed (${llmError}); trying guide text parsing.`));
    }
    if (!job.draft.intent.destination && typeof extracted.intent?.destination === 'string') {
      job.draft.intent.destination = extracted.intent.destination.trim();
      job.draft.intent.guideQuery = `${job.draft.intent.destination} ${job.draft.intent.interests.length ? job.draft.intent.interests.join(' ') : '景点'} 旅游 景点攻略`.trim();
    }
    let resolved = resolveExtractCandidates(extracted, job.draft.guides, job.draft.intent);
    if (!resolved.candidates.length && hasGuides && !job.work.extractRetried) {
      job.work.extractRetried = true;
      try {
        const retry = await ctx.ai.extract(
          guideTextForExtractRetry(job.draft.guides),
          EXTRACTION_SCHEMA,
          extractRetryInstruction(locale, job.draft.intent.dayCount),
        );
        const retryResolved = resolveExtractCandidates(retry.results[0] || {}, [], job.draft.intent);
        if (retryResolved.candidates.length) {
          resolved = { ...retryResolved, source: 'llm_retry', llmCandidateCount: resolved.llmCandidateCount };
          addWarning(job, message(locale,
            '首次模型抽取为空，简版重试已成功识别景点。',
            'First extraction was empty; a simplified retry succeeded.'));
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!llmError) llmError = detail;
      }
    }
    job.work.candidates = resolved.candidates;
    job.work.extractMeta = {
      source: resolved.source,
      llmCandidateCount: resolved.llmCandidateCount,
      llmError,
    };
    if (resolved.source === 'guide_text') {
      addWarning(job, message(locale,
        '模型未能识别景点，已从攻略正文按规则提取。',
        'The model did not extract places; names were parsed from guide text.'));
    } else if (!resolved.candidates.length) {
      const hints = [];
      if (resolved.llmCandidateCount === 0 && !llmError) {
        hints.push(message(locale,
          '模型返回了 0 个景点，请检查 llm_parsing 插件是否配置了可用模型（如 deepseek-v4-flash）。',
          'The model returned 0 places; check that llm_parsing has a working model (e.g. deepseek-v4-flash).'));
      }
      if (llmError) {
        hints.push(message(locale,
          `模型调用失败：${llmError}`,
          `Model call failed: ${llmError}`));
      }
      hints.push(message(locale,
        '没有提取到具体景点。请粘贴攻略正文、填写必去景点，或换一个更具体的城市。',
        'No specific places were extracted. Paste guide text, add must-see places, or try a more specific city.'));
      for (const hint of hints) addWarning(job, hint);
    }
    job.work.candidateIndex = 0;
    job.work.evidence = [];
    job.work.bias = null;
    job.work.geocodeDone = false;
    job.work.photosDone = false;
    job.stage = 'gather_evidence';
    return;
  }

  if (job.stage === 'gather_evidence') {
    if (!job.work.bias && !job.work.biasFailed && job.draft.intent.destination) {
      try {
        const result = await searchPlaces(job.draft.intent.destination, geoSearchOptions(ctx.config, { lang: locale }));
        const dest = String(job.draft.intent.destination || '').trim();
        const ranked = (result.places || []).filter((place) => Number.isFinite(place?.lat) && Number.isFinite(place?.lng));
        const first = ranked.find((place) => dest && String(place.address || '').includes(dest)) || ranked[0];
        if (first) job.work.bias = { lat: first.lat, lng: first.lng, radius: 400000 };
        else job.work.biasFailed = true;
      } catch (error) {
        job.work.biasFailed = true;
        addWarning(job, message(locale,
          `目的地定位失败（${error.message}），已继续逐点检索`,
          `Destination lookup failed (${error.message}); continuing per-place search`));
      }
      return;
    }
    if (!job.work.geocodeDone) {
      const candidates = job.work.candidates || [];
      const geoOpts = geoSearchOptions(ctx.config, { lang: locale, locationBias: job.work.bias || undefined });
      const resolved = await mapConcurrent(candidates, 3, (candidate, index) =>
        resolveCandidateEvidence(candidate, index, job.draft.intent, searchPlaces, geoOpts, job.work.bias));
      job.work.evidence = [];
      for (const item of resolved) {
        if (item?.evidence) {
          job.work.evidence.push(item.evidence);
        } else if (item?.query) {
          addWarning(job, message(locale,
            `「${item.query}」无法匹配坐标，已跳过`,
            `"${item.query}" could not be matched to coordinates and was skipped`));
        }
        if (item?.error) {
          addWarning(job, message(locale,
            `「${item.query || item.error.message}」地图检索失败：${item.error.message}`,
            `Place search for "${item.query || item.error.message}" failed: ${item.error.message}`));
        }
      }
      job.work.geocodeDone = true;
      return;
    }
    if (!job.work.photosDone) {
      job.work.photosDone = true;
      const cookie = normalizeXhsCookie(await ctx.settings.get('xhs_cookie'));
      if (cookie && job.work.evidence?.length && !job.work.xhsSignedApiBlocked) {
        const destination = job.draft.intent.destination || '';
        for (const item of job.work.evidence) {
          if (job.work.xhsSignedApiBlocked) break;
          try {
            item.photoUrl = await getXhsPhoto(item.name, cookie, destination);
          } catch (error) {
            item.photoUrl = '';
            if (isXhsAuthError(error) || isXhsVerificationError(error) || isXhsRateLimitError(error)) {
              blockSignedXhs(job.work, cookie);
            }
          }
        }
      }
      return;
    }
    job.stage = 'schedule';
    return;
  }

  if (job.stage === 'schedule') {
    if (!job.work.evidence.length) throw new Error(message(locale, '没有可发布的地图证据', 'No publishable map evidence was found'));
    const split = splitRegions(job.draft.intent, job.work.evidence, locale);
    job.work.evidence = split.evidence;
    job.work.regions = split.regions;
    job.stage = 'write_copy';
    return;
  }

  if (job.stage === 'write_copy') {
    const names = job.work.evidence.map((item) => item.name).filter(Boolean);
    job.work.copy = message(locale,
      `按 ${job.draft.intent.dayCount} 天安排：${names.join('、')}。`,
      `${job.draft.intent.dayCount}-day outline: ${names.join(', ')}.`);
    job.stage = 'gate';
    return;
  }

  if (job.stage === 'gate') {
    const gated = gateAndSchedule(job.draft.intent, job.work.evidence, limits, locale, job.work.copy);
    job.draft.days = gated.days;
    for (const warning of gated.warnings) addWarning(job, warning);
    if (!job.draft.days.some((day) => day.places.length)) {
      throw new Error(message(locale, '没有可发布的地点', 'No publishable places were found'));
    }
    job.status = 'ready';
    job.stage = 'ready';
  }
}

async function testXhs(ctx, locale = 'en', keyword = '旅行', userId = null) {
  const cookie = normalizeXhsCookie(await ctx.settings.get('xhs_cookie'));
  const uid = await resolveActingUserId(ctx, userId);
  if (!cookie) {
    return {
      ok: false,
      message: message(locale, '【认证失败】未配置小红书 Cookie', '【Auth failed】Xiaohongshu Cookie is not configured'),
    };
  }
  try {
    const searchKeyword = String(keyword || '旅行').trim() || '旅行';
    // TREK settings actions time out at 15s; keep health checks single-shot and fast.
    const { notes, debug } = await withXhsRetry(
      () => searchNotesDetailed(searchKeyword, cookie, 4, { timeoutMs: 8000 }),
      { cookie, maxRetries: 0, wait: false },
    );
    await writeXhsCookieUpdatedAt(ctx, uid, cookie);
    if (!notes.length) {
      return {
        ok: false,
        count: 0,
        detail: debug,
        message: message(locale, `小红书会话可用，但「${keyword}」没有搜到笔记`, `Session works, but "${keyword}" returned no notes`),
      };
    }
    return {
      ok: true,
      count: notes.length,
      detail: debug,
      message: message(locale, `小红书会话可用，搜到 ${notes.length} 篇`, `Xiaohongshu session is available (${notes.length} notes)`),
    };
  } catch (error) {
    return { ok: false, message: formatXhsWarning(error, locale, message, { scene: 'search' }) };
  }
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_jobs', `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      work_json TEXT NOT NULL,
      error TEXT,
      committed_trip_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await ctx.db.migrate(
      '002_one_active_job',
      "CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_user ON jobs(user_id) WHERE status IN ('queued', 'running')",
    );
    await ctx.db.migrate('003_user_meta', `CREATE TABLE IF NOT EXISTS user_meta (
      user_id INTEGER PRIMARY KEY,
      xhs_cookie_updated_at INTEGER
    )`);
    await ctx.db.migrate('004_xhs_cookie_clock', `CREATE TABLE IF NOT EXISTS xhs_cookie_clock (
      fp TEXT PRIMARY KEY,
      user_id INTEGER,
      updated_at INTEGER NOT NULL
    )`);
    await ctx.db.migrate('005_xhs_cookie_clock_drop_orphans', 'DELETE FROM xhs_cookie_clock WHERE user_id IS NULL');
  },
  routes: [
    {
      method: 'GET', path: '/prefs', auth: true,
      async handler(req, ctx) {
        const limits = settings(ctx.config);
        return response(200, {
          xhsSearchAllowed: limits.xhsEnabled,
        });
      },
    },
    {
      method: 'POST', path: '/plan', auth: true,
      async handler(req, ctx) {
        const userId = req.user.id;
        const payload = { ...(req.body && typeof req.body === 'object' ? req.body : {}), locale: req.body?.locale || 'en' };
        const now = Date.now();
        const active = await ctx.db.query(
          `SELECT ${JOB_FIELDS} FROM jobs WHERE user_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`,
          userId,
        );
        if (active[0]) {
          const previous = rowToJob(active[0]);
          previous.status = 'failed';
          previous.stage = 'superseded';
          previous.error = message(payload.locale, '已用新的规划请求替换未完成任务', 'Replaced an unfinished planning job');
          await saveJob(ctx, previous);
        }
        const id = crypto.randomUUID();
        try {
          await ctx.db.exec(
            'INSERT INTO jobs (id, user_id, status, stage, payload_json, draft_json, work_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            id, userId, 'queued', 'parse_intent', JSON.stringify(payload), '{}', '{}', now, now,
          );
        } catch (error) {
          const raced = await ctx.db.query(
            `SELECT ${JOB_FIELDS} FROM jobs WHERE user_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`,
            userId,
          );
          if (raced[0]) return response(200, { jobId: raced[0].id, resumed: true });
          throw error;
        }
        return response(200, { jobId: id });
      },
    },
    {
      method: 'GET', path: '/plan', auth: true,
      async handler(req, ctx) {
        const jobId = String(req.query?.jobId || '');
        let job = jobId ? await findJob(ctx, req.user.id, jobId) : null;
        if (!jobId) {
          const rows = await ctx.db.query(
            `SELECT ${JOB_FIELDS} FROM jobs WHERE user_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`,
            req.user.id,
          );
          job = rows[0] ? rowToJob(rows[0]) : null;
          if (!job) {
            const ready = await ctx.db.query(
              `SELECT ${JOB_FIELDS} FROM jobs WHERE user_id = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 1`,
              req.user.id,
            );
            job = ready[0] ? rowToJob(ready[0]) : null;
          }
          if (!job) return response(200, { status: 'idle' });
        }
        if (!job) return response(404, {
          error: message(req.query?.locale, '未找到规划任务', 'Planning job not found'),
        });
        if (job.status === 'ready' || job.status === 'failed') return response(200, publicDraft(job));
        job = reviveStaleJob(job, job.payload?.locale || req.query?.locale || 'en');
        if (job.status === 'failed') {
          await saveJob(ctx, job);
          return response(200, publicDraft(job));
        }
        if (ticks.has(job.id)) {
          await ticks.get(job.id);
          job = await findJob(ctx, req.user.id, job.id);
          if (!job) return response(404, {
            error: message(req.query?.locale, '未找到规划任务', 'Planning job not found'),
          });
          return response(200, publicDraft(job));
        }
        const pending = Promise.resolve().then(async () => {
          try {
            await advance(job, ctx);
          } catch (error) {
            if (isTransientTickError(error)) {
              addWarning(job, message(job.payload.locale,
                '网络或地图服务暂时不可用，将自动重试…',
                'Network or map service timed out; retrying…'));
              return;
            }
            job.status = 'failed';
            job.stage = 'failed';
            const detail = error instanceof Error ? error.message : 'Planning failed';
            job.error = detail.includes('daily AI budget exhausted')
              ? message(job.payload.locale, 'AI 日额度已用完（UTC 零点重置）', 'Daily AI quota exhausted (resets at UTC midnight)')
              : detail;
          }
          await saveJob(ctx, job);
        }).finally(() => {
          if (ticks.get(job.id) === pending) ticks.delete(job.id);
        });
        ticks.set(job.id, pending);
        return response(200, publicDraft(job));
      },
    },
    {
      method: 'POST', path: '/commit', auth: true,
      async handler(req, ctx) {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const job = await findJob(ctx, req.user.id, String(body.jobId || ''));
        if (!job) return response(409, {
          error: message(body.locale, '规划任务尚未就绪', 'Planning job is not ready'),
        });
        if (job.status !== 'ready') return response(409, {
          error: message(job.payload.locale, '规划任务尚未就绪', 'Planning job is not ready'),
        });
        if (job.committedTripId) return response(200, { tripId: job.committedTripId });
        const requested = new Set(Array.isArray(body.evidenceIds) ? body.evidenceIds.map(String) : []);
        const selected = job.draft.days.flatMap((day) =>
          day.places.filter((place) => requested.has(place.evidenceId)).map((place) => ({ ...place, day })),
        );
        if (!selected.length) return response(400, {
          error: message(job.payload.locale, '草稿中没有仍被选中的证据点', 'No selected evidence remains in this draft'),
        });
        const intent = job.draft.intent;
        const trip = await ctx.trips.create({
          title: String(body.title || intent.destination || 'AI Guide').slice(0, 200),
          ...(intent.startDate ? { start_date: intent.startDate } : {}),
          ...(intent.endDate ? { end_date: intent.endDate } : {}),
          day_count: intent.dayCount,
        });
        const tripId = Number(trip.id);
        const days = await ctx.trips.getDays(tripId);
        const createdPlaceIds = [];
        try {
          for (const item of selected) {
            const dayIndex = job.draft.days.indexOf(item.day);
            const day = days[dayIndex];
            if (!day) continue;
            const place = await ctx.places.create(tripId, {
              name: item.name,
              lat: item.lat,
              lng: item.lng,
              address: item.address || '',
              notes: item.notes || '',
            });
            createdPlaceIds.push(Number(place.id));
            await ctx.itinerary.assign(tripId, Number(day.id), Number(place.id), item.notes || null);
          }
          if (!createdPlaceIds.length) return response(500, {
            error: message(job.payload.locale, '没有地点成功写入', 'No places could be written'),
            tripId,
            createdPlaceIds,
          });
          await ctx.meta.set('trip', tripId, 'ai-guide.jobId', job.id);
          job.committedTripId = tripId;
          job.draft.guides = job.draft.guides.map(({ text, ...guide }) => guide);
          await saveJob(ctx, job);
          return response(200, { tripId });
        } catch (error) {
          await rollbackCreatedPlaces(ctx, tripId, createdPlaceIds);
          return response(500, {
            error: message(
              job.payload.locale,
              `写入失败：${error.message || '未知错误'}`,
              `Commit failed: ${error.message || 'unknown error'}`,
            ),
            tripId,
            createdPlaceIds,
          });
        }
      },
    },
    {
      method: 'POST', path: '/xhs/test', auth: true,
      async handler(req, ctx) {
        return response(200, await testXhs(ctx, req.body?.locale || 'en', req.body?.keyword, req.user?.id));
      },
    },
  ],
  actions: {
    testXhs: (ctx) => testXhs(ctx, 'zh'),
  },
  async deleteUserData({ userId }, ctx) {
    await ctx.db.exec('DELETE FROM jobs WHERE user_id = ?', userId);
    await ctx.db.exec('DELETE FROM user_meta WHERE user_id = ?', userId);
    await ctx.db.exec('DELETE FROM xhs_cookie_clock WHERE user_id = ?', userId);
  },
  async exportUserData({ userId }, ctx) {
    const rows = await ctx.db.query(`SELECT ${JOB_FIELDS} FROM jobs WHERE user_id = ? ORDER BY created_at`, userId);
    return rows.map((row) => {
      const job = rowToJob(row);
      return {
        jobId: job.id,
        status: job.status,
        stage: job.stage,
        guides: (job.draft.guides || []).map((guide) => ({
          noteId: guide.noteId || null,
          url: guide.url || null,
          title: guide.title || '',
          via: guide.via,
        })),
      };
    });
  },
});
