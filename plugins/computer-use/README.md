# computer-use

让 Antigravity 的智能体看见并操作你的本机桌面：窗口清单、辅助功能树、截屏、鼠标键盘、剪贴板、启动应用。

- **纯 Python 3 标准库实现，零第三方依赖** —— 不需要 Pillow、pyautogui、Node 包或任何 `pip install`
- 设计取向参考 Codex 的 computer use：**辅助功能树优先、坐标点击兜底、危险动作先过策略闸门**
- **三层安全**：Antigravity 权限系统 → `PreToolUse` 钩子 → MCP server 内部策略（含限流、审计、dry-run）
- **看得见的控制**：首次真实动作后，屏幕上常驻 Codex 风格鼠标光标与屏幕四周高亮框，并在顶部显示「谷谷嘎嘎正在控制你的电脑」横幅
- **Windows 一等公民**（含 UI Automation 元素级操作），macOS / Linux 为适配层

---

## 1. 工具清单

MCP server 名为 `desktop`，因此工具在 Antigravity 中呈现为 `computer-use_desktop_<tool>`。

| 工具 | 作用 | 只读 |
| --- | --- | --- |
| `get_environment` | 平台、屏幕几何、DPI、能力清单、当前策略 | ✅ |
| `list_windows` | 可见顶层窗口：id / 进程 / 标题 / 边界 / 是否前台 | ✅ |
| `ui_tree` | 某窗口的辅助功能树：控件类型、名称、automation id、矩形、可用动作 | ✅ |
| `find_elements` | 按名称/id 子串在辅助功能树里搜索控件 | ✅ |
| `screenshot` | 全屏 / 指定窗口 / 指定矩形截屏，返回 PNG 图像（默认 `max_width=1920`，1080p 屏幕 1:1 不缩放） | ✅ |
| `focus_window` | 把窗口提到前台 | |
| `click_element` | 通过辅助功能层激活控件（无动作模式时回退为点击中心） | |
| `click` | 在绝对屏幕坐标点击（左/右/中键、双击） | |
| `move_mouse` | 移动指针，用于触发 hover 菜单 | |
| `drag` | 按下 → 移动 → 释放，用于滑块、滚动条、拖拽、框选 | |
| `scroll` | 滚轮滚动，正数向上、负数向下 | |
| `type_text` | 向当前焦点输入文本（Unicode，中文可用） | |
| `press_keys` | 按键或组合键，如 `["ctrl","s"]`、`"win+r"` | |
| `clipboard` | 读 / 写剪贴板 | |
| `open_app` | 打开程序、文档或 URL | |

所有真正执行的动作（`click`、`click_element`、`drag`、`move_mouse`、`scroll`、`type_text`、
`press_keys`）都会在目标位置显示一个**普通鼠标箭头**；屏幕四周同时出现 Codex 风格的高亮框，
顶部显示 **「谷谷嘎嘎正在控制你的电脑」** 横幅。首次动作出现后，三者常驻，直到这次控制会话结束
（MCP server 关闭 / 客户端断开）才清理；执行动作只会移动光标，不会再淡出。dry-run 与策略拒绝
不会显示任何东西。详见下一节。

## 2. 工作原理

```
Antigravity agent
   │  computer-use_desktop_click(...)
   ▼
PreToolUse hook ─── scripts/hook_guard.py ──┐  第 2 层：硬拒绝。即使你在权限系统里给
   │  允许则继续                             │  整个 server 开了 Always allow，也照样拦
   ▼                                         │
MCP server (stdio) ─ scripts/mcp_server.py ──┤
   │                                         │
   ├── cu/policy.py   第 3 层：模式/黑名单/密码框/限流/dry-run/审计
   ├── cu/tools.py    15 个工具的 schema 与实现
   ├── cu/overlay.py  浮层客户端：有界队列 + 本地 socket，动作路径上永不阻塞
   ├── overlay_host.py 独立浮层进程：置顶 / 点击穿透 / 不抢焦点的分层窗口
   └── cu/backends/   windows.py | macos.py | linux.py
                      └── win_uia.ps1（Windows UI Automation 桥）
   ▼
操作系统
```

