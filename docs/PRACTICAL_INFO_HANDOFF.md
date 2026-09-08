# 实用信息持久化与 TREK 展示方案

> 文档版本：2026-09-08  
> 基线版本：**v1.1.44**  
> 状态：**方案确认稿**（待开发）  
> 关联：`docs/ROADMAP.md` 阶段 B 已完成预览侧能力；本文档定义 **commit 后** 如何把交通、门票、预约、美食、预算等写入 TREK 行程并在原生 UI 可读。

---

## 1. 背景与目标

### 1.1 问题

v1.1.44 已在**预览页**提供：

| 能力 | 预览 UI | commit 后 TREK |
|------|:-------:|:--------------:|
| 地点 reason / 预约标记 | ✅ | ✅（`description` + `notes` 部分） |
| 出发前准备 `prepTips`（分类） | ✅ | ❌ 仅每个地点最多 3 条相关 prep 写入 `notes` |
| 预约汇总表 `reservations` | ✅ | ❌ 分散在各地点 `notes` |
| 三档预算 `budget` | ✅ | ❌ 完全丢失 |
| 评论区提示 `commentTips` | ✅ | ✅（写入地点 `notes`） |
| 来源笔记链接 | ✅ | ✅（`notes` 末尾） |
| 门票/开放时间结构化字段 | 部分（prep 分类） | ❌ 无独立字段 |

用户确认「交通、门票、美食、预约等应记录进攻略」——核心缺口是 **预览与 TREK 行程数据断层**，而非提取能力不足。

### 1.2 目标

1. **commit 不丢关键实用信息**：预算、行前准备、预约表、门票线索在 TREK 行程中可找回。
2. **尊重 TREK 插件约束**：不假设未文档化的 `ctx.trips` 扩展字段；优先 `places.notes`、`itinerary` 备注、`ctx.meta`。
3. **原生 UI 优先可读**：地点详情、日程备注在 TREK 主应用打开即可读；插件页作为「攻略来源」补充视图。
4. **可渐进交付**：分 P0/P1/P2，每阶段可独立发版。

### 1.3 非目标（本方案不做）

- 实时票价/酒店询价（见 ROADMAP F14）
- 独立 HTML/PDF 路书交付（见 F13；可与本方案后期叠加）
- 改造 TREK 核心 schema（需上游 Issue，不在插件单仓解决）

---

## 2. 现状审计（v1.1.44）

### 2.1 数据流

```
小红书/粘贴 → pipeline 提取 → draft（days + prepTips + budget + reservations）
                                    ↓
                              预览 client/index.html
                                    ↓ POST /commit
                    buildTrekPlacePayload → ctx.places.create
                                         → ctx.itinerary.assign(notes)
                    ctx.meta.set('trip', tripId, 'ai-guide.jobId', job.id)
```

### 2.2 地点 `notes` 当前拼装逻辑

`server/guide-quality.js` → `buildTrekPlaceNotes`：

1. `reason`（游玩建议）
2. `预约：…`（若 `reservationRequired` / `reservationTips`）
3. `出发前提示：…`（来自**该地点关联笔记**的 prep，最多 3 条）
4. `评论区提示：…`
5. `来源：标题 + URL`

上限 **2000 字符**；无 Markdown 结构；行程级 `prepTips` / `budget` 不进 commit。

### 2.3 已有 TREK 写入面

| API | 用途 | 权限 |
|-----|------|------|
| `ctx.places.create(tripId, payload)` | `name, lat, lng, address, notes, description, duration_minutes, category_id, image_url` | `db:write:places` |
| `ctx.itinerary.assign(tripId, dayId, placeId, notes)` | 日程项备注（当前复用 place notes） | `db:write:itinerary` |
| `ctx.meta.set('trip', tripId, key, value)` | 插件自定义 JSON（已有 `ai-guide.jobId`） | `db:meta` |
| `ctx.trips.create` | `title, start_date, end_date, day_count` | `db:create:trips` |

