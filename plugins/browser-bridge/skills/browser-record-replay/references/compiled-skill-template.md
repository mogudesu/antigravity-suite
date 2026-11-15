# 编译生成的浏览器自动化 Skill 标准模板

当将一次 `browser-record-replay` 录制轨迹编译为新 Skill（目录：`~/.gemini/config/skills/<skill-slug>/`）时，请按以下结构生成 `workflow.recording.json` 与 `SKILL.md`。

---

## 1. `workflow.recording.json` 模板

```json
{
  "schemaVersion": "1.0",
  "recordingId": "rec-xxx",
  "title": "<业务流程中文名>",
  "browser": "edge",
  "parameters": {
    "keyword": {
      "type": "string",
      "description": "<参数说明>",
      "default": "<录制时的原始值>",
      "required": true
    }
  },
  "steps": [
    {
      "index": 1,
      "sourceStepIndex": 1,
      "type": "navigate",
      "url": "https://example.com"
    },
    {
      "index": 2,
      "sourceStepIndex": 3,
      "type": "type",
      "value": "{{keyword}}",
      "submit": true,
      "locator": {
        "semantic": { "role": "searchbox", "name": "搜索", "tag": "input" },
        "selector": "input[type=\"search\"]",
        "fallbacks": ["#search-input"]
      }
    },
    {
      "index": 3,
      "sourceStepIndex": 7,
      "type": "extract",
      "field": "items",
      "mode": "list",
      "listSelector": ".result-list > .item",
      "locator": {
        "semantic": { "role": "", "name": "结果项", "tag": "div" },
        "selector": ".result-list > .item:nth-of-type(1)"
      },
      "userNote": "提取列表文本并整理为结构化表格"
    }
  ]
}
```

---

## 2. `SKILL.md` 模板

```markdown
---
name: <skill-slug>
description: <一句话描述该技能自动执行的网页任务、适用网站、支持的参数以及产出结果。包含用户常说的触发词。>
---

# <业务流程中文名>

本技能由 `browser-record-replay` 从真实浏览器操作录制编译生成，底层通过 `antigravity-browser-bridge` 执行确定性回放与智能自愈。

## 输入参数（Parameters）

| 参数名 (`vars` 键) | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `keyword` | 是 | `<录制原值>` | `<参数业务含义>` |

## 标准执行流程

### 第一步：启动并调用确定性快放（Fast Replay）

1. 调用 `browser_launch(browser="edge")` 确保浏览器与扩展已连接。
2. 调用 `browser_record_replay` 一次性执行参数化工作流：
   ```json
   {
     "workflowPath": "C:/Users/25350/.gemini/config/skills/<skill-slug>/workflow.recording.json",
     "vars": {
       "keyword": "<用户本次指定的参数值>"
     }
   }
   ```
3. 如果返回 `ok: true`，直接读取返回值中的 `extractedData` 进入【结果处理与输出】。

### 第二步：断点智能自愈（Self-Healing Fallback）

若因目标网站改版、偶发弹窗或登录态过期导致 `browser_record_replay` 在某一步返回 `ok: false` 及 `failedStepIndex`：
1. 不要从头重跑！先调用 `browser_snapshot(compact=true)` 查看当前页面状态。
2. 对照下方【步骤语义说明书】，从第 `failedStepIndex + 1` 步开始，使用 `browser_click` / `browser_type` / `browser_get_text` 完成剩余步骤：
   - **步骤 1（打开页面）**：访问 `<URL>`。
   - **步骤 2（输入并提交）**：在 `<元素语义名>` 输入 `{{keyword}}` 并触发搜索/提交（备注：`<userNote>`）。
   - **步骤 3（数据提取）**：读取 `<目标区域描述>` 的内容。

## 结果处理与输出

- 将采集到的 `extractedData` 按照用户需求清洗整理（如去除广告项、格式化为 Markdown 表格或导出文件）。
```

---

## 3. 编译硬性约束（交付前必须机器校验）

编译产物不是「一份好看的说明书」，而是「把录制轨迹变成可确定性执行的程序」。
以下规则由校验脚本强制检查，存在 ERROR 时**禁止交付**：

```bash
node scripts/validate-compiled-skill.js <skill目录> --recording <原始录制.json>
```

1. **可追溯**：每个 step 必须带 `sourceStepIndex`，指向原始录制里对应的 `index`。
   删除的步骤要在 SKILL.md 写明清洗理由；禁止把录制中不存在的动作写成「已录制步骤」。
2. **参数闭环**：`parameters` 里每个键都必须被至少一个 step 的 `{{变量名}}` 引用；
   step 里出现的占位符必须已定义；SKILL.md 参数表不得声明 workflow 里没有的参数。