- MCP 协议层（`cu/protocol.py`）自己实现：JSON-RPC 2.0 over stdio，换行分帧，支持
  `initialize` / `ping` / `tools/list` / `tools/call` / `resources/list` / `prompts/list`。
- PNG 编码器（`cu/imaging.py`）也是手写的，所以截屏不需要任何图像库。

### 控制提示浮层

工具层在动作**真正执行成功之后**，把目标坐标投进一个容量有限的内存队列；后台线程通过
`127.0.0.1` 上的一次性 socket 发给独立进程 `scripts/overlay_host.py`。因此：

- **不阻塞、不重复开窗**：MCP server 从不绘制窗口，队列满了就丢旧点；浮层进程只启动一次，
  同一数据目录下多个 Antigravity 窗口共用它。
- **看得见**：普通白色鼠标箭头 + 黑色描边 + 轻微投影；不再绘制圆环、准星、拖尾或点击涟漪，
  在浅色与深色窗口上都醒目；受控桌面四周还会浮出青色描边、角标和金色内线的屏幕高光。
  `type_text` / `press_keys` 画在焦点窗口中心或最近一次动作点；
  `click_element` 即使走辅助功能层、真实鼠标没动，也会画在控件矩形中心。
- **不挡操作**：窗口同时带 `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE |
  WS_EX_TOOLWINDOW`，鼠标点击直接穿到下面的应用，`SetWindowPos(..., SWP_NOACTIVATE)` 保证
  它永远不会成为前台窗口，也不会出现在 Alt-Tab 或 `list_windows` 里。
- **横幅避让**：默认在动作点所在显示器的顶部居中；若动作点正好落在横幅附近，会自动改到
  右上 / 左上，绝不盖住正在操作的位置。
- **远程可见**：浮层默认参与屏幕捕获，因此远程桌面、ToDesk / Sunshine 等投屏和普通截图都能看到鼠标、屏幕高光与横幅。若确实要让它对 GDI 截图和远程观看同时隐形，启动前设置 `CU_OVERLAY_CAPTURE_GUARD=1`（WDA_EXCLUDEFROMCAPTURE）；默认关闭是为了避免远程用户完全看不到控制状态。
- **自动收尾**：控制会话期间保持可见；MCP server 关闭 socket 或客户端断开后浮层进程销毁窗口
  并退出。即使 server 被强杀，浮层也会在 1 秒内发现父进程与连接消失而退出。
- **开关**：默认开启。环境变量 `CU_OVERLAY=0`（也接受 `false/off/no`）可临时关闭；策略文件里
  写 `"overlay": false` 可长期关闭。两者都不改变任何安全策略或审计行为。
- **依赖**：只用标准库；Windows 后端用 tkinter（官方 Python 安装包自带）绘制的 Win32 分层窗口。
  若解释器缺少 tkinter，浮层会自动保持关闭，桌面控制本身不受影响。
- **截屏默认包含浮层**：它是真实的置顶窗口，所以 agent 自己的 `screenshot`、远程桌面和投屏里也能看到鼠标箭头、屏幕框与横幅；若要让浮层对捕获隐形，显式设置 `CU_OVERLAY_CAPTURE_GUARD=1`；
  它们不是被控制应用的 UI，`list_windows` 会过滤掉。

## 3. 安装

前置：Python 3.8+（Windows 上 `python`、`python3`、`py -3` 任一可用即可）。

### 方式 A：agy CLI（推荐）

```bash
agy plugin install <本插件目录>
agy plugin validate --strict <本插件目录>
agy plugin list --json
```

### 方式 B：手动复制

