---
name: browser-bridge
description: 通过 antigravity-browser-bridge MCP 控制用户本机已登录的 Microsoft Edge（默认优先）或 Google Chrome：启动浏览器、读取页面快照、点击、输入、截图、读取控制台与网络。多开 Antigravity 会话时由 Leader/Follower 自动中继，无需处理 8767 端口占用。
---

# Browser Bridge（Edge / Chrome 实机控制）

本技能把浏览器操作交给用户日常使用的 Edge / Chrome（保留 Cookie、登录态与已装扩展），底层是
`antigravity-browser-bridge` MCP 服务 + 「antigravity浏览器控制」MV3 扩展（品牌：谷谷嘎嘎），本地桥接地址 `127.0.0.1:8767`。

## 标准工作流（Codex 习惯，务必按序）

1. `browser_launch`：默认 `browser="edge"`；可给 `profileDirectory`（如 `Default` / `Profile 1`）、`url`、`waitConnectMs`（默认 8000）。
   - 已连接时不会重复开窗；扩展未安装时会返回扩展目录与安装指引。
2. `browser_status`：确认 `bridge.state = connected`、浏览器类型与标签页。
3. `browser_snapshot`：拿确定性 `ref`（如 `e12`）与页面结构；不要凭猜测点坐标。
4. `browser_click` / `browser_type` / `browser_press` / `browser_select_option`：优先用 `ref`，其次 `selector` / `text`。
5. 页面跳转、局部重渲染或操作失败后 **重新 `browser_snapshot`**，旧 `ref` 会失效。
6. 需要验证视觉结果时用 `browser_screenshot`；排查脚本问题用 `browser_console` / `browser_network`。

## 工具速查

| 目的 | 工具 |
| --- | --- |
| 启动 / 唤醒浏览器并等待扩展握手 | `browser_launch` |
| 连接状态、扩展版本、标签页数、CDP | `browser_status` |
| 标签页列表 / 切换 / 新建 / 关闭 | `browser_tabs` |
| 打开网址或搜索 | `browser_open` |
| 前进 / 后退 / 刷新 | `browser_history` |
| 结构化快照（带 ref） | `browser_snapshot` |
| 点击 / 输入 / 按键 / 悬停 / 滚动 | `browser_click`、`browser_type`、`browser_press`、`browser_hover`、`browser_scroll` |
| 下拉选择 / 取文本 / 执行 JS / 等待 | `browser_select_option`、`browser_get_text`、`browser_evaluate`、`browser_wait_for` |
| 截图 / 控制台 / 网络 | `browser_screenshot`、`browser_console`、`browser_network` |
| RPA 录制开启 / 结束落盘 / 历史查询 / 参数化快放 | `browser_record_start`、`browser_record_stop`、`browser_record_list`、`browser_record_replay`（配合 `browser-record-replay` 技能可将用户演示操作自动编译为可复用 Skill） |

除 `browser_launch` 外，其余工具都可带 `browser`（`edge` / `chrome`）指定目标；同时开着两个浏览器时才需要显式指定。

## 扩展未安装时

`browser_launch` 会在结果中返回：

- 扩展目录：`<插件根>\extension`
- 安装脚本：`<插件根>\scripts\open-edge-extension-setup.ps1`

把这两个路径原样告诉用户，并给出步骤：打开 `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选择扩展目录 → 点扩展图标确认端口 `8767` 并「重连」。运行安装脚本可自动打开扩展页并定位目录（脚本支持 `-DryRun`）。

## 多会话与端口

- 第一个 MCP 进程是 Leader，独占 `127.0.0.1:8767`；后续进程自动成为 Follower，工具调用经 `POST /rpc` 中继。
- 不要为了「抢端口」去杀进程；Leader 退出后 Follower 会在下次调用时自动接管，扩展约 800ms 内重连。
- 如果 `browser_status` 报 `NO_EXTENSION`，先 `browser_launch`，再检查扩展弹窗端口与「重连」。

## 注意

- `edge://`、`chrome://`、扩展商店、内置 PDF 阅读器等受保护页面不能做页面动作，也无法附加 CDP，因此不会出现原生调试提示条。
- 默认控制发生在当前窗口内、名为「谷谷嘎嘎控制中」的紫色标签组里的专属标签页；该页会激活以便用户看到控制状态，用户原标签页保持打开且不被改写。需要控制用户指定的标签时显式传 `tabId`。
- 控制类工具首次触达专属标签页时会主动附加 CDP，由浏览器显示标准调试提示条，首段为扩展名「谷谷嘎嘎正在控制你的浏览器」；不再绘制额外页面顶栏。
- 页面内显示常驻鼠标箭头与点击/输入/滚动反馈，`pointer-events:none`，空闲不会消失，直到控制会话结束。浏览器原生提示条的文字模板与关闭按钮由浏览器控制，扩展无法改写。
- 浏览器里可能有用户的隐私数据：只执行用户明确要求的操作，不要擅自读取或提交敏感表单。
- 验证启动参数而不真正开窗时使用 `browser_launch` 的 `dryRun: true`。
