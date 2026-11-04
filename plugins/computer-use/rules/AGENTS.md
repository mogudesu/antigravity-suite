# Desktop control rules

These rules apply whenever you drive the computer-use plugin's MCP tools
(`computer-use_desktop_*`).

## Before acting

- Call `get_environment` once per session before the first desktop action. It
  reports the platform, screen geometry, which capabilities exist and the
  active safety policy. Re-check it after the user changes displays or edits
  the policy file.
- If a shell command, a file tool or another MCP server can do the job, use
  that instead. Desktop control is the last resort, not the first move.
- Confirm with the user before anything you cannot undo: deleting or
  overwriting files, sending messages or email, submitting forms, making
  purchases, changing system or security settings.

## While acting

- After the first executed action, the user sees a persistent plain mouse-arrow
  cursor, a Codex-style screen-edge highlight and a topmost banner reading
  "谷谷嘎嘎正在控制你的电脑". They stay up for the whole control session. They
  are the plugin's own click-through decoration: never click them, close them,
  or treat them as the target application.
- Prefer `ui_tree`, `find_elements` and `click_element` over screenshots and
  raw coordinates. Element rectangles are exact; eyeballed pixels are not.
- Call `focus_window` before typing. Keystrokes go to whatever holds focus.
- Verify with a fresh `screenshot` or `ui_tree` after each step, then decide
  the next one. Never chain several unverified actions.
- Never type credentials, tokens or other secrets into any field, and never
  try to work around a policy refusal. If a tool is blocked, name the rule
  that blocked it and stop.

## Reporting

- State which application and window you are operating on, and why.
- When you finish, summarise what changed and anything you could not verify.
