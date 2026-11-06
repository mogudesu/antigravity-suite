/**
 * Antigravity 星夜主题引擎 v3.0 · Module 2
 * 原生双向无损汉化引擎 / Native reversible zh-CN <-> en translation engine
 *
 * Design goals
 * - Reversible: every Text node's original value is snapshotted in a WeakMap<Text, string>,
 *   so switching back to `en` restores the exact bytes without reloading the page.
 * - Non-destructive: only text nodes and the visible `placeholder` / `title` attributes are
 *   touched. `aria-label`, `data-testid`, `role`, `class`, ids and element structure are never
 *   modified. Originals of translated attributes are parked in `data-ag-orig-*` and removed
 *   again on restore.
 * - Safe: code, editors, terminals (xterm/canvas), markdown documents, user conversation
 *   titles / messages and sidebar project names are hard-excluded.
 * - Incremental: MutationObserver + requestAnimationFrame batching (with a setTimeout
 *   fallback for hidden windows where rAF is frozen). No periodic full-body scans.
 *
 * Public API (window.__agI18n)
 *   setLanguage('zh-CN' | 'en') -> language
 *   getLanguage()              -> 'zh-CN' | 'en'
 *   apply(root?)               -> language        (re-run current language on a subtree)
 *   stop()                     -> true            (disconnect observer + restore originals)
 *   start()                    -> true            (re-attach observer + translate if zh-CN)
 *   stats()                    -> { ... }         (diagnostics, dictionary size, timings)
 *   translate(text, lang?)     -> string | null   (pure lookup helper, zh -> en supported)
 *
 * window.__agSetLanguage is kept as a compatibility alias.
 */
