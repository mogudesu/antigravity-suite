# antigravity浏览器控制 · Antigravity Browser Bridge

让 Antigravity 直接驱动**你日常在用的 Edge / Chrome**：读页面、点按钮、填表单、截图、看控制台和网络记录，全程保留你自己的登录态和已装的扩展。浏览器里显示的扩展名是 **antigravity浏览器控制**，控制助手叫 **谷谷嘎嘎**。

形态是 **MCP 服务 + MV3 浏览器扩展**：Antigravity 启动本地 MCP 服务，扩展主动连上这个服务，工具调用经 WebSocket 转给扩展，由扩展用 CDP（`chrome.debugger`）或页面脚本在真实标签页里执行。

---

## 和 Antigravity 自带的浏览器能力有什么区别

| | Antigravity 自带浏览器子代理 | 本插件 |
| --- | --- | --- |
| 浏览器实例 | 官方扩展 + 受管的独立 Chrome | 你正在用的 Edge / Chrome |
| 登录态 | 干净实例，需要重新登录 | 你现有的 Cookie、账号、扩展全在 |
| 调用方式 | `/browser` 斜杠命令交给子代理 | 标准 MCP 工具，主代理直接调 |
| 可控粒度 | 由子代理决定 | 每个动作（点击/输入/求值）都是显式工具 |

两边不冲突，可以同时装着。

---

## 目录结构

```
antigravity-browser-bridge/
├── extension/                  # 浏览器扩展（Edge / Chrome 通用，MV3）
│   ├── manifest.json
│   ├── background.js           # service worker：WebSocket 桥 + 工具分发 + 控制提示调度
│   ├── cdp.js                  # chrome.debugger 封装（真实输入、截图、求值、日志）
│   ├── banner.js               # 控制提示条的注入 / 移除（service worker 侧）
│   ├── banner-page.js          # 控制提示条的页面组件（隔离世界，Shadow DOM 胶囊）
│   ├── page-actions.js         # 注入页面的动作层（snapshot / 定位 / 输入 / 等待）
│   ├── popup.html/.js/.css     # 弹窗：连接状态、端口、令牌、搜索地址
│   └── icons/
├── mcp-server/                 # 本地 MCP 服务（Node.js，stdio）
│   ├── server.js               # MCP JSON-RPC 主循环 + Leader/Follower 中继 + browser_launch
│   ├── bridge.js               # HTTP /status · POST /rpc · WebSocket /bridge、请求响应配对、心跳
│   ├── launch.js               # browser_launch：定位 Edge/Chrome、拼装命令行、等待扩展握手
│   └── tools.js                # 18 个工具的 JSON Schema
├── config/
│   └── mcp_config.example.json # 贴进 Antigravity 的配置片段
├── mcp_config.json             # 插件级 MCP 注册（真实 node.exe 与绝对 server.js 路径）
├── plugin.json                 # Antigravity 插件清单
├── skills/browser-bridge/      # SKILL：browser_launch → snapshot → click → 再 snapshot
├── rules/AGENTS.md             # Agent 行为规则（Edge 优先、ref 优先、不抢端口）
├── scripts/                    # 三层自测 + 扩展安装引导
│   ├── self-test.cjs           # 桥接层：模拟扩展 + 真实 MCP 服务
│   ├── relay-test.cjs          # Leader/Follower 双进程 + 自动接管实测
│   ├── open-edge-extension-setup.ps1  # 打开 edge://extensions 并定位扩展目录（支持 -DryRun）
│   ├── dom-test.py             # 真实 Chromium 里验证页面动作层
│   ├── banner-test.py          # 真实 Chromium 里验证提示条渲染、自动隐藏与多标签
│   ├── banner-e2e.py           # 临时扩展 + 隔离端口验证分组标签页/常驻鼠标/CDP 生命周期（不碰 8767）
│   ├── e2e-test.py             # 真装扩展 + 真 MCP 服务的端到端验收
│   └── fixture.html            # 测试页
└── package.json
```

---

## 安装

### 第 1 步：加载扩展

