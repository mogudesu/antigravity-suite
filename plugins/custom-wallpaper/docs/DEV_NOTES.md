# Antigravity Wallpaper & Custom Theme Rules

When this plugin is active, the Antigravity Custom Wallpaper plugin (`antigravity-custom-wallpaper`) manages the user's workspace background visual style.

## 交互行为指引
- **更换壁纸**：优先在侧栏控制面板上传图片；也可以把图片保存到 `assets/wallpaper.jpg` 后运行 `node scripts/apply.js`。控制面板会自动吸色并生成配套点缀色。
- **实时调节**：`opacity` / `darkTint` / `blur` / `focusX` / `focusY` 支持通过侧栏滑杆实时预览，由 `scripts/live-daemon.js` 直接改写 CSS 变量，无需重新注入 Base64。
- **完整重注入**：修改壁纸或 `config.json` 后运行 `node scripts/apply.js`；侧栏「应用到 Antigravity」按钮走 `POST /api/apply`。
- **还原默认**：运行 `node scripts/restore.js`，或点击侧栏「还原纯色」。
- **提示词与分支快照**：自定义提示词落盘在 `scripts/prompts-custom.json`；分支快照写入 `snapshots/`，并通过 `POST /api/snapshot` 返回可附件化文件。
- **MCP 连接面板**：对话框工具栏的 MCP 图标（`Alt+S` 面板旁的第三个按钮）打开，数据来自本地 language server 的 `GetMcpServerStates`，重连走 `RefreshMcpServers`，启停走 `ToggleMcpServer`（只对全局配置的服务器生效，插件自带的 MCP 跟随插件开关）。不读写 `mcp_config.json`。
- **面板入口**：`[星夜换肤控制台](sidecar://antigravity-custom-wallpaper/wallpaper_panel/ui.html)`。

## 设计约束
- 侧栏是 Antigravity 的虚拟列表，项目组容器依赖内联 `position: absolute` + `translateY()`；不要给 `.bg-sidebar` 全局加 `position: relative`。
- 对话框里的三个面板（技能罗盘 / 提示词 / MCP）共用 `.ag-plugin-panel`、`.ag-plugin-trigger`、`.ag-plugin-item` 类名，任何一侧的选择器都必须用 `:not(.ag-prompt-*):not(.ag-mcp-*)` 排除另外两侧，否则一次点击会同时打开两个面板。
- 列表行必须 `flex: 0 0 auto`：垂直滚动容器里 flex 子项默认 `flex-shrink: 1`，行高超过容器时会被压扁导致上下文字重叠。
- `scripts/ui-enhance.js` 有单实例守卫（`window.__agExtendedUiInstalled`），`node scripts/apply.js` 只会调用旧实例的 refresh；改完 JS 必须在 Antigravity 里刷新页面（Ctrl+R）才生效。
- 主题主色保持星夜金（`#F6D893`）；壁纸吸色只驱动次级点缀色与额度指示，避免高密度列表出现花哨撞色。
- 提问吸顶默认关闭（`promptSticky: false`），提问随内容滚走；控制面板可开启紧凑吸顶，开启后只在吸顶状态压成单行，由 `html.ag-prompt-sticky` 控制。
- v2.0：星环/流星 Canvas 位于 UI 之上、pointer-events none；星空动画在 `document.hidden` 或关闭模式时暂停；附件拖拽必须在捕获阶段阻断原生 dragstart，并带 15s 看门狗。

## 相关插件
- `mnemon`：永久人设/记忆，金库 `~/.gemini/memory/mnemon-vault`，镜像 `~/Documents/Antigravity-Memory-Backup`。侧栏「自定义配置」下方的「记忆管理」入口打开 `scripts/memory-page.js` 工作台，可编辑三份运行时记忆、备份与查看记忆条目。
- `computer-use`：Windows 桌面控制，Python 3.13 绝对路径，策略 `~/.gemini/memory/computer-use/policy.json`。
- `antigravity-browser-bridge`：Edge/Chrome 扩展桥，端口 **8767**（8765 被本地其他服务占用），扩展目录在插件 `extension/`。
