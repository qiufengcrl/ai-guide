# 在 Linux / TREK 服务器上如何配置小红书 Cookie

TREK 跑在 Linux 服务器上，**不要在那台服务器里登录小红书**。Cookie 是你个人浏览器的登录态，应在自己的电脑或手机上取得，再粘贴到 TREK 插件设置。无头服务器没有扫码界面，也不适合保存个人会话。

## 先说清楚：换 IP 会不会 461？

会，而且很常见。

关键词搜索、评论区、配图走的是 **TREK 服务器出口 IP** 去请求 `edith.xiaohongshu.com`。你在家宽/手机（IP1）登录拿到的 `web_session`，贴到云主机（IP2）上用，小红书会把这次请求看成「换设备 / 换网络」，经常返回 **461 验证/风控**。机房 IP 比家宽更容易被拦。

这不是插件漏签，也不是 Cookie 复制错了就一定能好。平台把会话和网络环境绑在一起，插件无法在服务器上「假装还是 IP1」。

保存 Cookie 后先点 **测试小红书会话**：

- 测试通过：当前这台 TREK 的出口 IP 暂时能用这份 Cookie，可以开关键词搜索。
- 测试就是 461：不要依赖搜索。改用 **小红书链接** 或 **粘贴正文**（公开页不带 Cookie，不走 signed API）。行程照样能生成。
- 生成中途 461：插件会跳过搜索/评论，降级继续，不会整单失败。

想让搜索更稳，只能让 **登录出口和 TREK 出口尽量同一类网络**（例如 TREK 跑在家里的机器/同网段），而不是云厂商机房。不要在服务器上跑无头浏览器登录。

## 正确流程

1. **在自己的设备上登录**  
   用电脑或手机的 Chrome / Firefox 打开 [www.xiaohongshu.com](https://www.xiaohongshu.com) 并完成登录。

2. **复制 Cookie**（任选一种）  
   - 开发者工具 → **Network** → 任选一条 `edith.xiaohongshu.com` 请求 → Headers → Request Headers → `Cookie`  
   - 或 **Application / 存储** → Cookies → `www.xiaohongshu.com`，把需要的键拼成一行  

   必须包含 `a1` 和 `web_session`，例如：

   ```
   a1=…; web_session=…; xsecappid=xhs-pc-web
   ```

3. **粘贴到 TREK**  
   打开 TREK → **设置 → 插件 → AI 攻略 → 小红书 Web Cookie** → 保存 → 点 **测试小红书会话**。

Cookie 只留在插件服务端，不会进入插件页面、AI 提示词、草稿、日志或用户数据导出。大约一周可能过期；搜索失败或提示过期时，按上面步骤再复制一次。

## 如果日常只用 Linux

- **可以**：带桌面环境的 Linux（Chromium / Firefox）登录后按同样步骤复制。  
- **可以**：从你自己的笔记本 SSH 到服务器管理 TREK，但 Cookie 仍从笔记本浏览器复制。  
- **不要**：在 TREK 的 Docker / 宿主机上开无头浏览器扫码登录。  
- **不要**：多人共用同一份 Cookie。

公开笔记链接、粘贴攻略正文、只填目的地生成行程，都不需要 Cookie。Cookie 只用于可选的关键词搜索和评论区增强。