1. 打开 `edge://extensions`（Chrome 是 `chrome://extensions`）。
2. 打开右下角 **开发人员模式**。
3. 点 **加载解压缩的扩展**，选中本项目的 `extension` 目录。
4. 加载后扩展列表里会出现 **antigravity浏览器控制**（品牌：谷谷嘎嘎），工具栏出现一个圆形图标；点开弹窗应显示「未连接（等待 MCP 服务启动）」——这是正常的，服务还没起。

> 两个浏览器都想要就各装一次。扩展默认端口 `8767`，两个浏览器可以同时连同一个服务，调用时用工具的 `browser` 参数区分。

### 第 2 步：把 MCP 服务接进 Antigravity

**推荐做法**：在 Antigravity 的 MCP 面板点 **Manage MCP Servers → View raw config**，直接打开真实的配置文件，把下面这段加进 `mcpServers`：

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\you\\antigravity-browser-bridge\\mcp-server\\server.js"],
      "env": { "AG_BRIDGE_PORT": "8767" }
    }
  }
}
```

Windows 路径要写成双反斜杠，例如：

```json
"args": ["C:\\Users\\you\\antigravity-browser-bridge\\mcp-server\\server.js"]
```

**配置文件默认位置**（不同 Antigravity 版本略有差异，以上面面板里打开的那个为准）：

- Antigravity IDE：`%USERPROFILE%\.gemini\antigravity\mcp_config.json`（macOS / Linux 是 `~/.gemini/antigravity/mcp_config.json`）
- Antigravity CLI：全局 `~/.gemini/config/mcp_config.json`，或工作区内的 `.agents/mcp_config.json`

改完保存，**重启一次 Antigravity 的 agent 会话**才会重新读取配置。

依赖：Node.js ≥ 18。项目自带 `node_modules/ws`，开箱即用；要重新装就 `npm install`（只有 `ws` 一个依赖）。

### 第 3 步：验证

让 Antigravity 执行：

> 调用 browser_launch（browser="edge"），然后调用 browser_status 告诉我桥接状态

看到 `bridge.state: connected`、`browser: edge`（或 chrome）就通了。扩展没装时 `browser_launch` 会直接返回扩展目录与安装指引；也可以运行 `scripts/open-edge-extension-setup.ps1` 自动打开 `edge://extensions` 并定位扩展目录。若报 `NO_EXTENSION`，看下面的排错表。

---

## 工具清单

除 `browser_launch` 外，其余工具都支持可选的 `browser` 参数（`edge` / `chrome` / `chromium` / `opera`），同时开着两个浏览器时用它指定；`tabId` 用于指定标签页，省略则用当前活动标签页。

| 工具 | 作用 |
| --- | --- |
| `browser_launch` | 启动 Edge（默认）/ Chrome / 自定义浏览器并等待扩展握手；扩展未装时返回扩展目录与安装指引；`dryRun=true` 只返回命令行 |
| `browser_status` | 桥接状态、浏览器类型、扩展版本、标签页数、CDP 附加情况 |
| `browser_tabs` | 列出 / 切换 / 关闭 / 新建标签页 |
| `browser_open` | 打开地址；不是 URL 时自动按搜索处理 |
| `browser_history` | 前进 / 后退 / 刷新 |
| `browser_snapshot` | 页面结构化快照：可交互元素带 `ref`、标题层级、可见文本 |
| `browser_screenshot` | 截图，返回图片；CDP 可用时支持整页 |
| `browser_click` | 点击：`ref` / `selector` / `text` / 坐标 `x,y`；支持双击与右键 |
| `browser_type` | 输入文本，兼容 React / Vue 受控输入；`realKeys` 逐字符真实按键 |
| `browser_press` | 按键：Enter / Tab / Escape / 方向键 / 单字符等 |
| `browser_hover` | 悬停触发 hover 态 |
| `browser_scroll` | 滚动页面或滚动到元素 |
| `browser_select_option` | 在下拉框里按 value 或可见文本选值 |
| `browser_get_text` | 取元素或整页可见文本 |
| `browser_evaluate` | 在页面主世界执行 JS 并取回结果 |
| `browser_wait_for` | 等待选择器或文本出现 |
| `browser_console` | 控制台日志、未捕获异常 |
| `browser_network` | 网络请求 / 响应 / 失败记录 |