(function antigravityI18nEngine() {
  'use strict';

  var VERSION = '3.0.0';
  if (window.__agI18n && window.__agI18n.version === VERSION) return;

  var CONFIG = (window.__AG_CONFIG__ && typeof window.__AG_CONFIG__ === 'object') ? window.__AG_CONFIG__ : {};
  var ALERTS_ENABLED = CONFIG.translateAlerts !== false;

  // ---------------------------------------------------------------------------
  // 1. Dictionary (EN -> ZH). Built from the legacy translate.js corpus plus the
  //    live Antigravity 2.x UI bundle. Keys are exact labels only: arbitrary
  //    prose / chat content can never match because chat markdown is excluded.
  // ---------------------------------------------------------------------------
  var DICT = {
    // ----- App / title menu -------------------------------------------------
    'File': '文件',
    'Edit': '编辑',
    'View': '视图',
    'Window': '窗口',
    'Help': '帮助',
    'Workspace': '工作区',
    'Workspaces': '工作区',
    'New Window': '新建窗口',
    'Close Window': '关闭窗口',
    'Reload': '重新加载',
    'Reload Window': '重新加载窗口',
    'Toggle Full Screen': '切换全屏',
    'Zoom In': '放大',
    'Zoom Out': '缩小',
    'Reset Zoom': '重置缩放',
    'Developer Tools': '开发者工具',
    'Toggle Developer Tools': '打开/关闭开发者工具',
    'Check for Updates': '检查更新',
    'Automatic Check for Updates': '自动检查更新',
    'Settings': '设置',
    'Quit': '退出',
    'Minimize': '最小化',
    'Maximize': '最大化',
    'Restore': '还原',
    'Close': '关闭',
    'About': '关于',
    'Docs': '官方文档',
    'Documentation': '文档',
    'Command Palette': '命令面板',
    'Open Command Palette': '打开命令面板',
    'Toggle Sidebar': '切换侧边栏',
    'Toggle Terminal': '切换终端',
    'Toggle Auxiliary Pane': '切换辅助面板',
    'Toggle Overview Panel': '切换总览面板',
    'Show or Hide Extensions': '显示或隐藏扩展',
    'App update required': '需要更新应用',
    'Plugin update required': '需要更新插件',
    'Update Available': '发现可用更新',
    'Up to Date': '当前已是最新版本',
    'Version': '版本',
    'App version': '应用版本',
    'Uptime': '运行时长',
    'Operating System': '操作系统',
    'Device Name': '设备名称',
    'Remote Control': '远程控制',
    'Enable Remote Control': '启用远程控制',
    'Remote Control link': '远程控制链接',
    'Command': '命令',
    'Commands': '命令',
    'Command Setup Script': '命令初始化脚本',

    // ----- Sidebar / navigation / list --------------------------------------
    'New Conversation': '新建对话',
    'Automations': '自动化',
    'Customizations': '自定义配置',
    'Conversations': '对话',
    'Conversation': '对话',
    'Project': '项目',
    'Projects': '项目',
    'Not in Project': '未在项目内',
    'New Project': '新建项目',
    'Create Project': '创建项目',
    'Project Name': '项目名称',
    'Project options': '项目选项',
    'Project Settings': '项目设置',
    'See all': '查看全部',
    'See less': '收起',
    'Mark All as Read': '全部标为已读',
    'Mark as Read': '标为已读',
    'Mark as Unread': '标为未读',
    'Mark This Conversation as Read': '将此对话标为已读',
    'Mark This Conversation as Unread': '将此对话标为未读',
    'Group By': '分组方式',
    'Group By Project': '按项目分组',
    'Group By Workspace': '按工作区分组',
    'Sort By': '排序方式',
    'Sort Conversations': '排序对话',
    'Filter': '筛选',
    'Filter resources...': '筛选资源...',
    'Custom Order': '自定义排序',
    'Last Updated': '最近更新',
    'Last Prompt': '最近提问',
    'This Computer': '本机',
    'This computer': '本机',
    'Cloud': '云端',
    'Cloud only': '仅云端',
    'Local only': '仅本地',
    'Local': '本地',
    'Global': '全局',
    'Archived': '已归档',
    'Show Subtitles': '显示副标题',
    'Search Conversations': '搜索对话',
    'Search conversations...': '搜索对话...',
    'Search for conversations...': '搜索对话...',
    'Search projects...': '搜索项目...',
    'Search workspaces...': '搜索工作区...',
    'Search customizations...': '搜索自定义配置...',
    'New Group': '新建分组',
    'Move to Group': '移至分组',
    'Move to New Group': '移至新分组',
    'Remove from Group': '从分组移除',
    'Rename Group': '重命名分组',
    'Rename': '重命名',
    'Rename Conversation': '重命名对话',
    'Rename This Conversation': '重命名此对话',
    'Archive': '归档',
    'Archive project': '归档项目',
    'Archive Workspace': '归档工作区',
    'Archive This Conversation': '归档此对话',
    'Delete': '删除',
    'Delete Conversation': '删除对话',
    'Delete Permanently': '永久删除',
    'Pin This Conversation': '置顶此对话',
    'Unpin This Conversation': '取消置顶此对话',
    'Pinned Conversations': '已置顶对话',
    'Mark Unread': '标为未读',
    'Mark Read': '标为已读',
    'Copy Project Name': '复制项目名称',
    'Show in File Explorer': '在资源管理器中显示',
    'Delete Project': '删除项目',
    'Share': '分享',
    'Share Conversation (Preview)': '分享对话（预览）',
    'Fork': '分叉',
    'Fork conversation in this folder': '在此文件夹中分叉对话',
    'Fork in New Workspace': '在新工作区中分叉',
    'Fork in Shared Workspace': '在共享工作区中分叉',
    'Split': '拆分',
    'Split Right': '向右拆分',
    'Split Down': '向下拆分',
    'Split Terminal': '拆分终端',
    'Move Conversation Up': '上移对话',
    'Move Conversation Down': '下移对话',
    'New Conversation in Project': '在项目中新建对话',
    'Conversation History': '对话历史',
    'Open Conversation History': '打开对话历史',
    'Open Conversation Picker': '打开对话选择面板',
    'Open Conversation': '打开对话',
    'Select Next Conversation': '选择下一个对话',
    'Select Previous Conversation': '选择上一个对话',
    'Conversation Name': '对话名称',
    'Conversation name': '对话名称',
    'Conversation ID': '对话 ID',
    'Conversation unavailable': '对话不可用',
    'Conversation Archived': '对话已归档',
    'Sidebar grouped by project': '侧边栏按项目分组',
    'Sidebar grouped by workspace': '侧边栏按工作区分组',
    'Updated sidebar grouping': '已更新侧边栏分组',
    'Updates to your sidebar': '侧边栏更新',
    'No conversations yet': '暂无对话',
    'No more older messages': '没有更早的消息了',
    'Queued Messages': '排队消息',

    // ----- Composer / chat ---------------------------------------------------
    'Ask anything, @ to mention, / for actions': '输入任何内容，用 @ 提及，/ 执行操作',
    'Add Context': '添加上下文',
    'Add to Chat': '添加到对话',
    'Add screenshot to conversation': '向对话添加截图',
    'Mention Page': '提及页面',
    'Mentions': '提及',
    'Send Now': '立即发送',
    'Cancel Sending Message': '取消发送消息',
    'Cancel Generation': '取消生成',
    'Cancel All Tasks': '取消所有任务',
    'Cancel Task': '取消任务',
    'Cancel Step': '取消步骤',
    'Stop': '停止',
    'Stop All Subagents': '停止所有子智能体',
    'Stop Subagent': '停止子智能体',
    'Continue Response': '继续生成',
    'Retry': '重试',
    'Try Again': '重试',
    'Thinking': '思考中',
    'Plan': '计划',
    'Turbo': '极速',
    'Planning': '规划',
    'Fast': '快速',
    'High': '高',
    'Medium': '中',
    'Low': '低',
    'Gemini Models': 'Gemini 系列模型',
    'Gemini Model': 'Gemini 模型',
    'Claude and GPT models': 'Claude 与 GPT 模型',
    'Select Model': '选择模型',
    'Select another model': '选择其他模型',
    'Select Model to Send Message': '选择模型后发送消息',
    'No Model Selected': '未选择模型',
    'No Models Available': '暂无可用模型',
    'Edit Model': '编辑模型',
    'Add Model': '添加模型',
    'Error Loading Models': '加载模型失败',
    'Toggle Model Selector': '切换模型选择器',
    'Local Checkout': '本地检出',
    'Ask a quick question without interrupting the main conversation.': '在不打断主对话的情况下快速提问。',
    'Good Response': '回答不错',
    'Bad Response': '回答不佳',
    'Copy Message': '复制消息',
    'Quote Selection': '引用选中内容',
    'Comment on Selection': '对选中内容批注',
    'Add inline comment': '添加行内批注',
    'Undo to Here': '撤销到此处',
    'Revert file changes': '还原文件更改',
    'Files Changed': '已更改文件',
    'Modified Files': '已修改文件',
    'Changes': '更改',
    'Review': '审核',
    'Accept Step': '接受步骤',
    'Reject Step': '拒绝步骤',
    'Confirm Undo': '确认撤销',
    'Undo': '撤销',
    'Discard': '放弃',
    'Conversation copied as Markdown to clipboard': '对话已以 Markdown 复制到剪贴板',
    'Input required': '需要输入',
    'Action required': '需要操作',
    'Agent terminated due to error': '智能体因错误终止',
    'Failed to stop agent': '停止智能体失败',
    'Failed to continue': '继续生成失败',
    'Failed to start conversation': '启动对话失败',
    'Failed to rename conversation': '重命名对话失败',
    'Failed to delete conversation': '删除对话失败',
    'Failed to fork conversation': '分叉对话失败',
    'Failed to revert conversation': '还原对话失败',
    'The conversation could not be loaded because its data was not found.': '对话数据未找到，无法加载。',
    'The conversation was compacted while generating this response.': '本次响应生成期间对话已被压缩。',
    'This conversation is not on disk. Delete it to remove it from your sidebar.': '此对话不在磁盘上，删除后将移出侧边栏。',
    'Manage your conversations from the companion website.': '在配套网站中管理您的对话。',
    'No more older messages, showing': '没有更早的消息了',

    // ----- Right pane: artifacts / editor / terminal ------------------------
    'Artifact': '制品',
    'Artifacts': '制品',
    'Implementation Plan': '实施计划',
    'Walkthrough': '演练总结',
    'Task': '任务清单',
    'Scratchpad': '草稿板',
    'Overview': '总览',
    'Review plans and walkthroughs': '审核计划与演练总结',
    'Review pending conversations': '审核待处理对话',
    'Proceed': '批准执行',
    'Proceed Anyway': '仍然继续',
    'Proceed with Plan': '按计划执行',
    'Request Review': '请求审核',
    'Review Policy': '审核策略',
    'Plan Review Policy': '计划审核策略',
    'Open File': '打开文件',
    'Open Folder': '打开文件夹',
    'Open Folder (Interactive)': '打开文件夹（交互）',
    'Open in New Window': '在新窗口打开',
    'Open in new tab': '在新标签页打开',
    'Open in Side Panel': '在侧边面板打开',
    'Open in side pane': '在侧边面板打开',
    'Open in Built-in Browser': '在内置浏览器打开',
    'Open in External Browser': '在外部浏览器打开',
    'Open in external browser': '在外部浏览器打开',
    'Open Link in External Browser': '在外部浏览器打开链接',
    'Open Link in New Tab': '在新标签页打开链接',
    'Open in Antigravity IDE': '在 Antigravity IDE 中打开',
    'Open in': '打开方式',
    'Open Links In': '链接打开方式',
    'Copy': '复制',
    'Copy Image': '复制图片',
    'Copy Image Address': '复制图片地址',
    'Copy Link': '复制链接',
    'Copy Link Address': '复制链接地址',
    'Copy Path': '复制路径',
    'Copy path': '复制路径',
    'Copy File Path': '复制文件路径',
    'Copy File Name': '复制文件名',
    'Copy Content': '复制内容',
    'Copy command': '复制命令',
    'Copy Config File Path': '复制配置文件路径',
    'Copy Conversation ID': '复制对话 ID',
    'Copy Conversation Markdown': '复制对话 Markdown',
    'Copy full URL to clipboard': '复制完整 URL',
    'Copy debug info': '复制调试信息',
    'Copy Trajectory ID': '复制轨迹 ID',
    'Copied': '已复制',
    'Paste': '粘贴',
    'Cut': '剪切',
    'Select All': '全选',
    'Export': '导出',
    'Export as PDF': '导出为 PDF',
    'Download': '下载',
    'Download PDF': '下载 PDF',
    'Download SVG': '下载 SVG',
    'Download File': '下载文件',
    'Print': '打印',
    'Close Tab': '关闭标签页',
    'Close Other Tabs': '关闭其他标签页',
    'Close Tabs to the Right': '关闭右侧标签页',
    'Reopen Closed Tab': '重新打开已关闭标签页',
    'New Tab': '新建标签页',
    'Next Aux Pane Tab': '下一个辅助标签页',
    'Previous Aux Pane Tab': '上一个辅助标签页',
    'Toggle Maximize Auxiliary Pane': '切换最大化辅助面板',
    'Toggle File Viewer': '切换文件查看器',
    'Close Panel': '关闭面板',
    'Close Settings': '关闭设置',
    'Fit Mode': '适应模式',
    'Full View': '完整视图',
    'Raw': '原始',
    'Preview': '预览',
    'Thumbnails': '缩略图',
    'Toggle Thumbnails': '切换缩略图',
    'Mermaid diagram': 'Mermaid 图表',
    'Enlarged Mermaid diagram': '放大的 Mermaid 图表',
    'Failed to render diagram': '图表渲染失败',
    'Failed to render math': '公式渲染失败',
    'Binary file not shown': '二进制文件未显示',
    'Preview is not available for this file type.': '此文件类型不支持预览。',
    'Artifact updated by agent': '智能体已更新文档',
    'Terminal': '终端',
    'Terminals': '终端',
    'New Terminal': '新建终端',
    'New Terminal Tab': '新建终端标签页',
    'Close Terminal Tab': '关闭终端标签页',
    'Kill Terminal': '终止终端',
    'Insert in Terminal': '在终端中插入',
    'Terminal: Add to Chat': '终端：添加到对话',
    'Standalone Terminals': '独立终端',
    'Background Task Output': '后台任务输出',
    'Background Commands': '后台命令',
    'Background Tasks': '后台任务',
    'Extensions': '扩展面板',
    'Extension': '扩展',
    'UI Extensions': 'UI 扩展',
    'Find in Pane': '在面板中查找',
    'Find in Conversation': '在对话中查找',
    'Find': '查找',
    'Next Match (Enter)': '下一个匹配 (Enter)',
    'Previous Match (Shift+Enter)': '上一个匹配 (Shift+Enter)',
    'Match Case (Aa)': '区分大小写 (Aa)',
    'Use Regular Expression (.*)': '使用正则表达式 (.*)',
    'Search': '搜索',
    'Clear Search': '清除搜索',
    'Search across files...': '跨文件搜索...',
    'Search file contents...': '搜索文件内容...',
    'Search for commands...': '搜索命令...',
    'File explorer': '文件浏览器',
    'Recent files': '最近文件',
    'Recent Files': '最近文件',
    'Folders': '文件夹',
    'Folder': '文件夹',
    'Files': '文件',
    'Documents': '文档',
    'Output': '输出',

    // ----- Customizations / plugins / skills / MCP / hooks ------------------
    'Plugins': '插件',
    'Plugin': '插件',
    'Skills': '技能',
    'Skill': '技能',
    'Rules': '规则',
    'Skills & Rules': '技能与规则',
    'MCP': 'MCP',
    'MCP Servers': 'MCP 服务器',
    'MCP servers': 'MCP 服务器',
    'MCP Tools': 'MCP 工具',
    'MCP tools': 'MCP 工具',
    'Installed': '已安装',
    'Enabled': '已启用',
    'Disabled': '已禁用',
    'Browse Marketplace': '浏览市场',
    'Browse the Marketplace': '浏览市场',
    'Marketplace': '插件市场',
    'Explore the plugin marketplace': '探索插件市场',
    'Build With Google Plugins': '使用 Google 官方插件构建',
    'Browse and enable plugins from the Build With Google catalog.': '从 Build With Google 目录浏览并启用插件。',
    'Install': '安装',
    'Uninstall': '卸载',
    'Enable': '启用',
    'Disable': '禁用',
    'Remove': '移除',
    'Configure': '配置',
    'No plugins available.': '暂无可用插件。',
    'No plugin loads from this folder.': '此文件夹未加载任何插件。',
    'No customizations found': '未找到自定义配置',
    'Installed MCP Servers': '已安装的 MCP 服务器',
    'Add MCP': '添加 MCP',
    'Add MCP Server': '添加 MCP 服务器',
    'Add MCP Servers': '添加 MCP 服务器',
    'Delete MCP Server': '删除 MCP 服务器',
    'Open MCP Config': '打开 MCP 配置',
    'Refresh MCP servers': '刷新 MCP 服务器',
    'Refresh Skills': '刷新技能',
    'Installed Skills': '已安装技能',
    'Active Skills': '启用中的技能',
    'Delete Skill': '删除技能',
    'Customize Global Skills': '自定义全局技能',
    'Discover helpful skills & plugins': '发现实用技能与插件',
    'Currently installed': '当前已安装',
    'Token Usage': 'Token 用量',
    'Customize': '自定义',
    'Configure default behaviors, skills, and MCP servers.': '配置默认行为、技能与 MCP 服务器。',
    'Configure external tools via Model Context Protocol.': '通过模型上下文协议配置外部工具。',
    'External tools the agent can call via Model Context Protocol.': '智能体可通过模型上下文协议调用的外部工具。',
    'Configure hooks that run on agent lifecycle events.': '配置在智能体生命周期事件中运行的钩子。',
    'Hooks': '钩子',
    'Manage Hooks': '管理钩子',
    'Add Hook Card': '添加钩子',
    'Delete Hook': '删除钩子',
    'Add Handler': '添加处理器',
    'Delete Handler': '删除处理器',
    'New hook name': '新钩子名称',
    'Comments': '批注',
    'Context Providers': '上下文提供者',
    'Context Menus': '右键菜单',
    'Custom Context Menus': '自定义右键菜单',
    'At Mention Code Block': '提及代码块',
    'Getting scripts...': '正在获取脚本...',
    'Plugin Operation Error:': '插件操作错误：',
    'MCP Configuration Error:': 'MCP 配置错误：',
    'MCP Authentication Error:': 'MCP 认证错误：',
    'MCP Install Error:': 'MCP 安装错误：',
    'MCP Restart Error:': 'MCP 重启错误：',
    'Error fetching MCP prompt': '获取 MCP 提示失败',
    'Search MCP servers by name': '按名称搜索 MCP 服务器',
    'Create a Plugin with the Agent': '让智能体创建插件',
    'New Agent Script': '新建智能体脚本',
    'UI extensions': 'UI 扩展',

    // ----- Automations / scheduling ----------------------------------------
    'Create Automation': '新建自动化',
    'Run Now': '立即运行',
    'Schedule': '调度',
    'Scheduled Tasks': '计划任务',
    'Triggers': '触发器',
    'Logs': '日志',
    'Active': '活跃',
    'Paused': '已暂停',
    'Pending': '待处理',
    'Running': '运行中',
    'Stopped': '已停止',
    'Idle': '空闲',
    'Ready': '就绪',
    'Daily': '每天',
    'Weekly': '每周',
    'Hourly': '每小时',
    'Prompt to execute on schedule...': '按计划执行的提示词...',
    'Prompt to run when triggered...': '触发时运行的提示词...',
    'Next question': '下一个问题',
    'Previous question': '上一个问题',
    'Skip': '跳过',
    'The current trigger rate is too high.': '当前触发频率过高。',
    'Refreshed credentials for all automations.': '已刷新所有自动化凭据。',
    'Refresh gcert Credentials': '刷新凭据',
    'Send Feedback': '发送反馈',
    'Subagents': '子智能体',
    'Subagent': '子智能体',
    'Subagent ended': '子智能体已结束',
    'Agent Host Address': '智能体主机地址',

    // ----- Settings: general / appearance / app / editor --------------------
    'General': '常规',
    'App': '应用',
    'Application': '应用',
    'App Settings': '应用设置',
    'Show All': '显示全部',
    'Give Feedback': '提供反馈',
    'Add Folder': '添加文件夹',
    'Manage project folders, agent settings, and permissions.': '管理项目文件夹、智能体设置与权限。',
    'Also includes global limits when working in this project. Learn more.': '包含在该项目中工作时的全局限制。了解更多。',
    'Permission Presets': '权限预设',
    'Control the actions agents can take.': '控制智能体可以执行的操作。',
    'File Access Rules': '文件访问规则',
    'Configure which file paths agents may read and write.': '配置允许智能体读写哪些文件路径。',
    'Network Access Rules': '网络访问规则',
    'Configure which URLs agents may read and write.': '配置允许智能体访问哪些 URL。',
    'Terminal Commands': '终端命令',
    'Configure which terminal commands agents may run.': '配置允许智能体运行哪些终端命令。',
    'MCP Tools': 'MCP 工具',
    'Configure external tools via the Model Context Protocol.': '通过模型上下文协议配置外部工具。',
    'Agent Behavior': '智能体行为',
    'Plan review policy': '计划审核策略',
    'Plan Review Policy': '计划审核策略',
    'Whether the agent asks you to review its plans.': '智能体是否请求您审核其计划。',
    'Always Proceed': '始终自动执行',
    'Folders': '文件夹',
    'Open': '打开',
    'Open File': '打开文件',
    'Open Folder': '打开文件夹',
    'New Folder': '新建文件夹',
    'Rename': '重命名',
    'Delete': '删除',
    'Archive': '归档',
    'Unarchive': '取消归档',
    'Pin': '置顶',
    'Unpin': '取消置顶',
    'Duplicate': '复制到',
    'Appearance': '外观',
    'Editor': '编辑器',
    'Browser': '浏览器',
    'Models': '模型',
    'Model': '模型',
    'Account': '账户',
    'Accounts': '账户',
    'Accounts tab': '账户标签',
    'Permissions': '权限',
    'Notifications': '通知',
    'Shortcuts': '快捷键',
    'Advanced': '高级',
    'Advanced Settings': '高级设置',
    'Provide Feedback': '提供反馈',
    'Back': '返回',
    'Go Back': '返回',
    'Go Forward': '前进',
    'Search settings': '搜索设置',
    'Search settings...': '搜索设置...',
    'Manage your plan, credentials, and general preferences.': '管理您的套餐、凭据与常规偏好设置。',
    'Enable Telemetry': '启用遥测',
    'Telemetry': '遥测',
    'Marketing Emails': '营销邮件',
    'Theme': '主题',
    'Themes': '主题',
    'Light': '浅色',
    'Dark': '深色',
    'System': '跟随系统',
    'System default': '系统默认',
    'Light Theme': '浅色主题',
    'Dark Theme': '深色主题',
    'Light preview': '浅色预览',
    'Dark preview': '深色预览',
    'Accent': '强调色',
    'Background': '背景',
    'Foreground': '前景',
    'Contrast': '对比度',
    'Preset': '预设',
    'Font': '字体',
    'Sound': '声音',
    'Volume': '音量',
    'Voice': '语音',
    'Microphone': '麦克风',
    'Chat Settings': '对话设置',
    'Verbose Agent Chat': '详细智能体对话',
    'Display and preserve intermediate thinking steps.': '显示并保留中间思考步骤。',
    'Prevent Sleep': '阻止休眠',
    'Prevent the computer from sleeping while the app is running.': '应用运行时阻止电脑休眠。',
    'Keep In Menu Bar': '在菜单栏中保持运行',
    'Enable Notifications': '启用通知',
    'Notification Preferences': '通知偏好',
    'Manage your notification preferences.': '管理您的通知偏好设置。',
    'Display Options': '显示选项',
    'Danger Zone': '危险区域',
    'Reset All to Defaults': '全部恢复默认',
    'Reset to Default': '恢复默认',
    'Reset State': '重置状态',
    'Keyboard Shortcuts': '键盘快捷键',
    'Open Keyboard Shortcuts': '打开键盘快捷键',
    'Add Shortcut': '添加快捷键',
    'Edit Shortcut': '编辑快捷键',
    'Remove Shortcut': '移除快捷键',
    'Recommended': '推荐',
    'Navigation': '导航',
    'Layout Controls': '布局控制',
    'Open Settings': '打开设置',
    'Open Preferences': '打开偏好设置',
    'Open System Preferences': '打开系统偏好设置',
    'Open Editor Settings': '打开编辑器设置',
    'Editor Settings': '编辑器设置',
    'Selection Actions': '选区操作',
    'Marketplace Item URL': '插件市场项 URL',
    'Marketplace Gallery URL': '插件市场搜索源 URL',
    'Open File Search': '打开文件搜索',
    'Focus Input': '聚焦输入框',
    'File Picker': '文件选择器',
    'Toggle Voice Recording': '切换语音录制',
    'Start Voice Recording': '开始语音录制',
    'Stop Voice Recording': '停止语音录制',
    'Browser Subagent': '浏览器子智能体',
    'Browser Javascript Execution Policy': '浏览器 JavaScript 执行策略',
    'Controls whether the agent can run custom JavaScript to automate complex browser actions.': '控制智能体是否可以运行自定义 JavaScript 以自动化复杂浏览器操作。',
    'Browser Actuation Permissions': '浏览器操纵权限',
    'Browser Actuation Rules': '浏览器操纵规则',
    'Configure allowed and denied URLs for browser actuation.': '配置浏览器操纵允许与拒绝的 URL。',
    'Browser CDP Port': '浏览器 CDP 端口',
    'Chrome Binary Path': 'Chrome 可执行文件路径',
    'Browser User Profile Path': '浏览器用户配置路径',

    // ----- Permissions / sandbox / agent behaviour --------------------------
    'Permission Settings': '权限设置',
    'Permission Preset': '权限预设',
    'Permission Details': '权限详情',
    'Security Preset': '安全预设',
    'Agent Settings': '智能体设置',
    'Agent Behavior': '智能体行为',
    'Agent Edits': '智能体编辑',
    'Local Permissions': '本地权限',
    'Global Permissions': '全局权限',
    'File Permissions': '文件权限',
    'Network Permissions': '网络权限',
    'Terminal & Tooling Permissions': '终端与工具权限',
    'File Access Rules': '文件访问规则',
    'Network Access Rules': '网络访问规则',
    'Terminal Commands': '终端命令',
    'Commands Outside Sandbox': '沙箱外命令',
    'Allow List Terminal Commands': '终端命令允许列表',
    'Deny List Terminal Commands': '终端命令拒绝列表',
    'Terminal Command Auto Execution': '终端命令自动执行',
    'Outside of folders file access policy': '文件夹外文件访问策略',
    'Tool Permissions': '工具权限',
    'Allow': '允许',
    'Deny': '拒绝',
    'Always Allow': '始终允许',
    'Allow Once': '仅允许一次',
    'Ask': '询问',
    'Always Ask': '始终询问',
    'Always Proceed': '始终自动执行',
    'Require Review': '需人工确认',
    'Proceed In Sandbox': '沙盒内自动执行',
    'Auto': '智能自动',
    'Auto (Preview)': '智能自动（预览）',
    'Auto (detected)': '自动（已检测）',
    'Custom': '自定义',
    'Default': '默认',
    'Unrestricted': '无限制',
    'Full Machine': '整机访问',
    'Sandbox': '沙箱',
    'Enable Sandbox Mode (Preview)': '启用沙箱模式（预览）',
    'Restricts agent tools to a secure, isolated local sandbox.': '将智能体工具限制在安全隔离的本地沙箱中。',
    'Ask before sensitive operations.': '敏感操作前询问。',
    'Run all commands without restrictions.': '无限制运行所有命令。',
    'Every command requires approval.': '每条命令都需要批准。',
    'Automatically decide if commands run.': '自动决定命令是否执行。',
    'Agent always asks for review.': '智能体始终请求审核。',
    'Whether the agent asks you to review its documents.': '智能体是否请求您审核其文档。',
    'Configure allowed and denied paths for file reads and writes.': '配置允许与拒绝读写的文件路径。',
    'Configure allowed and denied URLs for reading.': '配置允许与拒绝读取的 URL。',
    'Configure allowed terminal commands.': '配置允许的终端命令。',
    'Configure allowed commands outside the sandbox.': '配置沙箱外允许执行的命令。',
    'Configures how the agent tries to access files outside of its working folders.': '配置智能体访问工作文件夹外部文件的方式。',
    'Controls whether terminal commands require your approval before running.': '控制终端命令运行前是否需要您的批准。',
    'Configure when follow-up messages are sent.': '配置后续消息的发送时机。',
    'Configure agent execution, queued message delivery, and permissions.': '配置智能体执行、排队消息投递与权限。',
    'Configure workspace-specific permissions, resources, and customizations.': '配置工作区专属的权限、资源与自定义项。',
    'Configure the agent visual theme and display preferences.': '配置智能体的视觉主题与显示偏好。',
    'Configure the maximum width of the conversation panel.': '配置对话面板的最大宽度。',
    'Configure the default width of markdown artifacts.': '配置 Markdown 制品的默认宽度。',
    'Markdown Artifact Width': 'Markdown 制品宽度',
    'Conversation Width': '对话宽度',
    'Agent Non-Workspace File Access': '智能体工作区外文件访问',
    'Execution': '执行',
    'Commands and files these agents can use.': '这些智能体可使用的命令与文件。',
    'Controls the actions the agent can take.': '控制智能体可执行的操作。',
    'Folders these agents can access.': '这些智能体可访问的文件夹。',
    'File Reads': '文件读取',
    'File Writes': '文件写入',
    'Read files': '读取文件',
    'Write files': '写入文件',
    'Read URLs': '读取 URL',

    // ----- Account / auth / onboarding --------------------------------------
    'Sign Out': '退出登录',
    'Sign in required.': '需要登录。',
    'Sign in needed': '需要登录',
    'Not Signed In': '未登录',
    'Unauthenticated': '未认证',
    'Authenticating...': '正在认证...',
    'Authentication expired': '认证已过期',
    'Log back in': '重新登录',
    'Log in to use the agent': '登录后使用智能体',
    'To use the agent, please login': '使用智能体前请先登录',
    'Continue with Google': '使用 Google 继续',
    'Continue with Google Cloud': '使用 Google Cloud 继续',
    'Continue with different account': '使用其他账户继续',
    'Sign in with a different account': '使用其他账户登录',
    'Account connected.': '账户已连接。',
    'Connect': '连接',
    'Disconnect': '断开连接',
    'Connected': '已连接',
    'Disconnected': '已断开',
    'Email': '邮箱',
    'Website': '网站',
    'Your session has expired. Please log back in to continue.': '会话已过期，请重新登录以继续。',
    'Having trouble signing in?': '登录遇到问题？',
    'Complete verification': '完成验证',
    'Verification required': '需要验证',
    'Setup required': '需要完成设置',
    'Complete Setup': '完成设置',
    'Setup': '设置',
    'Use Existing': '使用现有',
    'Get Started': '开始体验',
    'Get started': '开始使用',
    'Welcome': '欢迎',
    'Sign In': '登录',
    'Sign in required': '需要登录',

    // ----- Feedback ----------------------------------------------------------
    'Feedback Type': '反馈类型',
    'Bug Report': '故障报告',
    'Feature Request': '功能建议',
    'General Feedback': '常规反馈',
    'Auth and Billing': '认证与计费',
    'Description': '描述',
    'Steps to Reproduce': '复现步骤',
    'Please list the steps to reproduce the issue': '请列出复现该问题的步骤',
    'Send feedback as': '反馈发送账户',
    'Submit': '提交',
    'Attach Antigravity server logs': '附带 Antigravity 服务器日志',
    'Thank you! Your feedback has been submitted successfully.': '感谢！您的反馈已成功提交。',
    'An error occurred while submitting your feedback. Please try again.': '提交反馈时出错，请重试。',
    'Expected behavior': '预期行为',
    'Actual behavior': '实际行为',
    'Steps to reproduce the issue': '复现问题的步骤',

    // ----- Status / common controls -----------------------------------------
    'Error': '错误',
    'Warning': '警告',
    'Success': '成功',
    'Failed': '失败',
    'Unknown': '未知',
    'Unknown error': '未知错误',
    'Done': '完成',
    'Got it': '知道了',
    'Dismiss': '忽略',
    'Dismiss service announcement': '关闭服务公告',
    'Refresh': '刷新',
    'Refresh quota and credits data': '刷新配额与积分数据',
    'Loading...': '加载中...',
    'Loading apps...': '正在加载应用...',
    'Loading installed plugins...': '正在加载已安装插件...',
    'Loading subagent...': '正在加载子智能体...',
    'Offline': '离线',
    'Online': '在线',
    'More': '更多',
    'More actions': '更多操作',
    'More Actions': '更多操作',
    'Actions': '操作',
    'Details': '详情',
    'Options': '选项',
    'Learn more': '了解更多',
    'learn more': '了解更多',
    'Next': '下一个',
    'Previous': '上一个',
    'Finish': '完成',
    'Continue': '继续',
    'Select': '选择',
    'Open': '打开',
    'Save': '保存',
    'Apply': '应用',
    'Accept': '接受',
    'Decline': '拒绝',
    'Create': '创建',
    'Add': '添加',
    'Confirm': '确认',
    'Cancel': '取消',
    'Update': '更新',
    'Upgrade': '升级',
    'Quota': '配额',
    'Usage': '用量',
    'Limit': '限额',
    'Remaining': '剩余',
    'Refreshes': '刷新',
    'Exceeded': '已超额',
    'Credits': '积分',
    'Model Credits': '模型积分',
    'Model Quota': '模型配额',
    'Manage your model quota and credits.': '管理您的模型配额与积分。',
    'Enable AI Credit Overages': '启用 AI 积分透支',
    'Purchase Credits': '购买积分',
    'Get More AI Credits': '获取更多 AI 积分',
    'AI Credits Used to Generate Response': '生成本次响应消耗的 AI 积分',
    'Insufficient AI Credits': 'AI 积分不足',
    'Model quota reached': '模型配额已用尽',
    'Baseline model quota reached': '基础模型配额已用尽',
    'New models have been enabled for you!': '已为您启用新模型！',
    'See Activity': '查看消费明细',
    'Available AI Credits': '可用 AI 积分',
    'Pay As You Go': '按量付费',
    'Pro': '专业版',
    'Enterprise': '企业版',

    // ----- Git / workspace plumbing (right pane + status) -------------------
    'Select branch': '选择分支',
    'Branch': '分支',
    'Commit': '提交',
    'Push': '推送',
    'Commit succeeded': '提交成功',
    'Push succeeded': '推送成功',
    'Failed to Commit': '提交失败',
    'Failed to Push': '推送失败',
    'Staged Changes': '已暂存更改',
    'Uncommitted': '未提交',
    'Modified': '已修改',
    'Untracked (Unstaged)': '未跟踪（未暂存）',
    'Added (Staged)': '已添加（已暂存）',
    'Stage change': '暂存更改',
    'Unstage change': '取消暂存',
    'Discard unstaged changes': '放弃未暂存更改',
    'Include unstaged changes': '包含未暂存更改',
    'Branch Changes': '分支更改',
    'Manifest Changes': '清单更改',
    'Files modified by the agent in this conversation': '本对话中智能体修改的文件',
    'Workspace CL Status': '工作区 CL 状态',
    'Search GoB repositories...': '搜索 GoB 仓库...',
    'Select or enter a workspace URI': '选择或输入工作区 URI',
    'Workspace URI query parameter': '工作区 URI 查询参数',
    'Create New': '新建',
    'Upload Files': '上传文件',
    'Uploads': '上传',
    'Download Diagnostics': '下载诊断',
    'Upload Debug Bundle': '上传调试包',
    'Capture Screenshot': '截取屏幕',
    'Screen Recording': '屏幕录制',
    'Developer': '开发者',
    'Labs': '实验室'
  };

  // Fixed GitHub-alert labels, only translated inside `.markdown-alert-title`.
  var ALERT_LABELS = {
    'NOTE': '说明',
    'TIP': '技巧',
    'IMPORTANT': '重要',
    'WARNING': '警告',
    'CAUTION': '注意'
  };

  // Dynamic template rules (counts, durations, quota resets). Ordered: specific first.
  var RULES = [
    [/^See all \((\d+)\)$/i, '查看全部 ($1)'],
    [/^See less$/i, '收起'],
    [/^Skills \((\d+)\)$/i, '技能 ($1)'],
    [/^File Access Rules \((\d+)\)$/i, '文件访问规则 ($1)'],
    [/^Terminal Commands \((\d+)\)$/i, '终端命令 ($1)'],
    [/^Commands Outside Sandbox \((\d+)\)$/i, '沙箱外命令 ($1)'],
    [/^Plugin:\s*(.+)$/i, '插件: $1'],
    [/^Learn more about\s+(.+?)\.?$/i, '了解关于 $1 的更多信息'],
    [/^([\d.]+)% of the customization budget is available\.$/i, '当前可用自定义配置 Token 预算为 $1%。'],
    [/^No more older messages, showing (\d+) of (\d+)$/i, '没有更早的消息了，已显示 $1 / $2'],
    [/^Thought for (\d+)s$/i, '思考了 $1 秒'],
    [/^Thought for (\d+)m$/i, '思考了 $1 分钟'],
    [/^Thought for (\d+)h$/i, '思考了 $1 小时'],
    [/^Worked for (\d+)s$/i, '已运行 $1 秒'],
    [/^Worked for (\d+)m$/i, '已运行 $1 分钟'],
    [/^Worked for (\d+)h\s*(\d+)m$/i, '已运行 $1 小时 $2 分钟'],
    [/^Worked for (\d+)h$/i, '已运行 $1 小时'],
    [/^Worked for (\d+)m\s*(\d+)s$/i, '已运行 $1 分钟 $2 秒'],
    [/^Resets in (\d+)h\s*(\d+)m$/i, '重置剩余：$1 小时 $2 分钟'],
    [/^Resets in (\d+)h$/i, '重置剩余：$1 小时'],
    [/^Resets in (\d+)m$/i, '重置剩余：$1 分钟'],
    [/^Refreshes in (\d+) hours?, (\d+) minutes$/i, '套餐配额重置剩余：$1 小时 $2 分钟'],
    [/^Refreshes in (\d+) hours?$/i, '套餐配额重置剩余：$1 小时'],
    [/^Refreshes in (\d+) minutes$/i, '套餐配额重置剩余：$1 分钟'],
    [/^Available AI Credits:\s*([\d,k.]+)$/i, '可用 AI 积分额度: $1'],
    [/^Quota resets soon$/i, '配额即将重置'],
    [/^Turn (\d+) of (\d+)$/i, '第 $1 轮，共 $2 轮'],
    [/^Step (\d+) of (\d+)$/i, '第 $1 步，共 $2 步'],
    [/^(\d+) files?$/i, '$1 个文件'],
    [/^(\d+) results?$/i, '$1 条结果'],
    [/^(\d+) selected$/i, '已选择 $1 项'],
    [/^(\d+) of (\d+)$/i, '$1 / $2'],
    [/^just now$/i, '刚刚'],
    [/^yesterday$/i, '昨天'],
    [/^(\d+)([smhd]) ago$/i, function (m, n, u) {
      var unit = { s: ' 秒', m: ' 分钟', h: ' 小时', d: ' 天' }[String(u).toLowerCase()] || '';
      return n + unit + '前';
    }],
    [/^(\d+)\s*(?:mins?|minutes?)\s*ago$/i, '$1 分钟前'],
    [/^(\d+)\s*(?:hrs?|hours?)\s*ago$/i, '$1 小时前'],
    [/^(\d+)\s*(?:days?)\s*ago$/i, '$1 天前'],
    [/^(\d+)% used$/i, '已使用 $1%'],
    [/^(\d+)% remaining$/i, '剩余 $1%']
  ];

  // ---------------------------------------------------------------------------
  // 2. Indexes
  // ---------------------------------------------------------------------------
  var NORM_DICT = new Map();
  var EN_BY_ZH = new Map();
  Object.keys(DICT).forEach(function (key) {
    var norm = key.replace(/[\s\u00a0]+/g, ' ').trim();
    if (!norm) return;
    if (!NORM_DICT.has(norm)) NORM_DICT.set(norm, DICT[key]);
    if (!EN_BY_ZH.has(DICT[key])) EN_BY_ZH.set(DICT[key], key);
  });
  var DICT_SIZE = NORM_DICT.size;

  // ---------------------------------------------------------------------------
  // 3. State
  // ---------------------------------------------------------------------------
  function normalizeLang(value) {
    if (!value) return null;
    var v = String(value).trim().toLowerCase();
    if (v === 'zh' || v === 'zh-cn' || v === 'zh_cn' || v === 'cn') return 'zh-CN';
    if (v === 'en' || v === 'en-us' || v === 'en_us' || v === 'english') return 'en';
    return null;
  }

  var state = {
    lang: normalizeLang(CONFIG.language) || 'zh-CN',
    running: false,
    observer: null,
    rafId: 0,
    fallbackId: 0,
    rootQueue: new Set(),
    nodeQueue: new Set(),
    batches: 0,
    lastApplyMs: 0,
    lastSwitchMs: 0
  };

  var textOrig = new WeakMap();  // Text -> { orig: string, zh: string }
  var liveTexts = new Set();     // strong refs only while translated; pruned when disconnected
  var attrRecs = new WeakMap();  // Element -> { placeholder?: {orig,zh}, title?: {orig,zh} }
  var liveAttrEls = new Set();

  var ATTRS = ['placeholder', 'title'];
  var ORIG_ATTR = { placeholder: 'data-ag-orig-placeholder', title: 'data-ag-orig-title' };

  // ---------------------------------------------------------------------------
  // 4. Exclusions
  // ---------------------------------------------------------------------------
  var SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'svg', 'canvas', 'code', 'pre', 'kbd', 'samp', 'textarea',
    '.monaco-editor', '.view-lines', '.xterm', '.xterm-screen', '.cm-editor',
    '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[contenteditable=""]',
    '#ag-telemetry-bar', '#ag-telemetry-popover', '#ag-task-bar', '#ag-quick-goal', '#ag-ambient-clock'
  ].join(',');

  var USER_CONTENT_SELECTOR = [
    '[data-testid="user-message-bubble"]',
    '[data-testid="user-input-step"]',
    '[data-testid="planner-response-text"]',
    '[data-testid="commentable-content"]',
    '[data-testid="conversation-navigator-turn"]'
  ].join(',');

  var SIDEBAR_ALLOW = new RegExp(
    '^(?:See all \\(\\d+\\)|See less|New Conversation|Project options|' +
    'just now|yesterday|\\d+[smhd](?: ago)?|' +
    '\\d+\\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|years?)(?: ago)?)$',
    'i'
  );

  function sidebarAllowed(core) {
    return SIDEBAR_ALLOW.test(core.replace(/[\s\u00a0]+/g, ' ').trim());
  }

  /**
   * True when this element is a hard no-translate zone.
   * @param {Element} el
   * @param {string} core normalized candidate text
   */
  function isProtected(el, core) {
    if (!el || !el.closest) return true;
    if (el.closest(SKIP_SELECTOR)) return true;

    // Markdown documents are off-limits except the five GitHub alert labels.
    // This check must run before the user-content guard: artifacts render
    // `.markdown-alert-title` inside `[data-testid="commentable-content"]`.
    var mdRoot = el.closest('[data-markdown-root]');
    if (mdRoot) {
      var alertTitle = el.closest('.markdown-alert-title');
      if (!alertTitle || !ALERTS_ENABLED) return true;
      return !ALERT_LABELS[String(core).toUpperCase()];
    }

    if (el.closest(USER_CONTENT_SELECTOR)) return true;

    // Sidebar project folder names and user conversation titles stay untouched,
    // but timestamps / See all (N) / menus inside those rows are allowed.
    if (el.closest('[data-testid="conversation-row-sidebar"]') && !sidebarAllowed(core)) return true;
    if (el.closest('[data-testid="project-header"]') && !sidebarAllowed(core)) return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // 5. Lookup
  // ---------------------------------------------------------------------------
  function lookup(core) {
    if (!core) return null;
    var key = core.replace(/[\s\u00a0]+/g, ' ').trim();
    if (!key || !/[A-Za-z]/.test(key)) return null;

    var direct = NORM_DICT.get(key);
    if (direct) return direct;

    var upper = key.toUpperCase();
    if (ALERT_LABELS[upper] && /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION)$/.test(upper)) {
      return ALERT_LABELS[upper];
    }

    for (var i = 0; i < RULES.length; i += 1) {
      var re = RULES[i][0];
      var to = RULES[i][1];
      if (re.test(key)) {
        re.lastIndex = 0;
        return typeof to === 'function' ? key.replace(re, to) : key.replace(re, to);
      }
    }
    return null;
  }

  function translate(text, lang) {
    if (typeof text !== 'string') return null;
    var target = normalizeLang(lang) || state.lang;
    var raw = String(text);
    if (!raw.trim()) return null;
    if (target === 'en') {
      var en = EN_BY_ZH.get(raw.trim());
      return en || null;
    }
    return lookup(raw);
  }

  // ---------------------------------------------------------------------------
  // 6. Text node translation (WeakMap snapshot)
  // ---------------------------------------------------------------------------
  function splitWhitespace(value) {
    var m = /^([\s\u00a0]*)([\s\S]*?)([\s\u00a0]*)$/.exec(value);
    if (!m) return { lead: '', core: value, tail: '' };
    return { lead: m[1], core: m[2], tail: m[3] };
  }

  function processTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    if (state.lang === 'en') {
      restoreTextNode(node);
      return;
    }
    if (!node.isConnected) return;
    var parent = node.parentElement;
    if (!parent) return;

    var raw = node.nodeValue;
    // JSX often wraps labels in newlines/spaces; whitespace is preserved around
    // the translated core instead of rejecting the node outright.
    if (!raw || raw.length > 300) return;

    var parts = splitWhitespace(raw);
    var core = parts.core;
    if (!core || core.length < 2) return;
    if (isProtected(parent, core)) return;

    var rec = textOrig.get(node);
    if (rec && raw === rec.zh) return;

    var orig = (rec && (raw === rec.orig || raw === rec.zh)) ? rec.orig : raw;
    var zh = lookup(core);
    if (!zh) {
      if (rec && raw !== rec.zh) {
        // React replaced a translated node with unstranslatable text: forget the snapshot.
        textOrig.delete(node);
        liveTexts.delete(node);
      }
      return;
    }

    var translated = parts.lead + zh + parts.tail;
    if (translated === raw) return;
    textOrig.set(node, { orig: orig, zh: translated });
    liveTexts.add(node);
    node.nodeValue = translated;
  }

  function restoreTextNode(node) {
    var rec = textOrig.get(node);
    if (!rec) return;
    if (node.isConnected && node.nodeValue === rec.zh && node.nodeValue !== rec.orig) {
      node.nodeValue = rec.orig;
    }
    liveTexts.delete(node);
  }

  // ---------------------------------------------------------------------------
  // 7. Attribute translation (placeholder / title only)
  // ---------------------------------------------------------------------------
  function processAttrs(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return;

    var probe = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (isProtected(el, probe)) return;

    for (var i = 0; i < ATTRS.length; i += 1) {
      var name = ATTRS[i];
      var current = el.getAttribute(name);
      if (current === null) continue;

      var recs = attrRecs.get(el);
      var rec = recs && recs[name];

      if (state.lang === 'en') {
        if (rec) {
          if (current === rec.zh) el.setAttribute(name, rec.orig);
          el.removeAttribute(ORIG_ATTR[name]);
          delete recs[name];
        } else {
          var leftover = el.getAttribute(ORIG_ATTR[name]);
          if (leftover !== null) {
            el.setAttribute(name, leftover);
            el.removeAttribute(ORIG_ATTR[name]);
          }
        }
        continue;
      }

      if (rec && current === rec.zh) continue;

      var original = (rec && current === rec.orig) ? rec.orig : current;
      var zh = lookup(current);
      if (!zh || zh === current) continue;

      if (!recs) {
        recs = {};
        attrRecs.set(el, recs);
      }
      recs[name] = { orig: original, zh: zh };
      liveAttrEls.add(el);
      el.setAttribute(ORIG_ATTR[name], original);
      el.setAttribute(name, zh);
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Tree walking (incremental, subtree only)
  // ---------------------------------------------------------------------------
  function translateAlertTitles(root) {
    var titles = root.querySelectorAll ? root.querySelectorAll('.markdown-alert-title') : [];
    for (var i = 0; i < titles.length; i += 1) {
      if (!ALERTS_ENABLED) return;
      var walker = document.createTreeWalker(titles[i], NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) processTextNode(n);
    }
  }

  function makeFilter() {
    return {
      acceptNode: function (node) {
        if (node.nodeType === 1) {
          if (node.matches(SKIP_SELECTOR) || node.matches(USER_CONTENT_SELECTOR) || node.matches('[data-markdown-root]')) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    };
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      processTextNode(root);
      return;
    }
    if (root.nodeType !== 1 || !root.isConnected) return;

    if (root.matches(SKIP_SELECTOR)) return;
    if (root.matches('[data-markdown-root]')) {
      translateAlertTitles(root);
      return;
    }
    if (root.closest('[data-markdown-root]')) {
      translateAlertTitles(root.closest('[data-markdown-root]'));
      return;
    }
    if (root.matches(USER_CONTENT_SELECTOR)) {
      // Artifacts live under data-testid="commentable-content"; only their
      // alert labels may be translated.
      translateAlertTitles(root);
      return;
    }
    if (root.closest(USER_CONTENT_SELECTOR)) return;

    processAttrs(root);
    translateAlertTitles(root);

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, makeFilter());
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) {
        processAttrs(node);
      } else {
        processTextNode(node);
      }
    }
  }

  function restoreAll() {
    liveTexts.forEach(function (node) {
      restoreTextNode(node);
    });
    liveTexts.clear();

    liveAttrEls.forEach(function (el) {
      if (!el || !el.getAttribute) return;
      var recs = attrRecs.get(el);
      for (var i = 0; i < ATTRS.length; i += 1) {
        var name = ATTRS[i];
        var rec = recs && recs[name];
        if (rec && el.getAttribute(name) === rec.zh) el.setAttribute(name, rec.orig);
        el.removeAttribute(ORIG_ATTR[name]);
      }
    });
    liveAttrEls.clear();

    // Defence in depth: recover any attribute snapshots whose WeakMap record was lost.
    var leftovers = document.querySelectorAll('[data-ag-orig-placeholder], [data-ag-orig-title]');
    for (var j = 0; j < leftovers.length; j += 1) {
      var el = leftovers[j];
      for (var k = 0; k < ATTRS.length; k += 1) {
        var attr = ATTRS[k];
        var orig = el.getAttribute(ORIG_ATTR[attr]);
        if (orig !== null) el.setAttribute(attr, orig);
      }
      el.removeAttribute('data-ag-orig-placeholder');
      el.removeAttribute('data-ag-orig-title');
    }
  }

  // ---------------------------------------------------------------------------
  // 9. Scheduler: MutationObserver + rAF batching (timer fallback for hidden tabs)
  // ---------------------------------------------------------------------------
  function schedule() {
    if (!state.running) return;
    if (!state.rafId && typeof requestAnimationFrame === 'function') {
      state.rafId = requestAnimationFrame(flush);
    }
    if (!state.fallbackId) {
      state.fallbackId = setTimeout(flush, 180);
    }
  }

  function flush() {
    if (state.rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.rafId);
    if (state.fallbackId) clearTimeout(state.fallbackId);
    state.rafId = 0;
    state.fallbackId = 0;
    if (!state.running) return;

    var t0 = performance.now();
    state.batches += 1;

    var nodes = Array.from(state.nodeQueue);
    state.nodeQueue.clear();
    var roots = Array.from(state.rootQueue);
    state.rootQueue.clear();

    for (var i = 0; i < nodes.length; i += 1) processTextNode(nodes[i]);
    for (var j = 0; j < roots.length; j += 1) translateTree(roots[j]);

    if (state.batches % 120 === 0) prune();

    state.lastApplyMs = performance.now() - t0;
  }

  function prune() {
    liveTexts.forEach(function (node) {
      if (!node.isConnected) liveTexts.delete(node);
    });
    liveAttrEls.forEach(function (el) {
      if (!el.isConnected) liveAttrEls.delete(el);
    });
  }

  function onMutations(mutations) {
    if (!state.running || state.lang !== 'zh-CN') return;

    var forceBody = false;
    for (var i = 0; i < mutations.length; i += 1) {
      var m = mutations[i];
      if (m.type === 'childList') {
        for (var a = 0; a < m.addedNodes.length; a += 1) {
          var added = m.addedNodes[a];
          if (added.nodeType === 3) {
            state.nodeQueue.add(added);
          } else if (added.nodeType === 1) {
            if (state.rootQueue.size + state.nodeQueue.size > 400) {
              forceBody = true;
              break;
            }
            state.rootQueue.add(added);
          }
        }
      } else if (m.type === 'characterData') {
        state.nodeQueue.add(m.target);
      } else if (m.type === 'attributes') {
        if (m.attributeName === 'placeholder' || m.attributeName === 'title') {
          state.rootQueue.add(m.target);
        }
      }
      if (forceBody) break;
    }

    if (forceBody) {
      state.rootQueue.clear();
      state.nodeQueue.clear();
      if (document.body) state.rootQueue.add(document.body);
    }

    if (state.rootQueue.size || state.nodeQueue.size) schedule();
  }

  function startObserver() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title']
    });
  }

  // ---------------------------------------------------------------------------
  // 10. Public API
  // ---------------------------------------------------------------------------
  function apply(root) {
    var t0 = performance.now();
    if (state.lang === 'en') {
      restoreAll();
    } else {
      translateTree(root || document.body);
    }
    state.lastApplyMs = performance.now() - t0;
    return state.lang;
  }

  function setLanguage(lang) {
    var next = normalizeLang(lang);
    if (!next) return state.lang;

    var t0 = performance.now();
    state.lang = next;

    if (next === 'en') {
      restoreAll();
    } else {
      if (!state.running) start();
      apply(document.body);
    }

    state.lastSwitchMs = performance.now() - t0;
    return state.lang;
  }

  function start() {
    if (state.running) return true;
    state.running = true;
    startObserver();
    if (state.lang === 'zh-CN' && document.body) translateTree(document.body);
    return true;
  }

  function stop() {
    state.running = false;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.rafId);
    if (state.fallbackId) clearTimeout(state.fallbackId);
    state.rafId = 0;
    state.fallbackId = 0;
    state.rootQueue.clear();
    state.nodeQueue.clear();
    restoreAll();
    return true;
  }

  function stats() {
    var translatedTextNodes = 0;
    liveTexts.forEach(function (node) {
      if (node.isConnected) translatedTextNodes += 1;
    });
    var translatedAttributes = 0;
    liveAttrEls.forEach(function (el) {
      if (el.isConnected) translatedAttributes += 1;
    });
    return {
      version: VERSION,
      language: state.lang,
      running: state.running,
      dictionarySize: DICT_SIZE,
      alertLabels: Object.keys(ALERT_LABELS).length,
      ruleCount: RULES.length,
      translatedTextNodes: translatedTextNodes,
      translatedAttributes: translatedAttributes,
      trackedTextNodes: liveTexts.size,
      observerBatches: state.batches,
      lastApplyMs: Math.round(state.lastApplyMs * 100) / 100,
      lastSwitchMs: Math.round(state.lastSwitchMs * 100) / 100,
      translateAlerts: ALERTS_ENABLED
    };
  }

  var api = {
    version: VERSION,
    setLanguage: setLanguage,
    getLanguage: function () { return state.lang; },
    apply: apply,
    start: start,
    stop: stop,
    stats: stats,
    translate: translate,
    dictionarySize: DICT_SIZE
  };

  window.__agI18n = api;
  window.__agSetLanguage = setLanguage;

  // ---------------------------------------------------------------------------
  // 11. Boot
  // ---------------------------------------------------------------------------
  try {
    state.running = true;
    if (document.body) {
      startObserver();
      if (state.lang === 'zh-CN') translateTree(document.body);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        startObserver();
        if (state.lang === 'zh-CN') translateTree(document.body);
      }, { once: true });
    }
  } catch (error) {
    // Never break the host app because of i18n boot.
    state.running = false;
  }
})();