3. **URL 真实**：SKILL.md 中出现的 URL 必须能在 `workflow.steps` 的 `url` 里找到。
   只在原始录制出现、但已被编译删除的 URL 同样不能写进 SOP（写了回放也不会执行到）。
4. **确定性快放**：SKILL.md 第一步必须是 `browser_record_replay(workflowPath, vars)`，
   并写明 `failedStepIndex` 断点自愈；自然语言 SOP 只能兜底，不能当主执行路径。
5. **脚本有入口**：`scripts/` 下每个文件都必须被 SKILL.md 明确引用并说明调用方式
   （`browser_evaluate` 执行页面脚本 / `node` 执行本地脚本），不允许无引用的死代码。
6. **验证闭环**：必须试跑一次并把结果写入 SKILL.md 或 CHANGELOG；未试跑的产物显式标注
   `verified:false`，不得声称「已验证」。

---

## 4. 回放引擎支持的步骤类型

原有 9 类：`navigate` / `click` / `type` / `select` / `press` / `scroll` / `extract` / `wait` / `note`。

| type | 关键字段 | 作用 |
| :--- | :--- | :--- |
| `loop` / `forEach` | `items`（数组或 `{{arrayVar}}`）、`count`、`var`（默认 `item`）、`indexVar`、`steps`、`delayMs`、`maxIterations`、`continueOnError` | 迭代执行子步骤，每轮注入循环变量 |
| `if` | `expression`（页面求值）、`selector`、`var` + `op` + `value`、`then` / `else` | 条件分支；`op` 支持 truthy / equals / notEquals / gt / lt / contains |
| `evaluate` | `expression`、`saveAs` | 页面 JS 求值，结果存入运行时变量 |
| `assert` / `verify` | `expression` / `selector` / `text` / `var` + `expected`、`name`、`soft` | 结果校验；硬失败中断并返回断点，`soft` 只记录不阻断 |
| `retry` | `times`、`delayMs`、`steps` | 子步骤整组失败时重试，失败尝试的 trace / checks 会回滚 |
| `throttle` | `ms` | 保证距上一步至少 `ms`，用于防风控间隔 |
| `setVar` | `name`、`value` 或 `expression` | 设置运行时变量 |
| `newTab` | `url` | 在专属后台窗口新建标签并切换 |
| `selectTab` | `tabId` / `index` / `url` | 切换当前控制标签 |

模板变量：`{{key}}`、`{{key|url}}`（encodeURIComponent）、`{{key|json}}`（生成合法 JS 字面量）、
`{{key|upper}}` / `{{key|lower}}` / `{{key|trim}}`。`vars` 可传数组，整串 `{{arrayVar}}` 会保留数组类型供 `loop.items` 使用。
`selector` 既可写在 `locator.selector`（录制格式），也可直接写在步骤顶层（手写 workflow）。

回放返回：`ok` / `validated` / `checks` / `iterations` / `vars` / `extractedData` / `trace`（含嵌套 `path`）；
失败时另有 `failedStepIndex` / `failedPath` / `failedStep` / `selfHealHint`。

示例（多轮搜索 + 每轮限速 + 结果校验）：

```json
{
  "schemaVersion": "1.0",
  "title": "多次搜索并校验",
  "parameters": { "terms": { "type": "array", "default": ["a", "b", "c"] } },
  "steps": [
    { "index": 1, "sourceStepIndex": 1, "type": "navigate", "url": "https://www.bing.com/" },
    { "index": 2, "synthesized": true, "type": "loop", "var": "term", "indexVar": "idx",
      "items": "{{terms}}", "maxIterations": 30, "delayMs": 4000,
      "steps": [
        { "type": "navigate", "url": "https://www.bing.com/search?q={{term|url}}" },
        { "type": "throttle", "ms": 4000 },
        { "type": "assert", "name": "搜索结果已渲染", "selector": "#b_results" }
      ] },
    { "index": 3, "synthesized": true, "type": "evaluate",
      "expression": "(() => document.querySelectorAll('#b_results > li').length)()",
      "saveAs": "resultCount" },
    { "index": 4, "synthesized": true, "type": "assert",
      "name": "结果页仍有内容", "expression": "(() => !!document.querySelector('#b_results'))()" }
  ]
}
```

**规则合成步骤**：`loop` / `if` / `assert` / `throttle` / `retry` 等不是录制动作。编译时若由用户备注
或业务规则补写，必须显式标 `"synthesized": true` 并在 SKILL.md 写明依据；否则一致性校验会判为
无法回溯的「凭空补写」。录制清洗后保留的步骤仍要带 `sourceStepIndex`。
