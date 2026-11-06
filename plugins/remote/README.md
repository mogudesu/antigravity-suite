# antigravity远程-mogu

把微信 / QQ / 飞书接入 Antigravity：面板扫码绑定机器人 → 手机发消息 → 桌面会话执行 → **思考与工具过程实时流式回推** → 产出文件发回聊天。

对标 [`xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im) 的体验，但接的不是 CLI，而是 Antigravity 的**会话数据 + 界面执行**双层桥接。

> 这是 v2.0 的 Node.js 重写版。上一版 Python 实现完整保留在 [`legacy-python/`](legacy-python/)，其中的选择器实测记录仍然是这份代码的依据。

---

## 1. 为什么重写

| 维度 | 旧版（Python + 纯 DOM） | 现在 |
|---|---|---|
| 插件形态 | 外部脚本，手动开调试端口、手改 `.env` | Antigravity 标准插件：`plugin.json` + `hooks.json` + sidecar 常驻，**自动读 `DevToolsActivePort`** |
| 回复内容 | DOM `innerText`，混进"思考了 20 秒" | 读 `transcript.jsonl` 的 `PLANNER_RESPONSE.content`，**纯净 Markdown** |
| 会话列表 | 点侧边栏展开项目分组，只能拿到当前项目的 | 读 `conversation_summaries.db`，**276 个会话 + 工作区 + 运行状态**一次拿全 |
| 并发 | 按 chat 加锁，两个聊天会抢同一个输入框 | **全局 `WorkbenchMutex`** 串行化界面动作，等待阶段完全不碰界面 |
| 模型 | 只能切，不校验 | 切完**校验**，忽略思考强度差异（`…中` vs `…高` 视为同一模型） |
| 群聊 | 群里任何人说话都触发 | 严格 `@机器人` 才响应 |
| 管理面板 | 只读 | 扫码绑定 / 多机器人卡片 / 绑定会话 / 发测试消息 |

---

## 2. 架构

```
微信 iLink 官方直连 ─┐
QQ 官方 / OneBot ────┼─→ Remote Hub（src/index.mjs）
飞书 WSClient ───────┘      ├ 机器人生命周期 / 凭据库（~/.gemini/memory/antigravity-remote）
                            ├ 会话调度（排队 vs /steer 插话、超时延迟补发）
                            └ 统一斜杠命令
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        ▼                                                      ▼
  读：conversation_summaries.db（标题/工作区/状态）        写：CDP 执行器（全局互斥）
      brain/<id>/transcript.jsonl（thinking/tool/content）      切会话 → 填字 → 发送 / 切模型
```

**为什么这么分**：Antigravity 的"真相"在文件里（SQLite + JSONL），界面只用来**发起**和**点按钮**。所以等待回复不需要占用前台，你在电脑上随便切会话都不影响手机端的进度和结果。

---

## 3. 安装（插件）

```bash
cd antigravity-remote
npm install                       # 开发用
node scripts/sync-plugin.mjs      # 复制到 ~/.gemini/config/plugins/antigravity-remote-mogu
cd ~/.gemini/config/plugins/antigravity-remote-mogu && npm install --omit=dev
```

开发时想「改仓库即生效」：`node scripts/sync-plugin.mjs --link`（Windows 目录联接）。
⚠️ Antigravity 的插件列表只扫描真实目录，目录联接会被跳过；要让插件出现在「自定义配置 → 已安装」，请用默认复制模式，并在改动后重新同步。

### 自动更新

远程插件作为套装第五个组件（版本从 `0.1.0` 起），检查 `mogudesu/antigravity-suite` 最新 Release 的
`latest.json` 里 `antigravity-remote-mogu` 组件：

- 面板顶部出现「新版本 → 立即更新」；下载 zip、校验 SHA-256、备份到
  `~/.gemini/memory/antigravity-remote-backups/`，替换插件文件后由 detached helper 重启 hub。
- 用户数据（`~/.gemini/memory/antigravity-remote` 下的 secrets/state/日记）不受影响。
- MCP 工具不会热替换，更新后重启 Antigravity 才会刷新。
- 星夜美化插件的「更新」页也会列出远程插件；它对远程组件只负责触发，实际下载/替换/重启交给远程 hub。

发版时四个 UI 插件和远程插件一起打包；改源码后先 `node scripts/install-plugin.mjs`（复制模式）同步到插件目录。

**开机自启（强烈建议）**：

```bash
node scripts/install-autostart.mjs            # 在「启动」目录放快捷方式
node scripts/install-autostart.mjs --uninstall
```

为什么要它：面板注入由**常驻的 hub** 负责（每 6s 检查一次）。Antigravity 的 SessionStart 钩子在「只重启客户端」时不一定触发，hub 一旦没起来，设置页里就没有入口。装了自启后，登录即起 hub，Antigravity 每次启动/换调试端口后 6 秒内面板自动回来。

重启 Antigravity 后：
- `hooks.json` 的 `SessionStart` 自动拉起守护进程（`node scripts/autostart-hook.mjs`）；
- 设置弹窗左侧出现 **antigravity远程-mogu**，点开就是管理面板（iframe 加载 `http://127.0.0.1:8791/ui/panel.html`）；
- sidecar 也注册了同一个面板入口。

手动启动：`node src/index.mjs`（默认 `127.0.0.1:8791`）。

---

## 4. 三个渠道

### 微信（iLink 官方协议，免 PC 微信）

面板 → 添加机器人 → 微信 → **生成二维码** → 手机微信扫码确认。

- 协议版本 `2.4.6`，端点 `ilinkai.weixin.qq.com`：`get_bot_qrcode` → `get_qrcode_status`（wait/scaned/confirmed/expired）→ `getupdates`（35s 长轮询，游标持久化防漏消息）→ `sendmessage` / `sendtyping`
- 扫码者自动成为主人（`ownerUserId`），非主人消息默认忽略
- `errcode -14`（会话过期）会在面板标红提示重新扫码，不需要删配置
- 长文本按 1800 字在段落/代码块边界切分

**媒体双向**：入站图片/文件下载解密后落到 `~/.gemini/memory/antigravity-remote/tmp/` 并把路径塞进提示词；出站走 `getuploadurl` → AES-128-ECB（PKCS#7）加密 → `novac2c.cdn.weixin.qq.com/c2c/upload` → `sendmessage` 原生气泡（图片 `type=2`、文件 `type=4`）。上传响应必须带 `x-encrypted-param`，否则报错而不是静默失败。

**飞书 / QQ 媒体**：入站图片、文件、语音/视频都会先下载到同一个 tmp 目录，再把本机路径追加到提示词；飞书出站走 `im.v1.image/file.create` 上传后发原生消息（图片上限 10MB、文件 30MB），QQ 官方走 SDK `sendImage/sendFile`，OneBot 图片走 `file://`（失败回退 base64）、文件走 `upload_group_file/upload_private_file`。所有外部下载只允许公网 http(s)，并限制单文件 100MB。

**表情包**：飞书 `sticker`、QQ OneBot `face/mface`、微信 `sticker_item` 都会转成可读文本；带图片地址的 `mface` / sticker 会下载成本地图片附件交给模型识别。

### QQ

两种模式（面板里切换）：

- **官方机器人**：填 `AppID + AppSecret`，走 `@tencent-connect/qqbot-nodejs` 网关，群聊严格 `@`，私聊支持"正在输入"
- **OneBot v11（NapCat）**：面板填端口/路径，NapCat 反连 `ws://127.0.0.1:8792/onebot/ws`。读循环**不 await 业务处理**（否则等不到自己 echo 回执会自锁）

**扫码一键建 Bot**：面板「添加机器人 → QQ → 扫码创建」→ `startQrConnect({displayQrCodeToConsole:false})` 出二维码（只走面板，不往控制台打）→ 手机 QQ 扫完自动回填 `AppID/AppSecret` 并直接上线。

### 飞书

填 `App ID + App Secret`（支持 `feishu` / `lark` 域名）。

- `WSClient` 长连接，订阅 `im.message.receive_v1` + `card.action.trigger`
- **单张流式过程卡**：思考/工具步骤节流 1s 原地 `patch`，结束时定格为结果卡（模型 + 耗时）
- 群聊严格 `@机器人`（旧版"全群误触发"已修）
- 审批用交互卡片，按钮回调带幂等编号

**扫码一键建应用**：面板「添加机器人 → 飞书 → 扫码创建」→ SDK `registerApp` 出设备码二维码（`open.feishu.cn/page/launcher?user_code=...`）→ 手机飞书扫完自动创建应用、回填 `AppID/AppSecret` 并上线。

> 坑：`registerApp` 的 `domain` 要的是**主机名**（`accounts.feishu.cn`），传 `Lark.Domain.Feishu` 枚举（值为 0）会拼出 `https://0` → `Invalid URL`。
**凭据校验**：保存前调 `/open-apis/auth/v3/tenant_access_token/internal` + `/open-apis/bot/v3/info`，密钥填错立刻报错，并回显机器人真实名称与头像。

---

## 5. 面板怎么用

机器人卡片从上到下：

| 控件 | 含义 |
|---|---|
| 默认工作区 | 决定 `/sessions`、`/ws` 的默认范围，也影响"最近会话"的挑选 |
| 默认模型 | 下拉，选项来自 Antigravity 的模型菜单；`跟随界面当前模型` 表示不锁 |
| 忙碌策略 | 同一会话正在跑时：排队等它结束 / 直接插话打断 |
| 访问策略 | 仅主人白名单 / 所有人可用 |
| 双向同步 | 桌面里敲的问题和回答是否镜像到手机私聊 |
| 群聊 | 必须 `@机器人` / 群里不 @ 也响应 |
| **绑定会话** | `不指定（自动新开对话）` 或指定某个对话；选「不指定」会清空该机器人的全部旧绑定，下一条消息自动新开对话并绑定过去，不会再被旧会话劫持 |
| **回执** | 收到消息给个回执，**但不占用聊天记录**：飞书是给你那条消息**加一个表情**（原生 reaction，默认 `Get` —— 飞书中文界面里就是「收到」；面板「回执表情」可换，也可用 `bot.ackEmoji`）。注意：飞书接口里**没有字面的 `收到`** 这个 emoji_type，传了会报 231001，代码会自动退回 `OK`；微信/QQ 没有表情回应能力，发一句短文本。**只有正式答案才发文字**，过程不刷屏 |
| **自检一次** | 用本地假渠道把「发送 → 读回复」跑一遍，不依赖微信/QQ/飞书，用来判断是桥接问题还是平台问题 |

---

## 5.5 主动漫游（实验性）

面板顶部多了一张「主动漫游」卡片：

| 控件 | 含义 |
|---|---|
| 开关 | 打开后才会按生物钟自己醒来 |
| 时间段 | **一行一个时间段**（开始/结束可分别设置，能加任意多个），窗口内随机挑一分钟醒；也支持「批量粘贴」一次导入多行 |
| 随便翻翻的概率 | `skipChance`，比如 0.25 = 这趟有 25% 概率纯逛逛不推 |
| 每天最多推几条 / 最低分 | 20 分制五维评分卡，`>= minScore` 才推 |
| 巡检平台 | B 站 / 公众号 / 小红书 / 抖音 / X / 综合搜索，**勾选才会去搜**；B 站旁显示登录状态 |
| B 站扫码登录 | 点「B 站扫码登录」出官方二维码，手机扫完自动保存 cookie（只存本地、不回显），解锁关注动态/排行/字幕/弹幕 |
| 平台 Cookie | 小红书 / 抖音 / X **没有公开扫码接口**，只能把浏览器里的 Cookie 粘进来；保存后 `/read` 遇到对应域名会自动带上它直连 |
| 偏好词 | 影响选题与「和你有没有交集」这一维 |
| 立即漫游一次 | 手动跑一轮，结果直接发到绑定聊天 |

**三条硬闸（代码级，坏账本宁可不推）**：每天跨平台合计上限、7 天同一内容不重复、评分不达标不推。另有沉默衰减：连续 3 天没互动额度递减，7 天归零（你回一句话立刻满血）。

手机端命令：`/roam [关键词]`、`/read <链接>`、`/diary`、`/taste like|dislike|detail`。

**为什么只有 B 站能扫码**：B 站有官方 `passport` 扫码接口；公众号文章未登录就能读（实测 200）所以不需要登录；小红书未登录直接 302 跳登录页、抖音/X 同理，但它们都没有公开扫码 API —— 只能用「平台 Cookie」导入。其余边界：B 站四源里「关注 UP 动态 / 排行榜」需要登录 cookie，没登录会如实报 `-352/-101`；视觉九宫格要能拿到播放地址（未登录多半拿不到）；本机没装 Envoy 时 `/read` 自动退回 Jina Reader；公众号/小红书/抖音的专用探针还没做，靠通用网页读取。

---

## 6. 手机端命令

| 命令 | 作用 |
|---|---|
| `/help` `/menu` | 速查 / 数字菜单 |
| `/new [标题]` | 在默认工作区开新会话（可带模型） |
| `/ws` `/ws <n>` | 列出 / 切换工作区 |
| `/sessions` `/session <n\|id>` | 最近会话 / 接管某个会话 |
| `/models` `/model <n\|名称>` | 查看 / 切换模型（切完校验） |
| `/status` | 绑定、工作区、会话、模型、队列 |
| `/stop` | 中止当前生成 |
| `/steer <指令>` | 打断并注入新方向 |
| `/compact` | 压缩上下文 |
| `/history` | 最近几轮摘要 |

---

## 7. 私聊双向同步

机器人卡片打开「桌面 ↔ 手机镜像」后（`syncEnabled`），你在电脑 Antigravity 里敲的问题和得到的回答会镜像到绑定的私聊：

- 只读 `transcript.jsonl`，**不碰界面**，所以和提交阶段不抢锁；
- 手机自己发起的指令会被 `sessionSync.remember()` 登记后跳过，不回显；
- 按 `step_index` 去重，同一条不会推两遍。

---

## 8. MCP 主动投递

`mcp_config.json` 注册 `antigravity-remote-mogu` 服务，提供：

- `remote_send_file`：把本地文件发回聊天
- `remote_send_message`：发文本
- `remote_list_targets`：列出绑定

`rules/AGENTS.md` 里注入了约定：来自手机的消息，产出文件要主动调 `remote_send_file` 回传（`target` 写 `last` 即可，桥接层自己知道来源，**提示词里不会插任何标记**）。

---

## 9. HTTP API（面板与 MCP 用）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 桥接/机器人/运行中/待补发 |
| GET/POST | `/api/bots` | 列出 / 新增机器人 |
| POST/DELETE | `/api/bots/:id` | 更新 / 移除 |
| POST | `/api/scan` | 生成微信二维码 |
| GET | `/api/scan/:id` | 轮询扫码状态 |
| GET | `/api/conversations` | 会话（标题/工作区/状态） |
| GET | `/api/models` | 模型列表（直接读 Antigravity 的模型菜单，60s 缓存，`?force=1` 强制） |
| POST | `/api/unbind` | `{botId, chatId}` 解除某个聊天的绑定（回到跟随当前对话） |
| POST | `/api/self-test` | `{botId, text}` 本地自检：用假渠道走完整链路，返回过程与错误 |
| GET | `/api/workspaces` | 工作区汇总 |
| POST | `/api/bind` | 绑定会话 |
| POST | `/api/send` | 发消息 / 发文件（MCP 用） |
| POST | `/api/verify` | 校验飞书 / QQ 凭据（返回机器人身份） |
| GET | `/api/events` | SSE 事件流 |

凭据存 `~/.gemini/memory/antigravity-remote/secrets.json`，所有 API 返回都过 `redact()`（只露首尾 3 位）。

---

## 10. 测试

```bash
node --test          # 59 个用例
```

- **微信**：AES-128-ECB 往返（1/15/16/17/1000/64K 边界）、密钥 hex/base64 两种形态、CDN 域名白名单、`sendMedia` 全链路（getuploadurl 请求体 → 加密上传体整块对齐 → sendmessage 的 `file_item`/`image_item` 结构）
- **并发**：3 个聊天同一毫秒提交，断言 `maxActive === 1`（零串台）；排队模式先等 idle；插话模式不等待
- **飞书**：群里没 `@` 100% 静默、`@` 了才触发、机器人自己发的消息不处理
- **双向同步**：只镜像桌面输入、不回显手机自己发的、重复 tick 不重发
- **API**：真实子进程起服务 → health / 机器人 CRUD / 密钥脱敏 / 凭据校验 / 删除
- 另有 transcript 解析、会话索引（真实库）、命令引擎、OneBot 事件、卡片构建

---

## 11. 已验证 / 待你验收

**已在真机验证**
- 自动端口发现：`DevToolsActivePort` 里端口是 `53821`（每次启动都变，硬编码 9333 会挂）
- 会话索引：276 个会话、19 个工作区，标题/状态/工作区齐全
- CDP：快照读取、`location.assign('/c/<id>')` 兜底切换并校验、模型菜单读取（`Gemini 4 Argon 高` / `Claude Sonnet 5.5 中` …）
- 守护进程：`/api/health`、`/api/conversations`、`/api/workspaces` 正常

**需要你操作才能验收**
- 微信：面板扫码（我无法代扫）；扫码后发一张图/一个文件，验证入站解密与出站直传
- QQ：面板「扫码创建」或填 AppID/Secret；OneBot 反连也行
- 飞书：面板「扫码创建」或填凭据（保存时会校验并回显机器人名称）
- 飞书媒体上限：图片 10MB、文件 30MB（开放平台限制；更大的图片会按文件发送）

**已知缺口**
- 飞书 `/repair` 增量补权限只给了文案指引，没有真正拉起飞书侧扫码
- QQ 官方 Bot 媒体：图片/文件均走 SDK 上传；OneBot 文件发送依赖 NapCat 的 `upload_*_file`，图片优先本地 `file://` 路径
- 9 渠道扩展（钉钉/企微/Telegram/Discord/Slack）只留了接口，没有实现

---

## 12. 故障排查

| 现象 | 处理 |
|---|---|
| 面板打不开 | 看 `~/.gemini/memory/antigravity-remote/logs/hub.log`；确认 8791 端口没被占 |
| 重启 Antigravity 后面板入口不见了 | hub 没在跑。执行 `node scripts/install-autostart.mjs` 装开机自启；或手动 `node src/index.mjs`，6 秒内入口会自动补回 |
| 桥接显示未连接 | Antigravity 没开远程调试端口 → 重启客户端（插件会自动带参数）；或 `DevToolsActivePort` 是旧文件 |
| 消息发出但没回复 | `/status` 看运行状态；确认绑定的会话不是空的；点面板「自检一次」看具体错误 |
| 每条消息都回「绑定的模型不在当前列表里」 | 老版本 bug：切会话后界面还没渲染完就去读模型。现已等输入区就绪 + 读不到菜单重试 + 模型切不过去只警告不失败 |
| 聊天时 Antigravity 黑屏重启 | 老版本会为「切回绑定对话」强行整页跳转，正在生成时跳转可能把渲染进程搞崩。现在：界面停在新建的空对话时**不切走**、正在生成时**先等空闲**（最多 20s），并且实际发到哪个对话就把绑定改到哪个 |
| 微信 errcode -14 | 面板「重新扫码」 |
| 群里不响应 | 默认要求 `@机器人` |
| 面板开着时窗口突然关掉 | 之前读模型菜单后按 Escape 关菜单，会连带关掉设置窗口 —— 已改成再点一次触发器（不按 Escape） |
| 手机发消息后面板消失 | Antigravity 自身行为：提交消息会关闭设置模态框（它挡住了输入框）。不是崩溃，重新打开设置即可 |

---

## 13. 目录

```
antigravity-remote/
├── plugin.json / hooks.json / mcp_config.json / package.json
├── sidecars/remote_hub/sidecar.json     # 常驻守护 + 侧栏面板入口
├── rules/AGENTS.md · skills/antigravity-remote/SKILL.md
├── src/
│   ├── index.mjs                        # 守护进程：机器人 + 调度 + HTTP + SSE
│   ├── bridge/{port-discovery,conversation-index,transcript-watcher,cdp-executor}.mjs
│   ├── harness/{adapter,commands}.mjs
│   ├── channels/{weixin,qq,feishu,shared}/
│   ├── store/{paths,secret-store,state-store}.mjs
│   ├── harness/session-sync.mjs          # 私聊双向同步
│   ├── bridge/selectors.json             # 实测选择器画像（可热覆盖）
│   ├── channels/{feishu/feishu-auth,qq/qq-auth}.mjs  # 扫码建应用 / 建 Bot + 凭据校验
│   ├── ui/{panel.html,settings-injector.mjs}
│   └── mcp/remote-mcp-server.mjs
├── scripts/{autostart-hook,sync-plugin,install-plugin}.mjs
├── tests/                               # node --test
└── legacy-python/                       # v1 归档（含选择器实测记录）
```
