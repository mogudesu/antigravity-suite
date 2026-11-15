# Desktop Control 规则

- 优先 CLI/文件/MCP 与无头浏览器，桌面控制仅作无 API 的最后手段；多步 GUI 任务优先委派 `desktop-operator`。
- 首次桌面动作前调 `get_environment`；优先 `ui_tree`/`click_element` 后台激活、礼让键鼠与目标屏遮罩；禁输密码字段，不可逆操作须用户确认（详见 `computer-use`）。