- 全局：`%USERPROFILE%\.gemini\config\plugins\antigravity computer use-mogu\`
- 工作区：`<你的工作区>\.agents\plugins\antigravity computer use-mogu\`

复制整个目录即可，插件根目录必须直接包含 `plugin.json`。

### 方式 C：安装脚本

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\install.ps1                 # 装到全局
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Workspace C:\proj
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun         # 只看会做什么
```

```bash
# macOS / Linux
bash scripts/install.sh                       # 装到全局
bash scripts/install.sh --workspace /path/to/proj
bash scripts/install.sh --dry-run
```

脚本做的事：校验 `plugin.json` → 复制到目标目录（排除 `__pycache__`）→ 探测可用解释器并
（必要时）改写安装副本里 `mcp.json` 的 `command` → 对安装副本跑一次 MCP 握手自检 → 打印后续步骤。
幂等：目标已存在时会先提示，用 `-Force` / `--force` 才覆盖。

### Windows 解释器差异（重要）

`mcp.json` 里写的是 `"command": "python3"`。Windows 官方安装器默认只提供 `python` 和 `py`，
三种处理任选其一：

1. 安装 Python 时勾选 “Add python.exe to PATH”，再到「设置 → 应用 → 高级应用设置 →
   应用执行别名」里启用 `python3.exe` 别名；
2. 直接把 `<插件目录>\mcp.json` 的 `command` 改成 `python`；
3. 用 `install.ps1` 安装，它会自动探测并改写。

`hooks.json` 里的命令写成了 `python3 ./scripts/hook_guard.py || python ./scripts/hook_guard.py`，
两种解释器任一可用就能跑。

### 验证安装

```bash
cd <插件目录>
python scripts/selftest.py        # 期望输出：0 failed
```

再让 Antigravity 调用一次 `computer-use_desktop_get_environment`，它应当返回平台、屏幕几何、
能力清单和当前策略。

## 4. 安全模型

### 三层，各管一段

| 层 | 位置 | 拦住什么 |
| --- | --- | --- |
| 1. Antigravity 权限系统 | 宿主 | 默认对 MCP 工具询问；可在 settings 里用 `mcp(computer-use/*)` 配置 |
| 2. PreToolUse 钩子 | `hooks.json` + `scripts/hook_guard.py` | 模式、键组合黑名单、应用黑名单的**硬拒绝**；即使第 1 层给了整个 server Always allow 也照样拦 |
| 3. MCP server 内部 | `cu/policy.py` | 每次调用前判定：模式、应用/标题/键组合黑名单、密码框保护、限流、dry-run、审计 |

钩子层只按调用参数判定；「这次点击落在哪个应用上」由 server 用 `WindowFromPoint` 解析后判定，
两层不重复。钩子按 Antigravity 约定 fail-open：任何内部异常都输出合法 JSON 并 `exit 0`，
不会把会话卡死。

### 策略文件

位置：`${PLUGIN_DATA}/policy.json`（Antigravity 给插件的数据目录）。若环境里没有 `PLUGIN_DATA`，
回退到 `%LOCALAPPDATA%\computer-use\policy.json`（Windows）或
`~/.local/share/computer-use/policy.json`。首次调用 `get_environment` 会自动生成一份带默认值的文件。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `guarded` | `readonly` 只允许查看类工具；`guarded` 允许操作但受黑名单约束；`open` 放开（黑名单仍生效） |
| `dryRun` | `false` | `true` 时所有有副作用的动作只返回「将要做什么」，不真正执行 |
| `allowApps` | `[]` | 非空时只允许操作这些进程（白名单） |
| `denyApps` | 8 项 | 密码管理器与凭据/登录界面：`keepass`、`1password`、`bitwarden`、`lastpass`、`dashlane`、`credential`、`logonui`、`winlogon` |
| `denyKeyCombos` | `ctrl+alt+delete`、`win+l`、`ctrl+shift+esc` | 键组合黑名单 |
| `denyWindowTitles` | `[]` | 窗口标题黑名单，可写正则 |
| `protectPasswordFields` | `true` | `type_text` 落到密码框时直接拒绝 |
| `maxActionsPerMinute` | `120` | 每分钟动作上限，**只对会产生副作用的动作计数**（查看类工具不受限） |
| `confirmTools` | `[]` | 列出的工具在钩子层强制弹确认，例如 `["open_app"]` |
| `audit` | `true` | 写审计日志 |
| `overlay` | `true` | 控制会话期间常驻普通鼠标箭头、屏幕高亮框与「谷谷嘎嘎正在控制你的电脑」横幅；`false` 关闭（纯展示，不影响策略） |

