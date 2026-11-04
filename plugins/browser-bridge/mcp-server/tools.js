"use strict";

/** 供 Antigravity 调用的工具清单。所有调用最终转发给浏览器扩展执行。 */

const BROWSER_PROP = {
  type: "string",
  enum: ["edge", "chrome", "chromium", "opera"],
  description: "目标浏览器（装了本扩展的那一个）。省略时用最近连接的那个；同时开着 Edge 和 Chrome 时才需要显式指定。",
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
    description: "启动本机 Edge / Chrome（或自定义浏览器）并等待浏览器扩展握手，是浏览器操作的第一步。browser=edge（默认）/chrome/custom；custom 必须给 executablePath。若对应浏览器扩展已连接则不重复启动。扩展未安装时返回扩展目录路径与安装指引（含 scripts/open-edge-extension-setup.ps1）。dryRun=true 只返回将要执行的命令行，不真正启动浏览器。",
    inputSchema: {
      type: "object",
      properties: {
        browser: { type: "string", enum: ["edge", "chrome", "custom"], description: "要启动的浏览器，默认 edge（Microsoft Edge）。" },
        executablePath: { type: "string", description: "浏览器 .exe 的绝对路径；给定时优先于 browser 的已知路径，browser=custom 时必填。" },
        profileDirectory: { type: "string", description: "浏览器配置文件目录名，如 Default 或 Profile 1（对应 --profile-directory）。" },
        url: { type: "string", description: "启动后打开的地址，默认 about:blank。" },
        waitConnectMs: { type: "integer", description: "等待扩展握手的毫秒数，默认 8000。" },
        dryRun: { type: "boolean", description: "true 时只拼装并返回命令行，不启动浏览器（用于验证启动参数）。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_status",
    description: "查看桥接状态：浏览器类型、扩展版本、连接状态、标签页数量、CDP 附加情况，以及用户当前标签页（activeTab）与代理专属后台标签页（leaseTab/leaseCursor）。排查「没反应」时先调它。",
    inputSchema: { type: "object", properties: { browser: BROWSER_PROP }, additionalProperties: false },
  },
  {
    name: "browser_tabs",
    description: "列出 / 切换 / 关闭 / 新建浏览器标签页。list 返回所有标签页的 id、标题、URL、groupId 与 leased 标记。new 在当前窗口创建代理专属标签页、置为 active 并加入「谷谷嘎嘎控制中」紫色分组；用户原标签页保持打开、不被改写。activate 会显式切到前台。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "activate", "close", "new"], description: "默认 list。" },
        tabId: TAB_PROP,
        url: { type: "string", description: "action=new 时要打开的地址，可省略（about:blank）。" },
        browser: BROWSER_PROP,
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_open",
    description: "在代理专属分组标签页里打开地址；该标签页在当前窗口内、属于「谷谷嘎嘎控制中」紫色分组，会激活以便用户看到鼠标和原生提示条。用户原标签页保持打开、不被改写。传入的不是 URL 时自动按搜索处理（默认必应，可在扩展弹窗里改）。newTab=true 会再创建一个分组专属标签页并成为 leaseTab；需要控制用户指定的标签页时显式传 tabId。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "网址、域名或搜索词。" },
        newTab: { type: "boolean", description: "true 则新开标签页，默认在当前标签页导航。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
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
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description: "读取当前页面的结构化快照（标题、URL、可交互元素带 ref 编号、标题层级与可见文本）。默认读取「谷谷嘎嘎控制中」分组里的 leaseTab，不会触碰用户原标签页；传 tabId 可读取指定标签。控制会话中页面内会常驻可见鼠标（pointer-events:none）。做任何点击/输入之前先调它拿到 ref。ref 按 DOM 顺序确定性编号，同一页面结构下重复调用编号不变；但页面跳转、局部重渲染或元素被移除后旧 ref 会失效，此时重新 snapshot 即可。",
    inputSchema: {
      type: "object",
      properties: {
        maxChars: { type: "integer", description: "快照字符上限；compact 模式默认 6000，普通模式默认 14000。" },
        compact: { type: "boolean", description: "紧凑模式：只输出可交互元素、标题与 ref，省略静态正文，显著降低长页面上下文消耗。默认 false。" },
        mode: { type: "string", enum: ["compact"], description: "compact 的等价写法。" },
        maxDepth: { type: "integer", description: "DOM 遍历深度上限，默认 40。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "对当前标签页截图并返回图片。CDP 通道可用时支持整页截图（fullPage=true）。",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean", description: "true 截整页（需要 CDP），默认只截可视区。" },
        format: { type: "string", enum: ["png", "jpeg"], description: "默认 png。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "点击元素。优先用 ref / selector / text 定位；也可直接给视口坐标 x、y。CDP 可用时派发真实鼠标事件，否则退回元素原生 click()。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        nth: { type: "integer", description: "text 匹配到多个时取第几个，从 0 开始。" },
        x: { type: "number", description: "视口 X 坐标（与 y 同时给出时忽略 ref/selector/text）。" },
        y: { type: "number", description: "视口 Y 坐标。" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "默认 left。" },
        clickCount: { type: "integer", description: "连击次数，默认 1；2 表示双击。" },
      }, TARGET_PROPS, { tabId: TAB_PROP, browser: BROWSER_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "向输入框写文本。默认用原生 value setter + input/change 事件，对 React / Vue 受控输入有效；realKeys=true 改为逐字符派发真实按键。密码框会被安全策略拒绝（不读取、不写入），请让用户手动输入密码。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        text: { type: "string", description: "要写入的文本。" },
        clear: { type: "boolean", description: "写入前清空，默认 true；false 表示追加。" },
        submit: { type: "boolean", description: "写完后提交所属表单。" },
        realKeys: { type: "boolean", description: "逐字符真实按键（需要 CDP），适合有 keydown 监听的站点。" },
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector }, { tabId: TAB_PROP, browser: BROWSER_PROP }),
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: "按键。支持 Enter / Tab / Escape / Backspace / Delete / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Home / End / PageUp / PageDown / Space 或单个字符。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        key: { type: "string", description: "按键名或单个字符。" },
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector }, { tabId: TAB_PROP, browser: BROWSER_PROP }),
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description: "把鼠标移到元素上，触发 hover 态。需要 CDP 通道。",
    inputSchema: {
      type: "object",
      properties: Object.assign({ nth: { type: "integer" } }, TARGET_PROPS, { tabId: TAB_PROP, browser: BROWSER_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "滚动页面。给 direction + amount，或直接给 deltaX / deltaY；给 ref / selector 则滚动到该元素。",
    inputSchema: {
      type: "object",
      properties: Object.assign({
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "默认 down。" },
        amount: { type: "number", description: "滚动像素，默认 800。" },
        deltaX: { type: "number", description: "水平滚动量，与 direction 二选一。" },
        deltaY: { type: "number", description: "垂直滚动量，与 direction 二选一。" },
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector }, { tabId: TAB_PROP, browser: BROWSER_PROP }),
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
      }, { ref: TARGET_PROPS.ref, selector: TARGET_PROPS.selector }, { tabId: TAB_PROP, browser: BROWSER_PROP }),
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
      }, TARGET_PROPS, { tabId: TAB_PROP, browser: BROWSER_PROP }),
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description: "在页面主世界执行 JavaScript 表达式并返回结果（绕开页面 CSP，支持 await）。需要 CDP 通道。",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "要执行的表达式或 IIFE。" },
        awaitPromise: { type: "boolean", description: "表达式返回 Promise 时是否等待，默认 true。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description: "等待某个选择器出现或某段文本出现，超时返回失败。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "等待出现的 CSS 选择器。" },
        text: { type: "string", description: "等待出现的文本，与 selector 二选一。" },
        timeoutMs: { type: "integer", description: "超时毫秒，默认 15000。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    description: "读取页面控制台日志（console.*、未捕获异常、浏览器日志）。需要 CDP 已附加到该标签页。",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", description: "按级别过滤，如 error / warning / log。" },
        limit: { type: "integer", description: "返回条数，默认 50。" },
        clear: { type: "boolean", description: "读取后清空缓冲。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    description: "读取页面的网络请求记录（请求、响应、失败）。需要 CDP 已附加到该标签页。",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "按 URL 子串过滤。" },
        limit: { type: "integer", description: "返回条数，默认 50。" },
        clear: { type: "boolean", description: "读取后清空缓冲。" },
        tabId: TAB_PROP,
        browser: BROWSER_PROP,
      },
      additionalProperties: false,
    },
  },
];

const LONG_TOOLS = new Set(["browser_screenshot", "browser_wait_for", "browser_open", "browser_history", "browser_launch"]);

function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

function timeoutFor(name, args) {
  if (name === "browser_launch") return Math.min(Number((args && args.waitConnectMs) || 8000) + 5000, 130000);
  if (name === "browser_wait_for") return Number((args && args.timeoutMs) || 15000) + 10000;
  if (LONG_TOOLS.has(name)) return 60000;
  return 30000;
}

module.exports = { TOOLS, findTool, timeoutFor };