**结论**：行程级结构化数据应走 `ctx.meta`；地点级实用信息继续强化 `notes` 模板，并可选拆分 `description`（短摘要）与 `notes`（长备注）。

---

## 3. GitHub 竞品调研摘要

> 调研日期：2026-09；详见 ROADMAP §2。本节只提炼**与持久化/展示相关**的模式。

### 3.1 信息分层模式（共性）

| 层级 | 典型内容 | 代表项目 |
|------|----------|----------|
| **行程级** | 预算三档、行前检查清单、签证/换汇、总预约表 | travel-planner-skill、On-The-Road |
| **日级** | 当日主题、交通方式、天气、里程 | skills-travel-planner `tripData.days[]` |
| **点级** | 门票、开放时间、预约渠道、人均、避坑 | 全部项目 |
| **来源级** | 笔记链接、更新时间 | ai-guide 已有 |

### 3.2 各项目可借鉴点

#### [travel-planner-skill](https://github.com/ycyliu/travel-planner-skill)

- **板块**：预约与行前准备、预算预估（经济/舒适/豪华 + 交通/住宿/门票/餐饮）、出发前检查清单。
- **借鉴**：预览与交付物使用**同一套板块顺序**；预算必须带免责声明。
- **差异**：输出自包含 HTML，无「写入地图行程」；我们需映射到 TREK meta + place notes。

#### [skills-travel-planner](https://github.com/huanyuzhilv/skills-travel-planner)

- **数据**：中心化 `tripData.json`（行程 meta + `days[]` + 每日 `places[]` + 费用块）。
- **借鉴**：**单一 JSON 真相源**，HTML/PDF 仅作渲染；对应我们 `draft` → commit 时序列化到 `ctx.meta`。
- **字段示例**：住宿列表、门票明细（含电瓶车/扶梯）、成人/儿童价——适合作为 `budget.clues` / `prepTips` 的 schema 参考。

#### [On-The-Road](https://github.com/Ryanuppp/On-The-Road)

- **板块**：费用明细、导航链接、进度勾选、广告过滤。
- **借鉴**：地点卡片上**费用与预约**与地图坐标并列；导航由 TREK 自带（ROADMAP F03 不做）。

#### [trip_agent](https://github.com/rylynn/trip_agent)

- **借鉴**：预算图表化、多源合并；我们仅借鉴**分项预算展示**（交通/住宿/门票/餐饮），不做实时图表。

#### [Navoryn](https://github.com/mrinali123/Navoryn)

- **借鉴**：确定性校验（已做 F04）、天气（F07 候选）；实用信息以**侧边栏 + 地点 warnings** 呈现。

### 3.3 UI 规划对照

| 竞品 UI 区块 | ai-guide 预览（v1.1.44） | commit 后建议 |
|--------------|-------------------------|---------------|
| Hero / 行程摘要 | 意图表单 + 来源摘要 | TREK 行程标题/日期（已有） |
| 预算卡片 | `#budget-card` | **行程 meta** + 插件「已生成攻略」只读页 |
| 出发前 / 避坑 | `#pane-prep` | **行程 meta `prepTips`** + 地点 notes 摘录 |
| 预约表 | `#prep-reservations` | **行程 meta `reservations`** + 地点 notes 预约行 |
| 每日时间线 | 按天勾选列表 | TREK 日程（已有） |
| 地点详情 | 地点 inspector | TREK 地点 `description` + `notes` |
| 来源追溯 | 来源 chips | meta `sources` + 地点 notes 来源行 |

---

## 4. 目标数据模型

### 4.1 行程级 meta（`ctx.meta`，namespace `ai-guide`）

commit 时除 `ai-guide.jobId` 外，新增 **`ai-guide.handoff`**（JSON 字符串或对象，以 SDK 实际类型为准）：

