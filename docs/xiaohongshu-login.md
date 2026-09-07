# 在 Linux / TREK 服务器上如何配置小红书 Cookie

TREK 跑在 Linux 服务器上，**不要在那台服务器里登录小红书**。Cookie 是你个人浏览器的登录态，应在自己的电脑或手机上取得，再粘贴到 TREK 插件设置。无头服务器没有扫码界面，也不适合保存个人会话。

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
