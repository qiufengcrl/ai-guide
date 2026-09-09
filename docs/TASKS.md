# 任务表 · AI 攻略

给 Grok Bot **项目经理**用。仓库 https://github.com/qiufengcrl/ai-guide · 当前 **v1.1.53**  
规则：只拆表、不写代码。改仓库派 Cursor Cloud Agent。不合入、不发外。

## 现在可做（已拍板）

| ID | 任务 | owner | 完成定义 |
|----|------|-------|----------|
| F21 | commit 后预算/行前/预约不丢 | 开发 | `POST /commit` 把 `budget`、`prepTips`、`reservations`、来源写入 `ctx.meta` 键 `ai-guide.handoff`；地点 `notes` 含门票/费用/预约/避坑。预览已有这些字段，缺的是写入 TREK。改 `server/trek-handoff.js`、`server/index.js`。 |
| QA-153 | 验收结果优先界面 | 测试 | 规划页：粘贴/链接/搜索；生成后四步进度；地点可勾选；无坐标可搜地址；手机能滚到生成/确认按钮，不被底栏挡住。失败交复现包。 |

## 等拍板（不要开工）

| ID | 一句话 |
|----|--------|
| F07 | 按天天气（Open-Meteo） |
| F09 | 路网距离排序（替代直线） |
| F10 | 小红书配图补全/去重 |
| F19 | 搜索排序/类型/时间筛选 |
| F11 | 每餐餐饮推荐 |
| F12 | 行程内聊天改行程 |
| F15 | 逐步审批规划 |
| F17 | 货币换算 |
| F18 | SSE 细进度 |
| F20 | 分享链接 |
| F21b | 行程内只读展示 `ai-guide.handoff`（F21 之后） |

## 不做

| ID | 原因 |
|----|------|
| F03 | 导航 TREK 自带 |
| F13 | 导出与 TREK 行程重复 |
| F14 | 实价机票酒店，合规/维护成本高 |
| F16 | 多源攻略，稀释小红书定位 |

## 已上线（勿重开）

R01–R05 小红书限流/Cookie · F01 多维搜索 · F02 广告过滤 · F04 地理边界 · F05 评论 · F06 出发前专区 · F08 三档预算（仅预览）· 按攻略还原地点天数 · 手机滚动/dock · 结果优先 UI（v1.1.53）

## 约束

- Cookie：用户本机复制，不在 TREK 服务器登录。搜失败用链接/粘贴。见 [xiaohongshu-login.md](xiaohongshu-login.md)
- 商店卡图：`docs/screenshot.png`（16:9）
