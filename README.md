# 🌌 Antigravity Suite · 旗舰全家桶

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Google%20Antigravity-orange.svg)](https://antigravity.google)
[![Architecture](https://img.shields.io/badge/Architecture-MCP%20%7C%20Win32%20%7C%20MV3-purple.svg)]()

> **说人话的版本**：这是专门给 **Google Antigravity** 打造的四大“超能力”神器！  
> 想要超高颜值的二次元/磨砂玻璃界面？想要 AI 直接帮你操作日常使用的 Edge 浏览器查资料填表？想要 AI 能像真人一样操控 Windows 桌面与各类无接口软件？想要 AI 永远记住你的设定和喜好不再失忆？  
> 装上这个全家桶，一次性全部搞定。四大插件均配备专属 3D 萌系看板娘图标，开箱即用，省心到家！

---

## 📦 四大插件人话介绍与特性矩阵

| 插件 | 看板娘图标 | 它能帮你干什么（说人话） | 硬核技术支撑 | 开源协议 |
| :--- | :---: | :--- | :--- | :---: |
| **[星夜美化](./plugins/custom-wallpaper)**<br>`custom-wallpaper` | <img src="./plugins/custom-wallpaper/assets/logo.png" width="96" height="96" alt="星夜美化" /> | **让界面瞬间高级好看，工作不再沉闷**<br>• 一键给 Antigravity 换上任意你喜欢的绝美壁纸与毛玻璃磨砂效果。<br>• 智能吸色黑科技：选好壁纸后自动生成一套同色系高级点缀色，不用手动瞎调。<br>• 透明度、模糊度滑杆实时预览，免刷新界面。<br>• 底部贴心常驻 Token 额度、上下文消耗遥测小窗与未读对话雷达。<br>• 760+ 词条无损一秒中英双语切换，再也不用对着英文干瞪眼。 | CSS Variables / DOM Observer / Canvas / Python 测试套件 | [MIT](plugins/custom-wallpaper/LICENSE) |
| **[浏览器控制](./plugins/browser-bridge)**<br>`browser-bridge` | <img src="./plugins/browser-bridge/assets/logo.png" width="96" height="96" alt="浏览器控制" /> | **让 AI 接管你已登录的日常浏览器，绝不重复扫码**<br>• 直接连通你正在用的 Edge / Chrome，保留原有的账号登录态、Cookie 与扩展插件。<br>• 让 AI 替你点网页、查资料、做研究、填写繁琐表单。<br>• **演示即生成 Skill**：你在网页上操作一遍，它就能自动提炼参数录制成专属技能，下次让 AI 一键全自动重复跑。<br>• 悬浮录制胶囊自带页面划词备注与元素提取，全自动自愈重试机制。 | MCP 协议 / Chrome MV3 扩展 / CDP 桥接 / 自动化回放 | [MIT](plugins/browser-bridge/LICENSE) |
| **[电脑控制](./plugins/computer-use)**<br>`computer-use` | <img src="./plugins/computer-use/assets/logo.png" width="96" height="96" alt="电脑控制" /> | **给 AI 一双控制 Windows 桌面的“眼睛”和“手”**<br>• 当某个软件没有现成 API 时，让 AI 直接看懂屏幕、滑动鼠标、点击按钮、敲击键盘。<br>• 完美支持 4K/带鱼屏/超宽双联屏高分屏缩放 (Per-monitor DPI)。<br>• 桌面顶部常驻醒目的防误触控制横幅与真实鼠标轨迹，AI 在干嘛一清二楚。<br>• 原生 Win32 纯净驱动，没有笨重臃肿的环境依赖，安全可靠。 | Win32 GDI / UI Automation / Windows Native API | [MIT](plugins/computer-use/LICENSE) |
| **[长期记忆](./plugins/mnemon)**<br>`mnemon` | <img src="./plugins/mnemon/assets/logo.png" width="96" height="96" alt="长期记忆" /> | **让 AI 真正拥有“永久记忆”，彻底告别失忆**<br>• 聊着聊着 AI 就忘了你的喜好、忘了代码架构？让它把人设、用户习惯与项目核心决策分层永久封存。<br>• 每次对话开始前无感召回关键事实，懂你所想。<br>• 双盘原子同步镜像备份 + 每天自动压缩存档，哪怕系统崩溃也能一键原地自愈复活。<br>• 数据 100% 保存在你自己的本地电脑里，绝不上传第三方，隐私绝对安全。 | 分层记忆引擎 / 语义+关键词混合索引 / 本地原子双驱镜像 | [MIT](plugins/mnemon/LICENSE) |

---

## 🚀 极速安装使用

### 方式一：一键全自动安装（最推荐）

直接克隆本仓库并运行内置安装脚本，会自动将四大插件完整安装到你的 Antigravity 运行目录：

```powershell
# 1. 克隆本仓库
git clone https://github.com/mogudesu/antigravity-suite.git
cd antigravity-suite

# 2. 执行安装脚本
.\install.ps1
```

### 方式二：挑着装（手动拷贝）

如果你只需要其中的某几个插件，只需要把本仓库 `plugins/` 目录下的对应文件夹，拷贝到 Antigravity 的插件目录即可：

- **Windows 插件默认路径**：`%USERPROFILE%\.gemini\config\plugins\`
- **Linux / macOS 插件默认路径**：`~/.gemini/config/plugins/`

拷贝完成后重启或刷新 Antigravity，插件即刻被识别加载！

---

## 🛠️ 开发者专属：日常一键同步与推送 (`sync-push.ps1`)

对于要在日常开发中持续维护、更新插件的小伙伴，仓库自带了全自动同步工具：

平时你在本地 Antigravity 插件目录里改了代码、调整了 CSS 样式或者更新了规则，完全不需要手动去复制文件：

```powershell
# 在本项目根目录下敲这一行：
.\sync-push.ps1 "feat: 升级了某个好玩的特性"
```

它会自动帮你完成：
1. 抓取本地 `~/.gemini/config/plugins/` 里的最新改动（智能过滤无用的临时日志与缓存）；
2. 比对 Git 差异；
3. 自动暂存、打好提交信息并推送到 GitHub 仓库！

---

## 🎯 对自主 AI Agent 的极致友好支持

本套件不仅让人类用着舒服，也特意针对各类 Coding Agent（Antigravity、Claude Code、Cursor、Codex 等）进行了深度工程优化：
- **操作指引到位**：每个插件内均含有专属 `rules/AGENTS.md`，Agent 读取后能立刻掌握该工具的边界、最佳实践与避坑要点；
- **MCP 协议开箱即用**：自带标准化工具 Schema 与技能（`skills/`），Agent 能秒级识别并调用；
- **质量保障门禁**：内置全套自动化测试套件（单测 750+ 项全绿），杜绝代码腐化。

---

## 📄 开源许可协议 (License)

本项目采用最自由友好的 **[MIT License](LICENSE)** 开源协议。

无论是个人使用、商业应用、修改代码还是二次打包分发，你都可以完全自由地使用，只需在衍生作品中保留原作者版权声明即可。
