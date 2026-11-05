# Browser Bridge Agent 规则

以下规则适用于使用 `antigravity-browser-bridge` 的所有会话与子 Agent。

1. **Edge 优先**：用户没有明确指定浏览器时，一律用 `browser_launch` 的默认 `browser="edge"`；只有用户要求 Chrome 或 Edge 不可用时才切换。
2. **先启动再操作**：任何页面操作前先 `browser_launch`（或确认已连接），再用 `browser_status` 确认 `bridge.state = connected`。
3. **ref 优先**：点击/输入前必须 `browser_snapshot` 取 `ref`；禁止凭记忆复用旧 `ref`。页面跳转、弹窗、局部刷新后重新 snapshot。
4. **操作后验证**：关键点击/提交后重新 `browser_snapshot`（必要时 `browser_screenshot`）确认结果，不要假设成功。
5. **不要抢端口**：`127.0.0.1:8767` 由 Leader 独占，其他会话是 Follower 中继。禁止杀进程、改端口或并行启动多个 Leader 来「解决冲突」；Leader 退出后 Follower 会自动接管。
6. **不要重复开浏览器**：`browser_launch` 在目标浏览器已连接时返回 `already-connected` 且不再启动新窗口。
7. **扩展缺失时给路径**：若返回 `launched-without-extension`，把 `extensionPath` 与 `setupScript` 原样告诉用户，并说明 `edge://extensions` 加载步骤；不要尝试自动把扩展装入用户浏览器。
8. **不碰全局配置**：不要修改 `~/.gemini/config/mcp_config.json` 或 `~/.gemini/antigravity/mcp_config.json`；全局注册由主 Agent 合并。
9. **验证命令用 dry-run**：需要确认浏览器启动参数时使用 `browser_launch(..., dryRun: true)`，不要在无人值守测试中真正拉起浏览器窗口。
10. **隐私与安全**：只执行用户明确要求的页面操作；不要读取、导出或提交与任务无关的账号、密码、支付与隐私数据。受保护页面（`edge://`、`chrome://`、扩展商店、PDF 阅读器）上的失败是预期行为，应改用普通网页。
11. **超时处理**：`TIMEOUT` 多由系统弹窗、权限框或页面脚本阻塞引起；先请用户处理弹窗，再用 `browser_status` / `browser_snapshot` 恢复，不要盲目重试同一动作。
12. **RPA 录制与回放（`browser-record-replay`）**：当用户要求“录制我的浏览器操作”、“演示一遍生成 Skill”或“回放录制流程”时，读取 `browser-record-replay` 技能，用 `browser_record_start` / `browser_record_stop` / `browser_record_list` / `browser_record_replay` 完成录制、参数提炼、编译生成专属 Skill（含 `SKILL.md` 与 `workflow.recording.json`）及快放自愈闭环。
