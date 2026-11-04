# Antigravity 星夜美化 · Starlight Theme & Enhancer

[![Version](https://img.shields.io/badge/version-1.0.0-gold.svg)](plugin.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Google%20Antigravity-orange.svg)](https://antigravity.google)

为 Google Antigravity 打造的生产级**全景视觉美化、会话遥测仪表盘、多任务对话雷达与无损双向汉化增强插件**。

让原本素净的代码助手工作区化身具有赛博星空质感的高沉浸开发站：深邃的曜石毛玻璃、自动吸色智能点缀系统、毫秒级滑杆实时调参、底部实时 Token / 上下文遥测三面板、跨会话运行雷达，以及 760+ 词条专业双向汉化引擎。

---

## 核心特性一览

### 1. 🌌 动态壁纸与智能吸色矩阵 (Wallpaper & Auto-Palette)
- **本地图片智能注入**：支持 JPG / PNG / WebP 格式壁纸，自动计算全景主色、亮度直方图与视觉重心。
- **自动互补点缀色**：以经典星夜金（`#F6D893`）为锚点，自动吸取壁纸次级色彩驱动额度指示、高亮状态与交互反馈，杜绝高密度列表撞色。
- **低能耗动态背景**：内置低 CPU 占用的星环与流星 Canvas 粒子层；页面切出（`document.hidden`）或全屏专注时自动休眠暂停，绝不浪费算力。

### 2. ⚡ 毫秒级免重载实时调节 (Live Daemon)
- **免二次注入**：搭载轻量级 `live-daemon.js`，通过直接改写 CSS 根变量实现参数调整，调节滑杆无需重新编码与注入几十兆的 Base64。
- **参数随意微调**：
  - 透明度 (`opacity`：0.05 ~ 0.95)
  - 高斯毛玻璃模糊度 (`blur`：0px ~ 40px)
  - 暗角与深色遮罩 (`darkTint`：0.1 ~ 0.9)
  - 视觉聚焦点微调 (`focusX` / `focusY`)

### 3. 📊 底部实时遥测三面板 (Bottom Telemetry Panels)
- **会话 Token 与上下文窗口监视器**：底部常驻轻量遥测，精确掌握单轮用量与当前模型上下文剩余水位，远离超长上下文突变。
- **任务进度条联动**：针对 `/goal` 及长链路任务提供直观流式进度条与阶段耗时统计。
- **时钟与运行时指标**：优雅的背景时钟与极简状态灯。

### 4. 🧭 运行中 / 未读对话雷达 (Conversation Radar)
- **多任务并行防遗忘**：当后台有其他 Agent 或长任务正在执行、完成或等待输入时，雷达自动点亮并在侧边呼出浮动胶囊（Navigation Pill）。
- **一键极速定位**：点击雷达指示器瞬间切换至目标对话窗口，多 Agent 并行协作从容不乱。

### 5. 🇨🇳 原生级双向瞬切汉化引擎 (Lossless i18n Engine)
- **760+ 专业词条深度覆盖**：对 Antigravity 界面（工作区、设置、自定义配置、实施计划、状态指示等）全量汉化。
- **严格无损保护**：
  - **绝不污染**：用户输入气泡、AI 纯文本回复、Markdown 代码块、Monaco Editor 编辑器文本完全隔离，绝不篡改代码和提示词。
  - **结构纯正**：保留原生 DOM 属性（`testid`、`aria-label`、`class`），切回英文（`EN`）时原样复原，零脏数据残留。
  - **极速响应**：MutationObserver 增量守护，中英文瞬时切换时间 `< 100ms`。

### 6. 💎 曜石毛玻璃与操作增强 (Obsidian Polish & Quick Actions)
- **曜石深色毛玻璃**：侧边栏与面板采用深度模糊 + 细腻描边，层级清晰。
- **一键快捷复制代码块**：代码块与 Artifacts 顶栏附带智能复制增强。
- **提问紧凑吸顶（可选）**：通过控制面板可开启长内容滚动时提问区域紧凑单行吸顶，阅读体验更聚焦。
- **记忆工作台直达**：无缝联动 `mnemon` 插件，一键直达记忆管理看板与镜像备份。

---

## 目录结构

```
antigravity-custom-wallpaper/
├── assets/
│   ├── logo.png                # 插件图标 (1:1 高清透明背景)
│   └── wallpaper.jpg           # 当前壁纸原图
├── config/
│   └── config.json             # 外观调节与开关配置文件
├── rules/
│   └── AGENTS.md               # 针对 Agent 的使用约束与环境指南
├── scripts/
│   ├── apply.js                # 壁纸 Base64 编译注入与调色板生成
│   ├── restore.js              # 一键还原 Antigravity 原生纯色主题
│   ├── live-daemon.js          # 实时 CSS 变量无感调节守护进程
│   ├── ui-enhance.js           # 曜石毛玻璃、Canvas 动效与拖拽安全拦截
│   ├── telemetry-panels.js     # 底部实时 Token / 任务状态遥测面板
│   ├── running-radar.js        # 跨会话运行中/未读雷达与导航胶囊
│   ├── i18n-engine.js          # 原生双向汉化引擎（内置 760+ 词条）
│   ├── i18n-engine.test.py     # 汉化引擎全自动化回归测试 (48/48 PASSED)
│   ├── starlight-settings.js   # 星夜美化设置面板与热键绑定
│   ├── memory-page.js          # 记忆管理与配置工作台页面
│   └── autostart.js            # Antigravity 会话启动自动挂载脚本
├── sidecars/
│   └── wallpaper_panel/        # 侧边栏独立可视化调节界面 (HTML / CSS / JS)
├── skills/                     # Agent 技能指令集
├── hooks.json                  # 会话启动（SessionStart）自动注册挂钩
├── plugin.json                 # Antigravity 插件标准元数据
├── LICENSE                     # MIT 开源协议
└── README.md                   # 插件使用与开发文档
```

---

## 安装与快速上手

### 方法 1：作为本地插件加载
1. 克隆或下载本仓库至 Antigravity 插件目录：
   - Windows 路径：`%USERPROFILE%\.gemini\config\plugins\antigravity-custom-wallpaper`
   - Linux / macOS 路径：`~/.gemini/config/plugins/antigravity-custom-wallpaper`
2. 重启 Antigravity 或刷新插件列表，插件即刻自动加载！

### 方法 2：更换壁纸
- **从侧栏面板更换**：按 `Alt+S` 唤出「星夜美化控制面板」，直接拖入或选择本地图片，实时预览并保存。
- **从命令行更换**：
  ```bash
  # 将你的壁纸图片保存至 assets/wallpaper.jpg，然后执行：
  node scripts/apply.js
  ```
- **还原默认原版纯色**：
  ```bash
  node scripts/restore.js
  ```

---

## 常用快捷键与操作

| 动作 | 方式 |
| --- | --- |
| 打开控制面板 | 快捷键 `Alt+S`，或在侧边栏点击「星夜美化」 |
| 实时微调参数 | 在控制面板中滑动调节滑块（透明度、模糊度、遮罩暗度）实时预览 |
| 中英文瞬切 | 在控制面板点击 `中 / EN` 按钮，或输入命令切换 |
| 对话雷达跳转 | 看到右上角/侧边浮动的「运行中雷达胶囊」直接点击跳转对应会话 |

---

## 架构与性能保障

- **零重度依赖**：纯原生 JavaScript 与 Win32/Node 底层交互，无需 Electron 重编译，启动开销趋近于零。
- **防内存泄漏与看门狗**：Canvas 动效带有 15s 拖拽保护和页面隐藏事件监听，DOM Observer 采用增量过滤，长周期运行内存零暴涨。
- **无侵入设计**：所有主题变量注入在特定命名空间（`--ag-starlight-*`）下，不改写 Antigravity 虚拟滚动的核心定位逻辑（`.bg-sidebar` 与 `translateY`）。

---

## 开源协议

本项目采用 [MIT License](LICENSE) 授权，欢迎自由二次开发与贡献！
