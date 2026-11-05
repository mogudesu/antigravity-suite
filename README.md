# 🌌 Antigravity Suite · 旗舰全家桶

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Google%20Antigravity-orange.svg)](https://antigravity.google)
[![Architecture](https://img.shields.io/badge/Architecture-MCP%20%7C%20Win32%20%7C%20MV3-purple.svg)]()

为 **Google Antigravity** 量身打造的开源增强全家桶：**视觉美化**、**浏览器深度接管**、**Win32 桌面控制** 与 **永久分层记忆**。

四大插件均配备专属 3D 萌系看板娘图标（透明背景 PNG），开箱即用，全面赋能个人开发者与自主 AI Agent 协作。

---

## 📦 四大核心插件矩阵

| 插件 | 图标 | 核心功能 | 核心技术 / 协议 |
| :--- | :---: | :--- | :--- |
| **[星夜美化](./plugins/custom-wallpaper)**<br>`custom-wallpaper` | <img src="./plugins/custom-wallpaper/assets/logo.png" width="96" height="96" alt="星夜美化" /> | **全景视觉与开发体验增强**<br>• 动态壁纸注入与智能调色板<br>• 实时免重载 CSS 变量调节<br>• 底部 Token / 上下文窗口遥测三面板<br>• 运行中 / 未读对话雷达胶囊<br>• 760+ 词条无损双向瞬切汉化引擎 | CSS Variables / DOM Observer / Canvas / Python 自动化测试 |
| **[浏览器控制](./plugins/browser-bridge)**<br>`browser-bridge` | <img src="./plugins/browser-bridge/assets/logo.png" width="96" height="96" alt="浏览器控制" /> | **日常浏览器深度直连与 RPA 录制回放**<br>• 直连已登录 Edge / Chrome，保留原有 Cookie 与扩展<br>• 豆包同款「浏览器录制与回放（演示即生成 Skill）」<br>• 页面悬浮录制胶囊（支持规则备注与圈选提取）<br>• 22 项精细控制工具（点击/输入/求值/截图/录制/参数化快放）<br>• 多窗口 Leader/Follower 端口自动防抢中继 | Model Context Protocol (MCP) / Chrome Extension MV3 / CDP / RPA |
| **[电脑控制](./plugins/computer-use)**<br>`computer-use` | <img src="./plugins/computer-use/assets/logo.png" width="96" height="96" alt="电脑控制" /> | **系统级 Win32 原生桌面接管**<br>• 零重度外部依赖，Python 3.13 原生 Win32 驱动<br>• 6400x2160 超宽屏/多屏高分屏感知 (Per-monitor DPI)<br>• 可见鼠标轨迹与屏幕置顶高亮横幅<br>• 细粒度安全白名单与危险组合键拦截 (Guarded Mode) | Win32 GDI / UI Automation / Windows Native API |
| **[长期记忆](./plugins/mnemon)**<br>`mnemon` | <img src="./plugins/mnemon/assets/logo.png" width="96" height="96" alt="长期记忆" /> | **分层记忆与永恒人设金库**<br>• 运行时三层记忆 (`PERSONA` / `USER` / `MEMORY`)<br>• 向量语义 + 关键词混合加权召回<br>• 本地金库与第二驱动器镜像双驱原子同步<br>• 每日 gzip 自动快照与启动自愈机制<br>• PreInvocation / PostToolUse 钩子无感挂载 | Node.js / Layered Memory Engine / Gzip Snapshots / MCP |

---

## 🚀 快速安装

### 方式一：一键自动安装（推荐）

直接克隆本仓库并运行安装脚本，插件将自动同步至 Antigravity 插件目录：

```powershell
# 1. 克隆本仓库
git clone https://github.com/mogudesu/antigravity-suite.git
cd antigravity-suite

# 2. 执行安装脚本
.\install.ps1
```

### 方式二：手动选择安装

如果你只需要其中的部分插件，只需将 `plugins/` 目录下的对应文件夹拷贝到 Antigravity 配置目录即可：

- **Windows 路径**：`%USERPROFILE%\.gemini\config\plugins\`
- **Linux / macOS 路径**：`~/.gemini/config/plugins/`

重启或刷新 Antigravity，插件即刻自动加载！

---

## 🛠️ 极速维护与推送更新 (`sync-push.ps1`)

对于开发者自己，本项目内置了全自动同步推送脚本：

当你日常在本地 Antigravity 调试或更新了任何插件的代码、样式、规则或提示词，无需手动复制粘贴：

```powershell
# 在本项目根目录下运行：
.\sync-push.ps1 "feat: 升级某插件特性或微调样式"
```

脚本将自动执行：
1. 从 `~/.gemini/config/plugins/` 抓取四大插件的最新更改并过滤临时无用文件；
2. 自动检测 `git status` 差异；
3. 自动暂存、提交并推送到 GitHub 远程仓库！

---

## 🎯 面向 AI Agent 的友好性设计

本套件不仅供人类开发者使用，还对各类 AI 编程助手（如 Antigravity、Claude Code、Cursor、Codex 等）进行了针对性语义优化：
- 每个插件均自带独立的 `rules/AGENTS.md`，Agent 进入插件目录即可自动吸纳操作规约与避坑指南；
- 附带完善的 `skills/` 与 MCP Schema，方便 AI 自动发现并驱动对应工具；
- 自带 100% 覆盖的自测脚本与单元测试套件（900+ checks 全绿验证）。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 授权，欢迎自由 Fork、二次开发与贡献！
