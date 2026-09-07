# AGENTS.md — TREK 插件开发规范

> 本文件是 Agent 的唯一规范来源。无需 `npm install`，不读取 `node_modules`。
> 插件是独立仓库，通过 zip 安装或 Dev-link 接入 TREK，不依赖 TREK 主仓库源码。

## 项目结构

```
my-plugin/
  trek-plugin.json      # 清单：id、type、permissions、egress
  package.json          # 可选；仅本机/CI 跑 CLI 时需要
  server/index.js       # definePlugin({ routes, hooks, ... })
  client/index.html     # UI（在 TREK 的 iframe 内运行）
  README.md
  AGENTS.md             # 本文件
```

## 云端开发流程（无 npm）

1. 直接编辑 `client/index.html`、`server/index.js`、`trek-plugin.json`
2. git commit / push
3. 在本机或 CI 执行：`npx trek-plugin-sdk pack` → 得到 zip → TREK Admin 安装
   - 或使用 Dev-link 指向本仓库目录
4. 云端**不需要**跑 `npm install` 才能写代码

---

## 一、UI 运行在沙箱 iframe 里（最重要）

| 约束 | 含义 |
|------|------|
| 无法加载 TREK 主应用 CSS | 样式必须内联在 `client/index.html` |
| 禁止外部 `<link>` / `<script src>` | 不能用 CDN、Google Fonts URL、`/assets/*.css` |
| 只能用 `window.trek` 与宿主通信 | iframe 内禁止 `fetch('/api/...')` |
| 无 localStorage / sessionStorage | 用 `trek.session` 存本 tab 的 JSON 状态 |
| `pack` 不包含 node_modules | zip 里只有 `server/`、`client/`、清单等 |

**「单独打开 HTML 正常，装进 TREK 后样式乱」** → 几乎总是没按本章规范做。

---

## 二、UI 必须：Design Kit

在 `client/index.html` 的 `<head>` 加入：

```html
<!-- trek:ui -->
```

`npx trek-plugin-sdk dev` 或 `pack` 时，会把上面一行展开为内联 CSS + JS（design kit + `window.trek` 桥接）。

### 禁止

- 外部 CSS/JS（Tailwind CDN、Bootstrap、`<link href="https://...">`）
- 硬编码颜色（`#111827`、`rgb(...)` 等）
- `body { background: #fff }`（宿主期望透明底）
- iframe 内直连 TREK REST API

### 必须

- 使用 design kit 类名（见下表）
- 颜色用 CSS 变量：`var(--text-primary)`、`var(--accent)` 等
- 用 `trek.onContext()` 响应主题切换
- 下拉框用原生 `<select>`（kit 自动美化）；要保留系统样式则加 `data-trek-native`

---

## 三、组件类名速查

### 布局

| 类名 | 用途 |
|------|------|
| `.trek-stack` | 纵向排列，gap 12px |
| `.trek-cluster` | 横向排列，可换行 |

### 容器

| 类名 | 用途 |
|------|------|
| `.trek-card` | 标准卡片（边框 + 阴影） |
| `.trek-glass` | 玻璃态面板 |
| `.trek-interactive` | 悬停上浮（加在 card/glass 上） |

### 按钮

| 类名 | 用途 |
|------|------|
| `.trek-btn` | 基础按钮 |
| `.trek-btn--primary` | 主按钮（accent 色） |
| `.trek-btn--secondary` | 次要按钮 |
| `.trek-btn--ghost` | 文字按钮 |
| `.trek-btn--danger` | 危险操作 |

### 表单

| 类名 | 用途 |
|------|------|
| `.trek-label` | 字段标签 |
| `.trek-input` | 单行输入 |
| `.trek-textarea` | 多行输入 |
| `<select>` | 下拉（自动美化，勿手写 OS 样式） |

### 文字

| 类名 | 用途 |
|------|------|
| `.trek-title` | 区块标题（大写、muted） |
| `.trek-muted` | 次要文字 |
| `.trek-faint` | 更淡的文字 |

### 其他

| 类名 | 用途 |
|------|------|
| `.trek-row` | 可点击列表行 |
| `.trek-chip` | 标签 |
| `.trek-chip--accent` / `--success` / `--danger` / `--warning` / `--info` | 标签变体 |

---

## 四、CSS 变量（颜色/主题）

用 `var(--变量名)`，不要写死 hex。宿主切换主题时会更新这些变量。

```
--bg-primary, --bg-secondary, --bg-card, --bg-input, --bg-hover
--text-primary, --text-secondary, --text-muted, --text-faint
--border-primary, --border-secondary, --border-faint
--accent, --accent-text, --accent-hover, --accent-subtle
--success, --success-soft, --danger, --danger-soft
--warning, --warning-soft, --info, --info-soft
--shadow-card, --shadow-sm, --shadow-md, --shadow-lg
--radius-sm, --radius-md, --radius-lg, --radius-xl
--font-system
```