### 给 Antigravity 的用法约定

先 `browser_launch`（默认 Edge）→ `browser_status` 确认连接 → `browser_snapshot` 拿 `ref` → `browser_click` / `browser_type` → 再 `browser_snapshot` 验证。`ref` 按 DOM 顺序确定性编号，同一页面结构下重复 snapshot 编号不变；但页面跳转、局部重渲染或元素被移除后旧 `ref` 会失效，此时重新 snapshot 即可。

### 多会话：Leader / Follower 自动中继

同一个 `127.0.0.1:8767` 现在同时提供三样东西：扩展用的 `WS /bridge`、自述用的 `GET /status`、中继用的 `POST /rpc`（校验 `x-ag-token`）。

- 第一个 MCP 进程绑定端口成功，成为 **Leader**，扩展照旧连它。
- 后续会话（第二个 Antigravity 窗口、子 Agent）遇到 `EADDRINUSE` 时先请求 `GET /status`：
  - 返回本桥接标识 → 自动成为 **Follower**，所有工具调用经 `POST /rpc` 透明转发给 Leader 执行，不再报 `LISTEN_FAILED`；
  - 不是本桥接（端口被别的程序占用）→ 保持原来的明确报错。
- Leader 退出后，Follower 在下一次工具调用时自动尝试接管端口；扩展约 800ms 内自动重连，调用方只需重试一次即可。
- `browser_launch` 由各进程本地执行，不经过 Leader 中继；等待握手时会向 Leader 查询已连接的扩展。

---

## 工作原理

```
Antigravity ──MCP(stdio JSON-RPC)──▶ mcp-server/server.js
                                        │  ws://127.0.0.1:8767/bridge
                                        ▼
                             扩展 service worker（WebSocket 客户端）
                                        │
                        ┌───────────────┴────────────────┐
                        ▼                                ▼
            chrome.debugger（CDP 1.3）          chrome.scripting / tabs
            真实鼠标键盘、截图、求值、           注入 page-actions.js：
            控制台与网络记录                      snapshot、定位、写值、等待
                        └───────────────┬────────────────┘
                                        ▼
                                   真实标签页
```

- **页面动作**（snapshot / 定位 / 写值 / 选值 / 等待）走 `chrome.scripting`，不弹调试提示条，受保护页面上也能给出明确错误。
- **真实输入**（点击、悬停、滚轮、按键）、**截图**、**页面求值**、**控制台与网络记录**走 CDP。CDP 附加失败时会自动退回页面脚本兜底，并在返回值里给出 `fallbackReason`。
- 服务只监听 `127.0.0.1`，不对外暴露。

---

## 页面顶部的原生控制提示

控制浏览器时只使用**浏览器自己的调试提示条**，不再额外绘制页面顶栏。

### 标准调试提示条

附加 `chrome.debugger` 时，浏览器会在页面顶部插一条提示条。它是**浏览器自己的界面**，文案由浏览器的模板加**扩展名**拼成（Chromium 里对应的字符串是 `IDS_DEV_TOOLS_INFOBAR_LABEL`），扩展没有单独控制这条文案的字段，只能通过改扩展名来影响它。

扩展在浏览器里的完整名字已设为 **谷谷嘎嘎正在控制你的浏览器**，所以提示条显示为：

> 「谷谷嘎嘎正在控制你的浏览器」正在调试此浏览器

几点说明：

- 名字外面那对引号与后半句「正在调试/已开始调试此浏览器」由浏览器添加，扩展去不掉。
- 控制类工具首次触达标签页时，扩展会主动 `chrome.debugger.attach`，让这条标准提示条立即出现；页面脚本动作本身不会触发它。
- 名字同时会出现在扩展列表里；工具栏悬停仍使用 `short_name`「谷谷嘎嘎」。
- 切换标签页或 WebSocket 断开会 `chrome.debugger.detach`，撤掉上一个标签页的原生提示条；再次控制时重新附加。
- 想彻底不显示这条提示条：给浏览器加启动参数 `--silent-debugger-extension-api`。这是浏览器级调试开关，会静默所有基于 `chrome.debugger` 的扩展提示，请自行权衡。

