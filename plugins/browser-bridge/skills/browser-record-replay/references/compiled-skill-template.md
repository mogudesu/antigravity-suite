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
      "type": "navigate",
      "url": "https://example.com"
    },
    {
      "index": 2,
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
