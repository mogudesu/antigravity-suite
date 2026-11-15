# Browser Bridge 规则

- 默认用独立无头 `isolated` 模式后台并发；需共用登录态或录制（`browser_record_*`）时选 `extension`（Edge 优先，8767）。
- 禁读无关隐私/密码；内部页失败属预期，详见 `browser-bridge` 技能。
