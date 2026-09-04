// Built plugin entry — runs in an isolated child process.
const crypto = require('node:crypto');
const { definePlugin } = require('trek-plugin-sdk');
const {
  EXTRACTION_SCHEMA,
  settings,
  message,
  normalizeInput,
  extractionText,
  normalizeCandidates,
  evidenceFromSearch,
  gateAndSchedule,
  publicDraft,
} = require('./pipeline');
const { fetchPublicNote, noteIdFromUrl, searchKeywordFromUrl } = require('./xhs/url');
const { normalizeXhsCookie, searchNotes, fetchSessionNote } = require('./xhs/session');
const { searchPlaces } = require('./geo/nominatim');

const JOB_FIELDS = 'id, user_id, status, stage, payload_json, draft_json, work_json, error, committed_trip_id, created_at, updated_at';
const ticks = new Map();

const json = (value, fallback) => {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
};
const response = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body });
const pauseForXhs = () => new Promise((resolve) => setTimeout(resolve, 300));

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

function addWarning(job, text) {
  job.draft.warnings ||= [];
  if (!job.draft.warnings.includes(text)) job.draft.warnings.push(text);
}

async function advance(job, ctx) {
  const locale = job.payload.locale || 'en';
  const limits = settings(ctx.config);
  job.status = 'running';

  if (job.stage === 'parse_intent') {
    const intent = normalizeInput(job.payload, limits);
    job.draft = { intent, guides: [], warnings: [], days: [] };
    if (intent.sourceText) {
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
    if (work.urlIndex < work.urls.length) {
      const value = work.urls[work.urlIndex++];
      try {
        const keyword = searchKeywordFromUrl(value);
        if (keyword) {
          if (!cookie) throw new Error(message(locale, '搜索结果链接需要用户 Cookie', 'A search-result link requires the user Cookie'));
          await pauseForXhs();
          work.pendingNotes.push(...await searchNotes(keyword, cookie, limits.maxNotes));
        } else {
          let note;
          try {
            await pauseForXhs();
            note = await fetchPublicNote(value, cookie);
          } catch (publicError) {
            const noteId = noteIdFromUrl(value);
            if (!cookie || !noteId) throw publicError;
            work.pendingNotes.push({
              noteId,
              xsecToken: '',
              title: '',
              url: `https://www.xiaohongshu.com/explore/${noteId}`,
            });
            return;
          }
          job.draft.guides.push({ ...note, id: `g_${job.draft.guides.length + 1}`, text: note.text.slice(0, 4000) });
        }
      } catch (error) {
        addWarning(job, message(locale, `链接读取失败：${error.message}`, `Could not read link: ${error.message}`));
      }
      return;
    }
    if (!work.searchAttempted) {
      work.searchAttempted = true;
      if (limits.xhsEnabled && cookie && job.draft.intent.destination) {
        try {
          await pauseForXhs();
          const automatic = await searchNotes(job.draft.intent.guideQuery, cookie, limits.maxNotes);
          const seen = new Set(work.pendingNotes.map((item) => item.noteId));
          work.pendingNotes.push(...automatic.filter((item) => !seen.has(item.noteId)));
          work.pendingNotes = work.pendingNotes.slice(0, limits.maxNotes);
        } catch {
          addWarning(job, message(locale, '小红书会话不可用，已跳过自动搜索', 'Xiaohongshu session unavailable; automatic search was skipped'));
        }
      } else if (!cookie) {
        addWarning(job, message(locale, '未配置小红书 Cookie；已继续使用表单、链接或粘贴内容', 'No Xiaohongshu Cookie is configured; continuing with form, links, or pasted text'));
      }
      return;
    }
    if (work.noteIndex < work.pendingNotes.length) {
      const item = work.pendingNotes[work.noteIndex++];
      try {
        await pauseForXhs();
        const note = await fetchSessionNote(item, cookie);
        job.draft.guides.push({ ...note, id: `g_${job.draft.guides.length + 1}`, text: note.text.slice(0, 4000) });
      } catch {
        addWarning(job, message(locale, `「${item.title || item.noteId}」正文读取失败`, `Could not read "${item.title || item.noteId}"`));
      }
      return;
    }
    job.stage = 'extract';
    return;
  }

  if (job.stage === 'extract') {
    const result = await ctx.ai.extract(
      extractionText(job.draft.guides, job.draft.intent),
      EXTRACTION_SCHEMA,
      'Extract only real places named in the supplied material. Do not invent coordinates.',
    );
    const extracted = result.results[0] || {};
    if (!job.draft.intent.destination && typeof extracted.intent?.destination === 'string') {
      job.draft.intent.destination = extracted.intent.destination.trim();
      job.draft.intent.guideQuery = `${job.draft.intent.destination} ${job.draft.intent.interests.length ? job.draft.intent.interests.join(' ') : '景点'} 旅游 景点攻略`.trim();
    }
    job.work.candidates = normalizeCandidates(extracted, job.draft.intent);
    job.work.candidateIndex = 0;
    job.work.evidence = [];
    job.work.bias = null;
    job.stage = 'gather_evidence';
    return;
  }

  if (job.stage === 'gather_evidence') {
    if (!job.work.bias && !job.work.biasFailed && job.draft.intent.destination) {
      try {
        const result = await searchPlaces(job.draft.intent.destination, { lang: locale });
        const first = (result.places || []).find((place) => Number.isFinite(place?.lat) && Number.isFinite(place?.lng));
        if (first) job.work.bias = { lat: first.lat, lng: first.lng, radius: 50000 };
      } catch (error) {
        job.work.biasFailed = true;
        addWarning(job, message(locale,
          `目的地定位失败（${error.message}），已继续逐点检索`,
          `Destination lookup failed (${error.message}); continuing per-place search`));
      }
      return;
    }
    if (job.work.candidateIndex < job.work.candidates.length) {
      const index = job.work.candidateIndex++;
      const candidate = job.work.candidates[index];
      const query = candidate.nameZh || candidate.name;
      let result = null;
      try {
        result = await searchPlaces(query, { lang: locale, locationBias: job.work.bias || undefined });
      } catch (error) {
        addWarning(job, message(locale,
          `「${query}」地图检索失败：${error.message}`,
          `Place search for "${query}" failed: ${error.message}`));
      }
      if (result) {
        const evidence = evidenceFromSearch(candidate, result, index);
        if (evidence) job.work.evidence.push(evidence);
        else addWarning(job, message(locale, `「${query}」无法匹配坐标，已跳过`, `"${query}" could not be matched to coordinates and was skipped`));
      }
      return;
    }
    job.stage = 'schedule';
    return;
  }

  if (job.stage === 'schedule') {
    if (!job.work.evidence.length) throw new Error(message(locale, '没有可发布的地图证据', 'No publishable map evidence was found'));
    job.stage = 'write_copy';
    return;
  }

  if (job.stage === 'write_copy') {
    const names = job.work.evidence.map((item) => item.name).join(', ');
    const copy = await ctx.ai.complete(
      `Write one short itinerary note in ${String(locale).startsWith('zh') ? 'Chinese' : 'English'} using only these place names: ${names}`,
      'Do not invent prices, opening hours, transport times, or places.',
    );
    job.work.copy = String(copy.text || '').trim();
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

async function testXhs(ctx, locale = 'en') {
  const cookie = normalizeXhsCookie(await ctx.settings.get('xhs_cookie'));
  if (!cookie) return { ok: false, message: message(locale, '未配置小红书 Cookie', 'Xiaohongshu Cookie is not configured') };
  try {
    await searchNotes('旅行', cookie, 1);
    return { ok: true, message: message(locale, '小红书会话可用', 'Xiaohongshu session is available') };
  } catch (error) {
    return { ok: false, message: message(locale, `小红书会话不可用：${error.message}`, `Xiaohongshu session unavailable: ${error.message}`) };
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
  },
  routes: [
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
        if (ticks.has(job.id)) return response(200, publicDraft(job));
        const pending = (async () => {
          try {
            await advance(job, ctx);
          } catch (error) {
            if (isTransientTickError(error)) return;
            job.status = 'failed';
            job.stage = 'failed';
            const detail = error instanceof Error ? error.message : 'Planning failed';
            job.error = detail.includes('daily AI budget exhausted')
              ? message(job.payload.locale, 'AI 日额度已用完（UTC 零点重置）', 'Daily AI quota exhausted (resets at UTC midnight)')
              : detail;
          }
          await saveJob(ctx, job);
        })().finally(() => {
          if (ticks.get(job.id) === pending) ticks.delete(job.id);
        });
        ticks.set(job.id, pending);
        await pending;
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
        return response(200, await testXhs(ctx, req.body?.locale || 'en'));
      },
    },
  ],
  actions: {
    testXhs: (ctx) => testXhs(ctx, 'zh'),
  },
  async deleteUserData({ userId }, ctx) {
    await ctx.db.exec('DELETE FROM jobs WHERE user_id = ?', userId);
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