### 专属分组标签页与常驻鼠标

控制类工具默认在**当前窗口内的代理专属标签页**（`leaseTab`）里工作。该标签页会自动加入名为 **「谷谷嘎嘎控制中」** 的紫色标签组，并置为 active，让用户能直接看到控制鼠标、action 标签与浏览器原生调试提示条；用户原来的标签页仍保持打开、内容不被改写，随时可以切回。

首次控制动作后，页面内显示**常驻鼠标**：打开/读取/等待显示在视口中央，点击/输入/滚动移动到目标元素或动作点，带青色光晕、圆环和“正在控制”标签；鼠标 `pointer-events:none`，不挡页面点击，空闲也不会消失，直到控制会话结束才清理。

`browser_tabs new` / `browser_open newTab=true` 会在同一窗口再创建一个分组专属标签页并成为 leaseTab；`browser_tabs list` 会返回 `groupId` 与 `leased` 标记。需要控制用户指定的标签时显式传 `tabId`。受保护页面（`edge://`、`chrome://`、扩展商店、PDF 阅读器）无法注入或截图，扩展会静默跳过或返回明确错误，工具调用本身不受影响。

## 权限与安全

扩展申请的权限，以及各自的用途：

| 权限 | 用途 |
| --- | --- |
| `debugger` | CDP 通道：真实鼠标键盘事件、截图、控制台与网络记录 |
| `scripting` | 向页面注入动作层（快照、定位、写值） |
| `tabs` | 读写标签页 URL、标题，切换与关闭标签页 |
| `storage` | 保存端口 / 令牌 / 搜索地址 |
| `alarms` | 保活：MV3 service worker 空闲会被回收，靠定时器重连 |
| `<all_urls>` | 页面动作需要能作用于任意站点 |

需要注意：

- 控制开始时扩展会在「谷谷嘎嘎控制中」分组标签页里主动附加 CDP，由浏览器显示标准调试提示条，首段为扩展名「谷谷嘎嘎正在控制你的浏览器」，并在页面内显示常驻跟随动作的鼠标箭头、青色光晕、圆环和点击/输入/滚动反馈；不再叠加额外页面顶栏。
- 同一标签页打开着 DevTools 时无法附加 CDP，此时真实输入类工具会退回页面脚本兜底。
- 扩展能操作你已登录的站点，**等于把这些站点的操作权交给了 Antigravity**。只在你自己信任的会话里用。
- 想加一层保险：在扩展弹窗里设置一个令牌，并在 MCP 配置的 `env` 里加上 `"AG_BRIDGE_TOKEN": "<同一个令牌>"`，令牌不一致的连接会被拒绝。

---

## 已知限制

- 受保护页面（`edge://`、`chrome://`、扩展商店、内置 PDF 阅读器、新标签页）不支持页面动作，会返回明确错误。
- `browser_evaluate` 与 `browser_hover` 依赖 CDP，附加失败时直接报错而不兜底。
- 快照只覆盖主框架，不含 iframe 内部。
- 整页截图依赖 CDP 的 `captureBeyondViewport`；兜底路径只能截可视区。
- 扩展不拦截系统级弹窗（文件选择、权限请求、HTTP 认证），遇到时工具会超时——此时手动处理一下再继续。

---

## 排错