```json
{
  "version": 1,
  "generatedAt": "2026-09-08T00:00:00.000Z",
  "locale": "zh",
  "destination": "京都",
  "dayCount": 3,
  "budget": {
    "currency": "JPY",
    "days": 3,
    "estimated": true,
    "source": "notes+model",
    "disclaimer": "Rough totals from notes, not live prices.",
    "economy": { "transport": 0, "lodging": 0, "tickets": 0, "food": 0, "total": 0 },
    "comfort": { },
    "luxury": { },
    "clues": [{ "kind": "ticket", "amount": 400, "currency": "JPY" }]
  },
  "prepTips": [
    { "category": "booking", "text": "热门景点需提前 7 天预约" },
    { "category": "transit", "text": "巴士一日券划算" }
  ],
  "reservations": [
    { "name": "清水寺", "dayTitle": "Day 1", "tips": "需提前预约" }
  ],
  "sources": [
    { "id": "g_1", "title": "京都三日", "url": "https://...", "via": "search" }
  ],
  "warnings": ["部分笔记为营销帖已过滤"]
}
```

**体积控制**：`prepTips` ≤ 20 条；`sources` 保留标题+URL，**不存** `guide.text`；`budget` 与预览 `publicDraft` 同构。

### 4.2 地点级 payload（`buildTrekPlacePayload` 扩展）

在现有字段基础上，结构化扩展 **写入文本**（不新增 TREK 列）：

| 字段 | 写入目标 | 说明 |
|------|----------|------|
| `reason` | `description` | 保持 ≤2000，短摘要优先 |
| 预约 | `notes` 固定行 | `预约：…` |
| 门票/开放时间 | `notes` | 从 prep/评论提取的 `hours`/`ticket` 类 |
| 人均/价格线索 | `notes` | 单行 `费用参考：…`（注明非实时） |
| 美食相关 | `category_id` → food | `categoryHint: 'food'` 已有逻辑 |
| `commentTips` | `notes` | 已有 |
| `prepTips`（地点级） | `notes` | 已有，可增至 5 条 |
| 来源 | `notes` 末尾 | 已有 |

**notes 模板（中文）建议顺序**：

```
{reason 若未放 description}

预约：{reservationTips}
门票/开放：{hoursAndTickets}
费用参考：{priceClue}（来自笔记，非实时价格）
出发前提示：{prepTips}
评论区提示：{commentTips}

来源：{links}
```

仍 `slice(0, 2000)`；超长时按优先级截断：来源 > 预约 > 评论区 > prep > 费用。

### 4.3 日程级（可选 P2）

若 `ctx.itinerary.assign` 支持与日不同的 `notes`，可为**每天第一条**写入当日交通摘要（从 `prepTips` 中 `category=transit` 且匹配 `dayTitle` 的条目）。需实测 TREK 行为；P0 可仅用行程 meta。

---

## 5. TREK 内展示策略

### 5.1 原生行程（无需改 TREK 核心）

| 用户入口 | 看到什么 |
|----------|----------|
| 地图 / 地点详情 | `description` + `notes`（含预约、门票、避坑、来源） |
| 日程列表 | 地点名 + 时长；备注取决于 TREK 是否展示 itinerary notes |
| 行程设置 | 标题、日期（已有） |

### 5.2 插件「行程攻略」视图（推荐 P1）

当 `ctx.tripId` 存在且 meta 含 `ai-guide.handoff` 时，插件页展示只读卡片（复用预览组件逻辑）：

- 预算三档（与 `#budget-card` 同组件）
- 出发前准备（与 `#pane-prep` 同组件）
- 预约表
- 来源笔记列表（链出小红书，不展示全文）

**路由**：`GET /trip-handoff?tripId=` 或检测 `trek.onContext` 的 `ctx.tripId` 自动加载。

### 5.3 入口引导（P1）

commit 成功响应增加：

