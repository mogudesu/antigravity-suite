"use strict";

/** 供 Antigravity 调用的工具清单。默认由 isolated 后台无头引擎执行，扩展通道用于录制或明确指定 mode="extension"。 */

const BROWSER_PROP = {
  type: "string",
  enum: ["edge", "chrome", "chromium", "opera"],
  description: "目标浏览器（默认 edge）。",
};
const MODE_PROP = {
  type: "string",
  enum: ["isolated", "extension"],
  description: "执行引擎模式：普通任务默认 isolated（无头后台，零弹窗、不切换用户当前页面、不抢焦点、多会话并发）；仅需操作日常已登录浏览器或 RPA 录制回放时显式传 extension。",
};
const SESSION_PROP = {
  type: "string",
  description: "并发隔离会话 ID；省略时自动按当前 MCP 会话隔离，多子 Agent 并行互不干扰。",
};
const ALLOW_SENSITIVE_PROP = {
  type: "boolean",
  description: "是否允许向敏感字段（密码/OTP/银行卡）输入内容，默认 false（安全策略拦截）。",
};
const TAB_PROP = { type: "integer", description: "目标标签页 id。省略时用当前活动标签页。" };
const TARGET_PROPS = {
  ref: { type: "string", description: "browser_snapshot 返回的元素引用，如 e12。每次 snapshot、页面跳转或元素被重渲染后都会失效，失效时重新 snapshot 即可。" },
  selector: { type: "string", description: "CSS 选择器，与 ref 二选一。" },
  text: { type: "string", description: "元素可见文本（含 aria-label / placeholder）模糊匹配，与 ref / selector 二选一。" },
};

