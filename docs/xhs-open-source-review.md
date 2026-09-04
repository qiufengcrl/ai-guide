# 小红书 Cookie 搜索：限流与空结果对照

对照仓库（2026-09 公开代码）：

| 项目 | 星标量级 | 读笔记方式 |
|---|---|---|
| [1sdv/TripStar](https://github.com/1sdv/TripStar) | 同场景旅行 Agent | Cookie + 原生签名直连 `edith`，失败再 SSR |
| [LeeFly-cn/TripStar-Java](https://github.com/LeeFly-cn/TripStar-Java) | TripStar 的 Java 移植 | 同上，并把搜索/公开页拆成两条链路 |
| [ReaJason/xhs](https://github.com/ReaJason/xhs) | ~2.2k | Web API 封装，搜索必须带 `search_id`，详情必须带 `xsec_token` |
| [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | ~15k | **真实浏览器会话**，不拿 Cookie 去打 `edith` |
| [jackwener/xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli) | ~2.5k | 签名 + 1s 间隔 + 抖动 + 验证码冷却 |

本插件是 TREK 沙箱里的 `fetch` 客户端：`nativeModules: false`，不能跑 Playwright，也不应内嵌第三方反风控签名脚本。

## 为什么容易限流

本插件原先对 `edith.xiaohongshu.com` 只发 `cookie` + `content-type` + Chrome 120 UA。TripStar / ReaJason / xiaohongshu-cli 的 Web 请求还会带：

- 浏览器同源头：`origin`、`referer`、`accept-language`
- 设备 Cookie：`a1`、`web_session`（签名还依赖 `a1`）
- 请求签名头：`x-s`、`x-t`、`x-s-common`、`x-b3-traceid`

缺签名时，接口常返回 `code=300011` /「账号异常」，或 `success=true` 但 `items` 为空。这不是「没搜到」，而是会话被静默丢弃。

另外几条会把账号和出口 IP 一起打脏：

1. **公开 HTML 仍带用户 Cookie**。TripStar-Java 明确：指定笔记模式读 `www.xiaohongshu.com/explore/...` **不带 Cookie**。数据中心 IP + 登录 Cookie 是典型风控组合。
2. **300ms 连打**。搜索一次后立刻拉最多 8 条详情，再 SSR 兜底。xiaohongshu-cli 默认间隔约 1s，并加高斯抖动；ReaJason 在翻页循环里 `time.sleep(crawl_interval)`。
3. **461/471 验证码未识别**。ReaJason 把这两种状态单独打成 `NeedVerifyError`。本插件之前只看 JSON `success`，验证码页会被当成普通失败并继续重试。

## 为什么经常搜不到文章

TripStar-Java 的注释写得很直接：

> 搜索接口虽然暴露 `page_size` 字段，但实测传 5 或 10 会返回 `success=true` 且没有 `items`；Python 版 TripStar 一直按 20 请求。

本插件原先把 `page_size` 设成 `maxNotes`（默认 4，探测接口甚至是 1）。这会稳定制造「成功但空列表」。

其余空结果来源：

| 点 | 本插件原先 | 开源项目 |
|---|---|---|
| `search_id` | 无 | ReaJason `get_search_id()`；TripStar 用 21 位 trace id |
| `filters` | 无 | TripStar 带综合排序 + 「不限」筛选 |
| 公开页 URL | `/explore/{id}`，丢掉 query | ReaJason：`/explore/{id}?xsec_token=...&xsec_source=...` |
| 短链 | 只跟 `Location`，丢掉 token | TripStar-Java 从跳转 URL / HTML 取出 `xsec_token` |
| 空列表 | 当「没搜到」 | 先排除 page_size / 会话失效，再当空查询 |

探测接口 `testXhs` 用 `page_size=1` 时，即使 Cookie 有效也会空返回，无法区分「没登录」和「协议字段不对」。

## 值得借鉴

**应落地（协议与产品，不碰签名逆向）：**

1. 底层搜索固定 `page_size=20`，业务层再截成 `max_notes`。
2. 补 `search_id` 和 TripStar 同结构的 `filters`。
3. 补 `origin` / `referer` / `accept-language`；公开页补 `Accept: text/html`。
4. 校验 Cookie 至少含 `a1` 和 `web_session`。
5. 公开 HTML **不带** Cookie；explore URL **保留** `xsec_token`。
6. 请求间隔提到约 1s，并识别 461/471。
7. `success=true` 但 `items` 为空时给出明确警告，不要假装搜过。

**值得借鉴、但本沙箱做不了 / 不应做：**

- TripStar 的 `x-s` / `x-s-common` 本地 JS 签名。能压低 300011，但依赖逆向脚本，易失效，也不适合 `nativeModules: false` 的插件分发。
- xiaohongshu-mcp 的真实浏览器。这是目前最稳的登录态方案，但插件进程里没有 Chrome。
- 图片缓存、按「最新」搜图、指定笔记与关键词搜索分接口：产品层有用，和本次空搜索不是同一类 bug。

**不建议搬：**

- Cookie 池、多账号轮换、验证码自动过。那是采集器策略，会扩大对用户账号的伤害。
- 把用户 Cookie 打进日志或模型 prompt。本插件现有隔离应保持。