匹配规则：普通文本按**子串**匹配（大小写不敏感）；只有包含正则元字符（如 `.*`、`^`、`|`）的条目
才按正则解释。这样 `1password` 这类名字里的字符不会意外变成正则语义。

**改完即生效，不用重启**：每次工具调用前都会比一次策略文件的修改时间，变了就重载。运行中把
`mode` 收紧成 `readonly` 会立刻挡住下一个动作。文件被写坏（正在保存的半截内容也算）时，不会
沿用上一份更宽松的旧规则，而是回落到内置默认策略（`guarded`）。

想更保守，推荐这样起步：

```json
{
  "mode": "readonly",
  "denyApps": ["keepass", "1password", "bitwarden", "lastpass", "dashlane", "credential", "logonui", "winlogon"],
  "denyKeyCombos": ["ctrl+alt+delete", "win+l", "ctrl+shift+esc"],
  "protectPasswordFields": true,
  "maxActionsPerMinute": 60,
  "confirmTools": ["open_app", "press_keys"]
}
```

先用 `readonly` 跑通「看」，确认行为符合预期后再切 `guarded`。

### 审计

`<data_dir>/audit-YYYY-MM-DD.jsonl`，每行一条 JSON：

```json
{"ts": "2026-10-30T11:20:31", "tool": "click", "args": {"x": 420, "y": 318}, "mode": "guarded", "app": "notepad.exe", "decision": "allow", "ok": true}
{"ts": "2026-10-30T11:20:33", "tool": "type_text", "args": {"text": "••••••"}, "mode": "guarded", "app": "", "decision": "allow", "ok": true}
{"ts": "2026-10-30T11:20:35", "tool": "press_keys", "args": {"keys": ["win", "l"]}, "mode": "guarded", "app": "", "decision": "deny", "reason": "key combination 'win+l' is blocked by the policy deny list"}
```

`decision` 取值：`allow`、`deny`、`dry_run`、`error`、`unsupported`。输入文本在日志里脱敏
（短文本变成 `••••••`，长文本保留首尾各 6 个字符）。多个 Antigravity 窗口共用同一个数据目录
时，两边都往同一个文件追加，每行都是完整 JSON。

### 会话健壮性

MCP 连接是长生命周期的：agent 会连续调用几百次，中途出错也不该让整个会话哑掉。

- 收到畸形 JSON、超长行、非法 UTF-8 字节（例如中文参数被截断）时，只回一条错误，**进程继续服务**。
- 单个截图失败、某个控件不可用、策略拒绝，都只是这一次调用失败，后续调用照常。
- 只读工具不受限流影响：agent 需要反复读窗口树来做判断，读操作不该被节流。
- 客户端断开（stdin EOF）时进程干净退出，不会残留。

### 这套策略拦不住什么（诚实边界）

- 它只约束**通过本插件发起的动作**。你自己敲键盘、其它程序做的操作不受影响。
- Windows 安全桌面（UAC 提权弹窗、Ctrl+Alt+Del、锁屏界面）无法被普通进程的 `SendInput` 触达
  —— 这是操作系统设计。默认黑名单里的 `ctrl+alt+delete` / `win+l` 正是为此。
- 以管理员身份运行的目标程序，非管理员权限的 Antigravity 无法操作（UIPI 隔离）。
- 它不能判断一次点击「语义上是否危险」。删文件、发消息、下单这类不可逆动作，仍然依赖 agent
  按 `rules/AGENTS.md` 的约定先问你。

## 5. 平台支持矩阵