const TOOLS = [
  {
    name: "browser_launch",
    description: "启动或检查浏览器控制引擎：默认 mode=isolated 且 headless=true 在后台无头静默启动；显式传 mode=extension 才连接本机可见扩展通道。返回 mode/headless/sessionId/instanceReused；dryRun=true 仅校验参数不修改会话模式。",
    inputSchema: {
      type: "object",
      properties: {
        browser: { type: "string", enum: ["edge", "chrome", "custom"], description: "要启动的浏览器，默认 edge（Microsoft Edge）。" },
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
        headless: { type: "boolean", description: "isolated 模式下是否无头后台运行，默认 true。" },
        executablePath: { type: "string", description: "浏览器 .exe 的绝对路径；给定时优先于 browser 的已知路径，browser=custom 时必填。" },
        profileDirectory: { type: "string", description: "浏览器配置文件目录名，如 Default 或 Profile 1（仅 extension 模式适用）。" },
        url: { type: "string", description: "启动后打开的地址，默认 about:blank。" },
        waitConnectMs: { type: "integer", description: "等待握手的毫秒数，默认 8000。" },
        dryRun: { type: "boolean", description: "true 时只拼装并返回命令行，不启动浏览器（用于验证启动参数）。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_status",
    description: "查看浏览器控制引擎状态：当前模式（isolated/extension）、标签页数量与当前会话活动标签。",
    inputSchema: { type: "object", properties: { browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }, additionalProperties: false },
  },
  {
    name: "browser_tabs",
    description: "列出 / 切换 / 关闭 / 新建浏览器标签页。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "activate", "close", "new"], description: "默认 list。" },
        tabId: TAB_PROP,
        url: { type: "string", description: "action=new 时要打开的地址，可省略（about:blank）。" },
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_open",
    description: "打开网页（或关键词搜索）。默认在后台孤立会话标签页中静音打开，不弹调试条且不打扰用户当前浏览器。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "网址、域名或搜索词。" },
        newTab: { type: "boolean", description: "true 则新开标签页，默认在当前标签页导航。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_history",
    description: "页面前进 / 后退 / 刷新。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["back", "forward", "reload"] },
        bypassCache: { type: "boolean", description: "reload 时忽略缓存。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description: "读取当前页面结构化快照（支持穿透 iframe 与 Shadow DOM，输出带 ref 编号的可交互元素）。",
    inputSchema: {
      type: "object",
      properties: {
        maxChars: { type: "integer", description: "快照字符上限；compact 模式默认 6000，普通模式默认 12000。" },
        compact: { type: "boolean", description: "紧凑模式：只输出可交互元素、标题与 ref，省略静态正文。" },
        interactiveOnly: { type: "boolean", description: "仅输出可交互元素与 ref。" },
        mode: { type: "string", enum: ["compact", "isolated", "extension"], description: "compact 或指定执行模式。" },
        maxDepth: { type: "integer", description: "DOM 遍历深度上限，默认 40。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        sessionId: SESSION_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "对当前标签页截图并返回图片（后台无头模式在最小化/锁屏下也可正常截图，并自动限制最大宽度 <= 1280px）。",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean", description: "true 截整页，默认只截可视区。" },
        format: { type: "string", enum: ["png", "jpeg"], description: "默认 jpeg（isolated 模式）/ png（extension 模式）。" },
        quality: { type: "integer", description: "jpeg 质量 1-100，默认 82。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "点击元素。优先用 ref / selector / text 定位（支持 iframe / Shadow DOM），也可给视口坐标 x、y。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        nth: { type: "integer", description: "text 匹配到多个时取第几个，从 0 开始。" },
        x: { type: "number", description: "视口 X 坐标（与 y 同时给出时忽略 ref/selector/text）。" },
        y: { type: "number", description: "视口 Y 坐标。" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "默认 left。" },
        clickCount: { type: "integer", description: "连击次数，默认 1；2 表示双击。" },
      }, TARGET_PROPS, { tabId: TAB_PROP, browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "向输入框写文本（默认拦截密码、OTP 与银行卡敏感字段）。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        text: { type: "string", description: "要写入的文本。" },
        clear: { type: "boolean", description: "写入前清空，默认 true；false 表示追加。" },
        submit: { type: "boolean", description: "写完后提交/回车。" },
        realKeys: { type: "boolean", description: "逐字符真实按键。" },
        allowSensitive: ALLOW_SENSITIVE_PROP,
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector, textTarget: { type: "string", description: "当省略 ref/selector 时用于定位的元素文本" } }, { tabId: TAB_PROP, browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }),
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: "按键或组合键（支持 Enter / Tab / Escape / Control+a / Shift+Enter 等）。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        key: { type: "string", description: "按键名、组合键或单个字符。" },
        allowSensitive: ALLOW_SENSITIVE_PROP,
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector }, { tabId: TAB_PROP, browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }),
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description: "把鼠标移到元素上触发 hover 态。",
    inputSchema: {
      type: "object",
      properties: Object.assign({ nth: { type: "integer" } }, TARGET_PROPS, { tabId: TAB_PROP, browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "滚动页面或指定容器。传 ref/selector 并附带 direction/deltaY 时优先滚动该容器或在该元素处滚轮。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "默认 down。" },
        amount: { type: "number", description: "滚动像素，默认 800。" },
        deltaX: { type: "number", description: "水平滚动量，与 direction 二选一。" },
        deltaY: { type: "number", description: "垂直滚动量，与 direction 二选一。" },
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector }, { tabId: TAB_PROP, browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_select_option",
    description: "在下拉框 <select> 里选值，按 value 或可见文本 label。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        value: { type: "string", description: "选项的 value。" },
        label: { type: "string", description: "选项的可见文本，value 未给时使用。" },
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector }, { tabId: TAB_PROP, browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_get_text",
    description: "取元素或整页的可见文本（innerText）。不传目标则返回整页文本。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        maxChars: { type: "integer", description: "文本上限，默认 8000。" },
      }, TARGET_PROPS, { tabId: TAB_PROP, browser: BROWSER_PROP, mode: MODE_PROP, sessionId: SESSION_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description: "在页面主世界执行 JavaScript 表达式并返回结果（支持 await）。",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "要执行的表达式或 IIFE。" },
        awaitPromise: { type: "boolean", description: "表达式返回 Promise 时是否等待，默认 true。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description: "等待某个选择器或文本出现（支持 iframe 与 Shadow DOM），超时返回失败。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "等待出现的 CSS 选择器。" },
        text: { type: "string", description: "等待出现的文本，与 selector 二选一。" },
        timeoutMs: { type: "integer", description: "超时毫秒，默认 15000。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    description: "读取页面控制台日志（console.*、未捕获异常）。",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", description: "按级别过滤，如 error / warning / log。" },
        limit: { type: "integer", description: "返回条数，默认 50。" },
        clear: { type: "boolean", description: "读取后清空缓冲。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    description: "读取页面的网络请求与失败记录。",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "按 URL 子串过滤。" },
        limit: { type: "integer", description: "返回条数，默认 50。" },
        clear: { type: "boolean", description: "读取后清空缓冲。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
        mode: MODE_PROP,
        sessionId: SESSION_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_auth_sync",
    description: "管理独立后台引擎（isolated-profile）的登录态：status 查看已登录域与状态文件，import 导入 cookies/storageState（含从已连接的 extension 当前站点同步），export 导出命名登录态，clear 清理 Cookie。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "import", "export", "clear"], description: "默认 status。" },
        name: { type: "string", description: "命名登录态档案名（存于 ~/.gemini/memory/browser-bridge/auth-states/）。" },
        source: { type: "string", enum: ["file", "cookies", "extension"], description: "import 来源：file/cookies 或已连接 extension 当前活动站点。" },
        storageStatePath: { type: "string", description: "storageState JSON 文件路径（限 ~/.gemini 目录内）。" },
        storageState: { type: "object", description: "内联 Playwright storageState 对象。" },
        cookies: { type: "array", description: "要导入的 Cookie 数组。", items: { type: "object" } },
        domain: { type: "string", description: "目标域名（clear 时按域清理）。" },
        url: { type: "string", description: "source=extension 时要同步的页面 URL。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_open_auth_window",
    description: "弹出独立可见窗口（挂载 isolated-profile）供用户手动完成一次性登录/2FA，不影响用户日常浏览器；登录完毕关闭窗口或调用 action=complete 后自动切回无头后台模式。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "complete", "status"], description: "默认 open。" },
        url: { type: "string", description: "action=open 时打开的登录地址。" },
        browser: { type: "string", enum: ["edge", "chrome", "custom"] },
        executablePath: { type: "string" },
        waitForClose: { type: "boolean", description: "是否阻塞等待用户关闭窗口，默认 false。" },
        timeoutMs: { type: "integer", description: "waitForClose 时的超时毫秒，默认 120000。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_record_start",
    description: "开启浏览器 RPA 录制模式（对标豆包浏览器录制与回放）。在目标标签页注入录制监听与右下角悬浮录制胶囊 HUD，实时记录用户的点击、输入（自动防抖合并，密码自动脱敏）、下拉选择、按键、滚动与跨页跳转，并支持用户在页面胶囊中添加规则备注（💬）或圈选标记要提取的数据区域（🎯）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "可选：开启录制前先导航到的目标网址；省略时直接录制当前活动标签页。" },
        title: { type: "string", description: "可选：本次录制任務的名称或意图描述。" },
        newTab: { type: "boolean", description: "可选：是否新开标签页进行录制，默认 false。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_record_stop",
    description: "结束当前浏览器 RPA 录制（或拉取用户在页面悬浮胶囊/扩展弹窗中已点击完成的最近一次录制），自动对步骤去重合并、提炼可变参数候选（suggestedParameters），持久化保存到本地 recordings 目录并返回完整轨迹 JSON，供后续编译生成可复用 Skill。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "可选：覆盖或补充本次录制的标题。" },
        save: { type: "boolean", description: "是否落盘保存到本地 recordings 目录，默认 true。" },
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_record_list",
    description: "查询浏览器 RPA 录制状态、列出本地已保存的历史录制记录，或读取某条录制记录的完整 JSON 步骤详情（含 suggestedParameters、userNotes、extractTargets）。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "list", "get"], description: "status 查看当前录制状态与最新录制；list 列出历史录制；get 读取指定录制完整详情。默认 status。" },
        recordingId: { type: "string", description: "action=get 时要读取的 recordingId 或工作流 JSON 路径；省略时默认读取最新一条（latest）。" },
        limit: { type: "integer", description: "action=list 时返回的最大条数，默认 20。" },
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_record_replay",
    description: "确定性快速回放已录制的浏览器 RPA 轨迹或 Skill 工作流。vars 支持替换 {{变量}}（含 {{变量|url}} / {{变量|json}} 过滤器）并可传数组供 loop 迭代。除导航/点击/输入/选择/提取/等待外，支持 loop 循环、if 条件分支、evaluate 页面求值并 saveAs、assert 结果校验、retry 子步骤重试、throttle 限速、newTab/selectTab 多标签、setVar 运行时变量；返回 validated、checks、iterations 与嵌套 trace。失败时返回 failedStepIndex / failedPath 供 Agent 用 browser_snapshot 断点自愈。",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "要回放的录制 ID（如 rec-xxx 或 latest）。与 workflowPath / steps 三选一。" },
        workflowPath: { type: "string", description: "Skill 目录下的 workflow.recording.json 绝对路径。" },
        steps: { type: "array", description: "直接传入的步骤数组（可选，优先于 recordingId）。", items: { type: "object" } },
        vars: { type: "object", description: "参数化变量键值对（如 {\"keyword\": \"机械键盘\"}），值可为数组供 loop.items 迭代；用于替换步骤中的 {{变量名}}，支持 {{变量名|url}}、{{变量名|json}} 过滤器。" },
        stepDelayMs: { type: "integer", description: "顶层步骤之间的间隔毫秒数，默认 400；循环内部用 loop.delayMs 或 throttle 控制。" },
        stopOnError: { type: "boolean", description: "遇到单步失败时是否立即暂停并交还 Agent 接管，默认 true；单个步骤可用 continueOnError:true 单独放行。" },
        maxSteps: { type: "integer", description: "整次回放最多执行的原子步骤数，默认 2000，防止失控循环。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_extension_reload",
    description: "重载浏览器扩展的 service worker（更新插件文件后录制/回放工具若报「扩展不认识这个工具」，调用本工具即可自动重载；会短暂打开一个扩展页标签并自动关闭）。",
    inputSchema: {
      type: "object",
      properties: {
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
];

const LONG_TOOLS = new Set([
  "browser_screenshot", "browser_wait_for", "browser_open", "browser_history",
  "browser_launch", "browser_record_start", "browser_record_replay",
  "browser_auth_sync", "browser_open_auth_window",
]);

function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

function timeoutFor(name, args) {
  if (name === "browser_launch") return Math.min(Number((args && args.waitConnectMs) || 8000) + 5000, 130000);
  if (name === "browser_open_auth_window") return Math.min(Number((args && args.timeoutMs) || 120000) + 10000, 180000);
  if (name === "browser_wait_for") return Number((args && args.timeoutMs) || 15000) + 10000;
  if (name === "browser_record_replay") return 120000;
  if (LONG_TOOLS.has(name)) return 60000;
  return 30000;
}

module.exports = { TOOLS, findTool, timeoutFor };