手机端（`ctx.viewport.formFactor === 'phone'`）宿主还会下发 `--m-ink`、`--m-muted`、`--m-card` 等；使用 `.trek-*` 类时 kit 会自动适配。

自定义样式示例：

```css
.my-block {
  background: var(--bg-card);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}
```

---

## 五、最小可用页面模板

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Plugin</title>
  <!-- trek:ui -->
</head>
<body>
  <div class="trek-glass trek-stack" style="margin: 16px">
    <div class="trek-title">插件标题</div>
    <p class="trek-muted" id="status">加载中…</p>
    <button class="trek-btn trek-btn--primary" id="go">执行</button>
  </div>
  <script>
    trek.onContext(function (ctx) {
      document.getElementById('status').textContent = ctx.user ? ctx.user.name : '未登录';
    });
    document.getElementById('go').addEventListener('click', async function () {
      try {
        var data = await trek.invoke('/hello');
        trek.notify('success', data.message || '完成');
      } catch (e) {
        trek.notify('error', e.message);
      }
    });
  </script>
</body>
</html>
```

---

## 六、`window.trek` 客户端 API

```js
// 主题/用户/行程上下文（切换主题时会再次触发）
trek.onContext(function (ctx) {
  // ctx.theme          'light' | 'dark'
  // ctx.tokens         CSS 变量键值对
  // ctx.user           当前用户（可能为空）
  // ctx.tripId         当前行程 ID（可能为空）
  // ctx.viewport       { formFactor, surface, fill, insets }
  // ctx.appearance     { reducedMotion, noTransparency, ... }
});

// 调用插件自己的服务端路由（宿主代理，带用户身份）
await trek.invoke('/my-route');
await trek.invoke('/my-route', { method: 'POST', body: { key: 'value' } });

trek.notify('success' | 'error' | 'info' | 'warning', '消息文字');
trek.navigate('/trips/123');
await trek.confirm({ message: '确定删除？', danger: true });  // → true/false

// 本 tab 会话状态（非持久化，无 localStorage）
await trek.session.set('key', value, { scope: 'plugin' });  // 或 scope: 'trip'
await trek.session.get('key');
await trek.session.remove('key');

trek.resize(480);  // widget 高度（px）；page 一般由宿主撑满
```

---

## 七、服务端 `server/index.js`

```js
const { definePlugin } = require('trek-plugin-sdk');

module.exports = definePlugin({
  routes: [
    {
      method: 'GET',
      path: '/hello',
      handler: async (req, ctx) => {
        return { message: 'Hello' };
      },
    },
  ],
});
```

- TREK 运行时**自动注入** `trek-plugin-sdk`，zip 里**不需要** `node_modules`
- 权限写在 `trek-plugin.json`；未授权的 `ctx.*` 调用会抛 `PERMISSION_DENIED`
- iframe 不要直连外部 API；出网在服务端用 `fetch`，并在 manifest 声明 `egress` host

---

## 八、React / Vite 打包注意

若使用构建工具：

1. 最终产物必须是 `client/index.html`，且保留 `<!-- trek:ui -->`
2. CSS/JS 必须**内联**进 HTML，不要输出外链 `href="/assets/..."`（iframe 里会失败）
3. 构建在本机/CI 完成；云端只改源码即可

---

## 九、验证（在本机或 CI，非云端必须）

```bash
npx trek-plugin-sdk dev      # 打开 /preview 验样式（模拟 TREK iframe）
npx trek-plugin-sdk status   # 检查清单、design kit 等
npx trek-plugin-sdk pack     # 打 zip
```

- `/preview` = 真实 TREK 环境模拟（**用这个验样式**）
- `/ui` = 裸 HTML，**不能**代表 TREK 内效果

---

## 十、问题排查

| 现象 | 原因 | 处理 |
|------|------|------|
| TREK 内乱、单独打开正常 | 缺 `<!-- trek:ui -->` 或用了外部 CSS | 加 marker，改用 `.trek-*` |
| 切换主题后颜色不对 | 硬编码颜色 | 改用 `var(--*)` + `onContext` |
| 下拉框像系统原生菜单 | 没 design kit | 加 `<!-- trek:ui -->` |
| iOS 输入时页面放大 | 字号 < 16px | 用 `.trek-input`（手机端 kit 设 16px） |
| API 401 | iframe 直连 REST | 改用 `trek.invoke('/插件路由')` |
| 状态丢失 | 用了 localStorage | 改用 `trek.session` |

---

## 十一、官方在线文档（可选深入阅读）

以下链接供人工或 Agent 联网查阅，**不是开发前提**：

- Plugin Development Wiki：https://github.com/liketrek/TREK/wiki/Plugin-Development
- SDK README：https://github.com/liketrek/TREK/blob/dev/plugin-sdk/README.md
- Design kit 源码（完整类名/token）：https://github.com/liketrek/TREK/blob/dev/plugin-sdk/src/ui/kit.ts

**Agent 优先读本文件；以上链接仅在需要更多细节时查阅。**