| 工具 | Windows 11 | macOS | Linux (X11) |
| --- | --- | --- | --- |
| `get_environment` / `list_windows` / `focus_window` | ✅ EnumWindows / SetForegroundWindow | ✅ System Events | ✅ wmctrl / xdotool |
| `screenshot` | ✅ GDI BitBlt（含分层窗口） | ✅ `screencapture` | ✅ grim / gnome-screenshot / scrot / ImageMagick |
| `ui_tree` / `find_elements` / `click_element` | ✅ UI Automation（PowerShell 桥） | ❌ | ❌ |
| `click` / `drag` / `scroll` | ✅ SendInput | ⚠️ `click`/`scroll` 可用，`drag`/`move_mouse` 明确不支持 | ✅ xdotool |
| `type_text` / `press_keys` | ✅ SendInput（Unicode） | ✅ `keystroke` | ✅ xdotool type / key |
| `clipboard` | ✅ Win32 剪贴板 | ✅ pbcopy / pbpaste | ✅ xclip / wl-copy |
| `open_app` | ✅ `os.startfile` | ✅ `open` | ✅ `xdg-open` |
| 控制鼠标箭头 + 横幅 | ✅ 原生分层窗口（tkinter，标准库） | ❌ 不显示 | ❌ 不显示 |

元素级操作（`ui_tree` / `find_elements` / `click_element`）只在 Windows 实现；其它平台上这些工具
会返回明确的“不支持”错误，`get_environment` 的 `capabilities.ui_tree` 也会是 `false`，agent 据此
回退到「截图 + 坐标」。

## 6. 权限与系统设置

**Windows**

- UI Automation 桥依赖 PowerShell。若组织策略禁止执行脚本，`ui_tree` / `find_elements` /
  `click_element` 会返回明确错误；可执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
- 插件在启动时声明 Per-Monitor V2 DPI 感知，因此截图像素与 `click` 坐标都是**物理像素**，
  多显示器与缩放场景下无需换算。
- 多显示器时使用虚拟屏坐标，副屏在主屏左侧/上方时会出现负坐标，属正常。

**macOS**

- 需要给「启动 Antigravity 的进程」（终端或 Antigravity 本体）授予「辅助功能」和「屏幕录制」
  权限：系统设置 → 隐私与安全性。
- 未授权时截屏为黑屏、按键无效果，`capabilities` 会如实反映。

**Linux**

- 需要 `xdotool`（鼠标键盘）、`wmctrl`（窗口枚举）、`scrot`/`grim`/`gnome-screenshot`（截图）、
  `xclip`（剪贴板）。缺哪个，`get_environment` 的对应能力就是 `false`，并提示装什么。
- Wayland 会话下 `xdotool` 基本失效，建议改用 X11 会话。

## 7. 自检

```bash
python3 scripts/selftest.py
```

它会真的把 MCP server 拉起来、通过 stdin/stdout 走完整协议，覆盖：

1. `initialize` 握手（serverInfo / protocolVersion / capabilities / instructions）
2. `tools/list` 工具目录（15 个工具、无重名、schema 与描述完整、与策略层的工具名一致）
3. 只读调用返回结构
4. 策略拒绝（`win+l` 被拦，且错误里说明是哪条策略）
5. 错误契约（缺参数、未知工具、未知方法 → `-32601`）
6. 平台诚实性（无图形会话时截图报明确错误，而不是假装成功）
7. `dryRun` 只演练不执行
8. `readonly` 模式拦操作、放查看
9. 审计落盘、JSONL 可解析、拒绝被记录、输入文本脱敏
10. 策略文件缺失时自动生成带默认值的文件

第 12 节会切到虚拟桌面后端（`CU_BACKEND=fake`）把「读窗口 → 读树 → 找元素 → 点控件 →
输入 → 剪贴板 → 截屏 → 审计」整条链路真跑一遍，并验证只读工具不被限流。

