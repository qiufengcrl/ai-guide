# Grok Bot 公用编制套件

一套**不绑仓库**的软件交付编制：项目经理 → 开发 → 测试 → 评审（可选调研、发布）。
把每个岗位的「Edit Profile」描述粘进 [Grok Bot](https://docs.x.ai/grok-bot)，即可在任意产品上复用。

本目录不是 TREK 插件代码，也不会打进 plugin zip。复制整个 `docs/grok-bot-kit/` 到别的仓库，或只把岗位描述贴进 Grok Bot 即可。

官方依据：

- 创建与编制：[Create and manage Bots](https://docs.x.ai/grok-bot/bots)
- 用例（含 Bug Reproduction）：[Use cases](https://docs.x.ai/grok-bot/use-cases)
- 群聊与交接：[Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)
- Skill / Routine：[Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- 审批与共享电脑：[Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)

---

## 先记住四条

1. **一个 Bot = 一份长期岗位**，不要建「万能助手」。通用助手没有可复用的记忆边界。
2. **全员共用同一台云电脑**。第二个 Bot 不是沙箱：文件、浏览器登录、终端凭据对编制里所有人可见。
3. **群聊最多 6 个 Bot**。先建 4 人核心组，只有稳定专科再加第 5、第 6 个。
4. **写代码的人不能验自己的活，验的人不能合入。** 合并、发送、付款、改生产一律等人点头。

---

## 推荐编制（默认 4 人）

| 顺序 | 名称 | 头衔 | 拥有的结果 | 绝不做 |
|:----:|------|------|------------|--------|
| 1 | 项目经理 | Orchestrator | 拆任务、指派、看板、阻塞清单 | 写代码、当测试、合入 |
| 2 | 开发 | Implementer | 可审查的改动 / 草稿 PR | 自己验收、合入、改生产 |
| 3 | 测试 | Verifier | 复现包、测试证据、通过/失败 | 补实现、合入、用生产用户数据 |
| 4 | 评审 | Reviewer | 只列阻断项的审查包 | 自己改代码来“修审查”、合入 |

可选（仍不超过 6）：

| 顺序 | 名称 | 头衔 | 何时加入 |
|:----:|------|------|----------|
| 5 | 调研 | Researcher | 需求不清、要对照竞品或文档时 |
| 6 | 发布 | Release | 需要变更说明、预发检查清单时 |

账号级另建一个 **幕僚长（Chief of Staff）** 做每日摘要，不要塞进每个项目群。

岗位全文见 [`roster/`](roster/)。全员禁令见 [`SHARED.md`](SHARED.md)。群聊开工词见 [`GROUP.md`](GROUP.md)。例程见 [`ROUTINES.md`](ROUTINES.md)。

---

## 在 Grok Bot 里怎么装

1. 打开 Grok Bot 桌面或 iOS 应用。
2. 侧栏 **New**（或 `Cmd/Ctrl+N`）→ **Create new agent**。
3. **Bot actions → Edit Profile**：名称、头衔、描述、头像。描述贴对应 `roster/*.md` 里「粘贴到 Edit Profile」整段。
4. 先给这个 Bot **一件真实、可审查的任务**（各岗位文件里有「第一件任务」）。
5. 结果稳定后，让它把流程存成 Skill；例程只在失败路径也写清之后再开。
6. 四个核心岗位都建好后：**New chat**，勾选这 4 个 Bot，把 [`GROUP.md`](GROUP.md) 开工词贴进去。

复制已有岗位到新范围（例如「同一开发岗，换一个产品」）：用 **Duplicate**。副本带档案、Skill、例程、头像，**不带**对话、记忆、附件。复制后立刻改名称和范围，再派活。

公开分享链接会暴露档案、Skill、例程。分享前删掉密钥、内网 URL、客户数据。对方加的是副本，拿不到你的电脑和登录。

---

## 工作怎么流

```
你（唯一可以派新活、合入、发外的人）
        │
        ▼
   项目经理  ──拆任务、看板、阻塞──►  @开发 / @测试 / @评审 / @你
        │
        ├── @开发  实现，停在草稿 PR
        │       └── @测试  复现 / 回归，给出证据
        │               └── 失败 → 交回 @开发；通过 → @评审
        └── @评审  只报阻断项 → 你决定合入
```

群里用 `@名称` 指定负责人。不要 `@everyone` 刷状态。每个阶段只保留一个 owner。

---

## 什么时候不要加 Bot

- 只是偶尔问一句 → 在现有岗位对话里说，不要新开编制。
- 想「隔离权限」→ 加 Bot **做不到**。登出服务、删文件、撤连接器。
- 想凑满座位 → 先砍编制。闲置 14 天的岗位先 **Hide**，不要 Delete（删除会带走它的例程）。

账号上限：Bot + 群聊合计最多 50。单个 Bot 最多 50 条例程。

---

## 和 Cursor Cloud Agent 的分工

| | Grok Bot | Cursor Cloud Agent |
|--|----------|-------------------|
| 形态 | 长期岗位，有记忆和例程 | 一次任务、一条分支、一个 PR |
| 电脑 | 账号共享的持久云电脑 | 每次运行独立环境 |
| 适合 | 编排、复现、审查包、例行准备 | 改这个仓库的代码并提 PR |

项目经理可以 **派** Cloud Agent 做实现，但合入权仍在你。Grok Bot 若被允许拉起 Cloud Agent，会消耗 Cursor 用量；在岗位描述里写清「可以草稿 PR，不可合并」。