| 症状 | 原因与处理 |
| --- | --- |
| 工具返回 `NO_EXTENSION` | 扩展没连上。确认扩展已启用；点弹窗里的「重连」；确认弹窗端口 = MCP 配置里的 `AG_BRIDGE_PORT` |
| 弹窗一直显示「未连接」 | MCP 服务没启动。Antigravity 里发一句话触发一次工具调用即可；或先手动 `node mcp-server/server.js` 看 stderr 输出 |
| 启动日志 `mode=unavailable` / 返回 `LISTEN_FAILED` | `8767` 被**其他程序**占用（不是本桥接，`GET /status` 不认它）。关闭占用程序，或改用 `AG_BRIDGE_PORT`（扩展弹窗端口需一致） |
| 第二个会话以前会报端口冲突 | 1.1.0 起第二个进程自动成为 Follower，经 `POST /rpc` 中继，不应再有 `LISTEN_FAILED`；若仍有，检查占用 `8767` 的是不是另一个程序 |
| 返回 `TIMEOUT` | 页面被系统弹窗 / `alert` 阻塞，或目标站点响应极慢。先 `browser_status` 看连接，再 `browser_snapshot` 看页面状态 |
| 报「无法在页面注入脚本」 | 当前是受保护页面，先 `browser_open` 到普通网页 |
| 报「CDP 附加失败」 | 该标签页开着 DevTools，或页面受保护。关掉 DevTools 重试 |
| 点击没反应 | 站点用自定义组件拦了事件。改用坐标点击（`x`/`y`），或用 `browser_evaluate` 直接触发 |
| 输入框写了但框架不认 | 加 `realKeys: true` 走逐字符真实按键；或先 `browser_click` 聚焦再 `browser_type` |
| 改了 MCP 配置不生效 | 需要重启 Antigravity 的 agent 会话 |
| 弹窗令牌不匹配 | 弹窗里的令牌要和服务端 `AG_BRIDGE_TOKEN` 完全一致；服务端没设令牌时弹窗留空 |

服务端日志全部走 stderr（stdout 只走 MCP 协议），启动后能看到端口、已连接扩展、以及「还没有浏览器扩展连接」的提示。

---

## 自测

三层验证，都不需要人工介入：

```bash
npm run test:bridge       # 桥接层：模拟扩展 + 真实 MCP 服务，52 项
npm run test:relay        # Leader/Follower 双进程 + Leader 退出接管，22 项
npm run test:dom          # 真实 Chromium 里跑页面动作层，39 项
npm run test:banner       # 真实 Chromium 里跑控制提示条，36 项
npm run test:banner:e2e   # 临时扩展 + 隔离随机端口跑提示条完整链路，29 项
npm run test:e2e          # 真装扩展 + 真 MCP 服务跑完整链路，29 项
```

`test:relay` 默认用正式端口 `8767`；若该端口被其他程序占用，用 `AG_RELAY_TEST_PORT` 指定测试端口（例如 `set AG_RELAY_TEST_PORT=8773 && npm run test:relay`），默认配置仍由 `node mcp-server/server.js --print-config` 校验。

`test:banner:e2e` 会把扩展复制到临时目录、把端口改成随机空闲端口，并使用全新的临时浏览器配置，不会连接用户真实的 `8767` 桥接，也不会打开用户已登录的页面。

`test:dom`、`test:banner` 与 `test:e2e` 需要 `python3` 和 Playwright（`pip install playwright && playwright install chromium`）。

本次交付前的实测结果：

| 测试 | 环境 | 结果 |
| --- | --- | --- |
| `self-test.cjs` | Node 25.2.0 (win32 x64) | 52 通过 / 0 失败 |
| `relay-test.cjs` | Node 25.2.0，端口 8773（8767 被其他程序占用） | 22 通过 / 0 失败 |
| `dom-test.py` | Playwright Chromium（headless，UTF-8 I/O） | 49 通过 / 0 失败 |
| `cursor-test.py` | Playwright Chromium（headless，常驻鼠标） | 17 通过 / 0 失败 |
| `banner-test.py` | Playwright Chromium（headless，含严格 CSP 页面） | 37 通过 / 0 失败 |
| `banner-e2e.py` | 临时扩展 + 随机端口 + 独立浏览器配置 | 51 通过 / 0 失败 |
| `e2e-test.py` | Playwright Chromium 加载真实扩展 | 未在本轮运行（8767 被其他程序占用；不向用户浏览器安装扩展） |

端到端覆盖了：扩展自动连接 → 导航 → 快照取 ref → CDP 真实点击与输入（含受控输入兼容）→ 表单真的被提交 → 页面求值 → 下拉选择 → 取文本 → 截图（校验为合法 PNG）→ 控制台日志采集 → 滚动 → 等待元素 → 标签页新建/列出/关闭 → 无效 ref、未支持协议、受保护页面三类错误路径；专属窗口专项覆盖了用户当前页不变、窗口不抢焦点、常驻鼠标、后台窗口截图、lease 创建/切换/关闭与断开清理。