当前实测结果：**51 项全部通过**（Linux 无图形会话环境；个别用例会随运行环境走不同分支）。
更细的 10 个模块、760 项检查见第 13 节，浮层的真机目视验收见第 13 节的 `overlay_demo.py`。

## 8. 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| Antigravity 里看不到 `computer-use_desktop_*` 工具 | 插件未装到正确位置，或 MCP server 起不来 | 确认插件根目录直接有 `plugin.json`；`agy plugin list --json` 看状态；手动跑 `python scripts/mcp_server.py` 看 stderr |
| server 一起就退出 | 解释器路径不对 | 改 `mcp.json` 的 `command`，或重跑安装脚本 |
| 截屏全黑 | macOS 未授屏幕录制权限；或 Windows 上抓的是受保护窗口 | 授权后重试；受保护窗口（DRM）无法抓取 |
| 坐标总是偏 | 缩放截图未换算，或多屏虚拟坐标 | 按截图返回的 factor 换算；重新 `get_environment` 看屏幕几何 |
| `ui_tree` 返回空 | 目标程序未暴露辅助功能，或窗口还在启动 | 等窗口出现后重试；仍为空就用截图 + 坐标 |
| 点击落在错误位置 | 窗口位置变了，或坐标来自过期截图 | 每次动作前重新截图 / 读树，不要复用旧坐标 |
| 所有动作都被拒 | 策略处于 `readonly`，或应用在黑名单里 | 看 `get_environment` 返回的 policy 块，确认是哪条规则 |
| 钩子不生效 | MCP 工具命名与 matcher 不匹配 | 把 `hooks.json` 的 matcher 改成 `.*`（钩子内部仍按名字过滤） |
| 动作被限流 | 一分钟内超过 `maxActionsPerMinute` | 放慢节奏，或调高该值 |

## 9. 卸载

```bash
agy plugin uninstall computer-use
# 或删除目录
rm -rf ~/.gemini/config/plugins/antigravity computer use-mogu
rm -rf <工作区>/.agents/plugins/antigravity computer use-mogu
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
```

数据目录（策略文件与审计日志）不会被自动删除，需要时手动清理：
`%LOCALAPPDATA%\computer-use` 或 `~/.local/share/computer-use`。

## 10. 已知限制

1. **Windows 后端与 `install.ps1` 尚未在真实 Windows 上实跑。** 开发环境是无图形会话的 Linux，Windows 代码路径
   只做了语法、导入与接口契约级验证；`win_uia.ps1` 依赖 Windows 自带的
   `System.Windows.Automation`。`install.ps1` 同理只做了结构校验（开发环境取不到 PowerShell），
它把 JSON 改写交给已实测的 `scripts/configure.py`，自身只负责解释器探测与文件复制。
请在 Windows 上按第 3、7 节跑一遍，有报错发回来即可修。
2. `hooks.json` 的 matcher 依赖工具名包含 `computer-use`。若你的 Antigravity 版本命名方式不同，
   把 matcher 放宽为 `.*`（钩子内部仍会按名字过滤，不会误伤其它工具）。
3. 若 Antigravity 未向钩子进程导出 `PLUGIN_DATA`，钩子会回退到默认数据目录，可能与 MCP server
   使用的目录不一致。用安装脚本安装会自动写入显式 `--policy` 路径规避。
4. `plugin.json` 里的 `author` 是占位值；上架 Marketplace 前请填上你的信息，并按需补
   `homepage` / `repository`。
5. UI Automation 桥每次调用要起一次 PowerShell 进程（约 0.3–1 秒冷启动）。密集操作时优先用
   `ui_tree` 一次读全、再批量决策，而不是反复 `find_elements`。
6. `scripts/tests/test_windows.py` 用桩替换 `ctypes` 边界，能验证 Windows 后端的**逻辑**
   （按键事件顺序、扩展键标志、修饰键逆序释放、512 事件分批、虚拟屏坐标归一化、剪贴板 UTF-16
   载荷、GDI 句柄回收），但**验证不了真实 Win32 行为**。真机验证仍按第 3、7 节走一遍最稳。