```json
{ "tripId": 123, "handoffSaved": true, "openHint": "budget_and_prep_in_trip_meta" }
```

客户端 `trek.notify` + 可选 `trek.navigate('/trips/{id}')`；README 说明「地点备注 + 插件内查看完整预算/行前」。

---

## 6. 实施分期

### P0 — commit 不丢行程级信息（建议 v1.1.45）

| 任务 | 文件 | 说明 |
|------|------|------|
| 抽取 `buildTripHandoff(draft, job)` | `server/trek-handoff.js` | 从 draft 生成 §4.1 JSON |
| commit 写入 meta | `server/index.js` | `meta.set('trip', tripId, 'ai-guide.handoff', …)` |
| 强化地点 notes 模板 | `server/guide-quality.js` | 门票/费用行；截断优先级 |
| 测试 | `test/ai-guide.test.js` | meta 内容、notes 模板、commit 顺序 |
| 文档 | 本文件 §6 P0 验收 | — |

**验收标准**：

- commit 后 `ai-guide.handoff` 含 `budget`、`prepTips`、`reservations`、`sources`
- 地点 `notes` 含预约与至少一类门票/费用/prep（有数据时）
- 现有 91+ 测试全绿

### P1 — 行程内可读 UI（建议 v1.1.46）

| 任务 | 文件 | 说明 |
|------|------|------|
| `GET /trip-handoff` | `server/index.js` | 读 meta + 权限校验 |
| 行程上下文 UI | `client/index.html` | `ctx.tripId` 时显示 handoff 卡片 |
| i18n | `client/index.html` | 中英标签 |
| commit 成功提示 | `client/index.html` | 告知预算/行前已保存 |

**验收标准**：在 TREK 打开已 commit 行程，进入插件可见预算与行前区块。

### P2 — 提取与美食深化（建议 v1.2.x）

| 任务 | 说明 |
|------|------|
| F11 餐饮 POI | 午餐/晚餐推荐写入独立地点或 `categoryHint: food` |
| LLM schema | `ticketPrice`、`openingHours`、`priceHint` 结构化字段进 extract |
| 日级交通 | itinerary 日备注（若 API 支持） |
| 导出 | handoff JSON → 简易 HTML 片段（F13 子集） |

---

## 7. 文件改动清单（P0 预估）

```
server/trek-handoff.js     + buildTripHandoff()
server/guide-quality.js    + formatHoursTicketLine(), notes 截断
server/index.js            + commit 写 ai-guide.handoff
test/ai-guide.test.js      + handoff/meta/notes 断言
docs/PRACTICAL_INFO_HANDOFF.md  （本文档）
docs/ROADMAP.md            + 引用与 F21 登记
```

**不改**：`trek-plugin.json` 权限（已有 `db:meta`）；预览 UI 布局（P0 仅后端）。

---

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| `meta` 体积限制未知 | 不存 guide 正文；prep ≤20；budget 仅数字 |
| `notes` 2000 字不够 | 优先级截断 + 完整 prep/budget 在 meta |
| 价格误导 | 文案固定「来自笔记/估算，非实时」；budget 带 `estimated: true` |
| 用户删插件后 meta 残留 | 可接受；或 `deleteUserData` 不删 trip meta（归属行程） |
| 多语言 | handoff 存 `locale`；notes 按 commit 时 locale 生成 |

---

## 9. 确认与跟踪

- [ ] P0：`ai-guide.handoff` meta 写入
- [ ] P0：地点 notes 模板增强
- [ ] P1：行程内 handoff 只读 UI
- [ ] P2：餐饮 POI + 结构化门票字段

确认后请将 P0 拆为 GitHub Issue，并在 ROADMAP 登记 **F21 — 实用信息 commit 持久化**。

---

## 10. 文档维护

| 日期 | 变更 |
|------|------|
| 2026-09-08 | 初版：竞品调研摘要、数据模型、分期与验收标准 |