7. **浮层依赖 tkinter**（官方 Windows 安装包自带，已验证可用）。若解释器被裁剪掉 tkinter，
   浮层会自动关闭并在 `${PLUGIN_DATA}/overlay.log` 留一行说明；控制、策略、审计不受影响。
8. **独占全屏应用可能盖住浮层**：普通窗口、浏览器全屏、游戏无边框窗口下浮层都在最上层；
   真独占全屏（DirectX exclusive）无法被普通置顶窗口覆盖，这是系统限制。
9. **浮层默认会出现在截图里**：它是真实的置顶窗口。agent 分析截图时不要把鼠标箭头/横幅当成应用 UI；如需截图隐形，设置 `CU_OVERLAY_CAPTURE_GUARD=1`；
   `list_windows` 已过滤这两个窗口，`WindowFromPoint` 也会穿透它们。

## 11. 目录结构

```
computer-use/
├── plugin.json                  # 插件清单（name / version / logo / suggestedPrompts）
├── mcp.json                     # MCP server 声明，工具命名空间 computer-use_desktop
├── hooks.json                   # PreToolUse 策略闸门
├── rules
│   └── AGENTS.md                # 常驻规则：先看后动、危险动作先确认
├── agents
│   └── desktop-operator.md      # 可选子代理：把大量截图/点击收进独立上下文
├── skills
│   └── computer-use
│       └── SKILL.md             # 使用指南：元素优先、坐标兜底、验证循环
├── assets
│   └── logo.svg                 # 1:1 图标
├── LICENSE
├── README.md
└── scripts
    ├── mcp_server.py            # stdio 入口
    ├── hook_guard.py            # PreToolUse 钩子
    ├── selftest.py              # 端到端自检（含虚拟桌面全链路）
    ├── overlay_host.py          # 独立浮层进程：普通鼠标箭头 + 横幅（tkinter 分层窗口）
    ├── overlay_demo.py          # 浮层真机目视验收：截图 + 点击穿透/不抢焦点/常驻断言
    ├── configure.py             # 安装时改写 mcp.json / hooks.json
    ├── install.ps1 / install.sh # 安装 / 卸载脚本
    ├── win_uia.ps1              # Windows UI Automation 桥
    ├── tests                    # 测试套件：run_all.py + 10 个模块
    │   ├── run_all.py
    │   ├── helpers.py           # 断言器、MCP 客户端、Win32 桩
    │   └── test_*.py
    └── cu
        ├── __init__.py
        ├── protocol.py          # 零依赖 MCP stdio 服务器
        ├── policy.py            # 策略、限流、审计、键名归一化
        ├── tools.py             # 15 个工具的 schema 与实现
        ├── overlay.py           # 浮层客户端：队列、socket、横幅避让算法
        ├── imaging.py           # 纯标准库 PNG 编码
        └── backends
            ├── base.py          # 截屏管线与接口约定
            ├── windows.py       # ctypes 直连 user32/gdi32 + UIA 桥
            ├── macos.py
            ├── linux.py
            └── fake.py          # 虚拟桌面：装前试用 / CI 自检
```

### 重新打包

```bash
python3 scripts/package.py                      # 生成 ../computer-use-plugin-v1.1.0.zip
```

打包用的是显式文件清单：`__pycache__`、`*.pyc`、编辑器临时文件一律排除，脚本置为可执行位，
数据文件保持 644，条目时间戳固定，所以同一份源码打出来的包逐字节一致。


## 12. 虚拟桌面模式（装前试用 / CI 自检）

把 `CU_BACKEND` 设为 `fake`，MCP server 会切到内置的**虚拟桌面**：两个假窗口（记事本、
计算器）、12 个 UI 元素（含 Save 按钮、密码框、被禁用的按钮）、由内存帧缓冲渲染出的真实
PNG，以及一份记录所有输入动作的列表。整条链路——协议 → 策略 → 工具 → PNG → 审计——都真跑，
但**不碰你的真实桌面**，也不需要图形会话。

```bash
CU_BACKEND=fake CU_DATA_DIR=/tmp/cu-try python3 scripts/mcp_server.py
```

用途：安装前先确认 server 能起来、工具调得通；在 CI 或无桌面环境里跑自检；先熟悉工具返回
结构，不用担心误操作。

`CU_BACKEND` 取值：`auto`（默认，按平台自动选）、`windows`、`macos`、`linux`、`fake`。
**未知取值会直接报错**，不会静默降级到别的后端。虚拟桌面不碰真实屏幕，所以也**不会启动控制浮层**。

## 13. 测试

```bash
python3 scripts/tests/run_all.py                          # 全部
python3 scripts/tests/run_all.py test_policy test_tools   # 只跑指定模块
```

零第三方依赖（标准库，自建断言收集器），10 个模块、752 项检查：

| 模块 | 覆盖内容 |
| --- | --- |
| `test_policy` | 模式、黑白名单、密码框、限流、脱敏、策略文件损坏回退 |
| `test_protocol` | JSON-RPC 分帧、错误码、通知不回复、批量请求、超大参数与 Unicode 往返 |
| `test_imaging` | PNG 逐字节结构（签名 / IHDR / IDAT / IEND / CRC）、像素还原、stride 填充、降采样 |
| `test_tools` | 15 个工具的 schema 与参数校验、策略联动、dry-run、限流、审计落盘 |
| `test_overlay` | 横幅文案逐字、开关优先级、横幅避让算法、socket JSONL、工具钩子（含拒绝/dry-run/失败不画）、虚拟桌面不启动浮层 |
| `test_windows` | 桩替换 Win32 层：SendInput 事件序列、结构体布局、坐标映射、GDI 资源回收、剪贴板 UTF-16、浮层窗口过滤 |
| `test_hook` | 钩子拒绝 / 放行矩阵、非法输入 fail-open、命名空间变体、confirmTools |
| `test_manifest` | `plugin.json` / `mcp.json` / `hooks.json` 规范、版本一致性、脚本可编译、打包规则 |
| `test_robustness` | 真起进程：截图缩放端到端、畸形输入后仍存活、300 次连续调用不泄漏句柄、策略热更新、限流窗口、两会话并发写审计、非法 UTF-8 字节 |
| `test_scenario` | 一段真实工作流：读树→找元素→点控件→输入→焦点切换→密码框被拒→剪贴板→快捷键→切窗口→截图→dry-run→审计留痕 |

浮层还要做一次**真机目视验收**（不点击、不输入，只画窗口 + 截屏）：

```bash
python scripts/overlay_demo.py --output C:\path\computer-overlay-test.png --full
```

它会在主屏安全位置显示普通鼠标箭头与横幅，断言：横幅文案逐字一致、两个窗口都带
穿透/不激活/工具窗口样式、前台窗口始终不变、`WindowFromPoint` 穿过横幅落到别的窗口、
空闲等待后光标、屏幕框与横幅仍保持可见，下个动作只移动光标，客户端退出后进程与窗口都消失，并保存证据 PNG。

`test_robustness` 会真的拉起 server 进程做压力与故障注入（含非法 UTF-8、1 MB 垃圾行、畸形参数），
所以它是「能不能一直稳定用」的主要依据；其中字节级用例需要 posix 管道，在 Windows 上会自动跳过。

`test_windows` 用桩替换 `ctypes` 边界，所以**在没有 Windows 的机器上也能验证 Windows 后端的
纯逻辑**：按键事件顺序、扩展键标志、修饰键逆序释放、512 事件分批、虚拟屏坐标归一化、多屏负
原点。真实 Win32 行为仍要在 Windows 上验证；结构体绝对尺寸与偏移的断言只在 4 字节 `LONG` 的
平台上生效（也就是在 Windows 上跑才会执行）。

## 许可

MIT，见 `LICENSE`。
