/**
 * 统一斜杠命令。三个平台共用一套实现，输出是「纯文本 + 可选菜单结构」，
 * 由各渠道决定渲染成飞书卡片 / QQ 按钮 / 微信数字菜单。
 */

export const COMMANDS = {
  help: { usage: '/help', desc: '指令速查' },
  menu: { usage: '/menu', aliases: ['/m'], desc: '快捷菜单' },
  new: { usage: '/new [标题]', desc: '在默认工作区开新会话' },
  ws: { usage: '/ws [序号]', desc: '查看 / 切换工作区' },
  sessions: { usage: '/sessions', desc: '最近会话列表' },
  session: { usage: '/session <序号|ID>', desc: '接管某个会话' },
  models: { usage: '/models', desc: '查看可选模型' },
  model: { usage: '/model <序号|名称>', desc: '切换模型' },
  status: { usage: '/status', desc: '当前绑定与运行状态' },
  stop: { usage: '/stop', desc: '中止当前生成' },
  steer: { usage: '/steer <指令>', desc: '打断并注入新指令' },
  compact: { usage: '/compact', desc: '压缩上下文' },
  history: { usage: '/history', desc: '最近几轮摘要' },
  repair: { usage: '/repair', desc: '补权限 / 重新校验（飞书）' },
  roam: { usage: '/roam [关键词]', desc: '立即去刷一轮（B站/资料），把精选推给你' },
  read: { usage: '/read <链接>', desc: '深读一个链接（公众号/小红书/B站/网页）' },
  diary: { usage: '/diary', desc: '看它最近的冲浪手记' },
  taste: { usage: '/taste like|dislike|detail [说明]', desc: '校准口味（影响下次选题）' },
};

const ALIAS = new Map();
for (const [name, meta] of Object.entries(COMMANDS)) {
  ALIAS.set(`/${name}`, name);
  for (const alias of meta.aliases || []) ALIAS.set(alias, name);
}

/** 解析 "/model 3" -> { command: 'model', arg: '3' }；非命令返回 null。 */
export function parseCommand(text) {
  const body = String(text || '').trim();
  if (!body.startsWith('/')) return null;
  const [head, ...rest] = body.split(/\s+/);
  const command = ALIAS.get(head.toLowerCase());
  if (!command) return null;
  return { command, arg: rest.join(' ').trim() };
}

export function helpText() {
  const lines = ['可用指令：'];
  for (const [name, meta] of Object.entries(COMMANDS)) {
    lines.push(`  ${meta.usage.padEnd(22)} ${meta.desc}`);
  }
  lines.push('', '直接发消息就是对话；发图片/文件会作为附件投给 Antigravity。');
  return lines.join('\n');
}

export function menuText() {
  return [
    '快捷菜单（回复序号）：',
    '  1. 新建会话',
    '  2. 查看状态',
    '  3. 最近会话',
    '  4. 切换模型',
    '  5. 中止生成',
    '  6. 帮助',
  ].join('\n');
}

const MENU_MAP = { 1: 'new', 2: 'status', 3: 'sessions', 4: 'models', 5: 'stop', 6: 'help' };

/**
 * 执行命令。
 * @returns {Promise<{handled: boolean, reply?: string, action?: string, data?: any}>}
 */
export async function runCommand({ text, ctx }) {
  const parsed = parseCommand(text);
  if (!parsed) {
    const menuPick = MENU_MAP[String(text || '').trim()];
    if (menuPick && ctx.menuArmed) return runCommand({ text: `/${menuPick}`, ctx });
    return { handled: false };
  }

  const { command, arg } = parsed;
  const { workbench, index, state, bot, chatId, harness } = ctx;
  const binding = state.getBinding(bot.id, chatId) || {};

  switch (command) {
    case 'help':
      return { handled: true, reply: helpText() };

    case 'menu':
      ctx.menuArmed = true;
      return { handled: true, reply: menuText(), action: 'menu' };

    case 'status': {
      const conversationId = binding.conversationId || '';
      const info = conversationId ? index.get(conversationId) : null;
      const running = conversationId ? harness.isRunning(conversationId) : false;
      const lines = [
        `机器人：${bot.alias || bot.id}（${bot.platform}）`,
        `工作区：${bot.defaultWorkspace || '（未设置）'}`,
        `会话：${info ? info.title || info.id.slice(0, 8) : '（未绑定）'}`,
        `状态：${info ? info.status : 'unknown'}${running ? ' · 本插件正在跟' : ''}`,
        `模型：${binding.model || bot.defaultModel || '（跟随界面）'}`,
        `队列：${harness.runs.size} 个运行中`,
      ];
      return { handled: true, reply: lines.join('\n') };
    }

    case 'new': {
      const result = await workbench.newConversation({ model: binding.model || bot.defaultModel || '' });
      if (!result.ok) return { handled: true, reply: `⚠️ 新建失败：${result.reason || '未知原因'}` };
      const title = arg || '';
      state.setBinding(bot.id, chatId, {
        conversationId: result.conversationId || '',
        title,
        model: result.model || binding.model || '',
        workspace: bot.defaultWorkspace || '',
      });
      return {
        handled: true,
        reply: result.conversationId
          ? `🆕 已新建会话${title ? `「${title}」` : ''}（模型 ${result.model || '当前'}）`
          : `🆕 已新建会话（模型 ${result.model || '当前'}）。它在发出第一条消息前没有 id，发完再发一次 /bind 就能绑定`,
        data: result,
      };
    }

    case 'ws': {
      const workspaces = listWorkspaces(index);
      if (!arg) {
        const lines = ['可用工作区：'];
        workspaces.slice(0, 15).forEach((ws, i) => lines.push(`  ${i + 1}. ${ws.path}（${ws.count} 个会话）`));
        lines.push('', '回复 /ws <序号> 切换');
        return { handled: true, reply: lines.join('\n') };
      }
      const index_ = Number.parseInt(arg, 10);
      const picked = workspaces[index_ - 1];
      if (!picked) return { handled: true, reply: '序号超出范围，先发 /ws 看看。' };
      const recent = index.list({ limit: 1, workspace: picked.path })[0];
      state.setBinding(bot.id, chatId, {
        conversationId: recent ? recent.id : '',
        title: recent ? recent.title : '',
        workspace: picked.path,
        model: binding.model || '',
      });
      return {
        handled: true,
        reply: recent
          ? `📁 已切到工作区 ${picked.path}\n会话：${recent.title || recent.id.slice(0, 8)}`
          : `📁 已切到工作区 ${picked.path}（还没有会话，发 /new 新建）`,
      };
    }

    case 'sessions': {
      const list = index.list({ limit: 10, workspace: bot.defaultWorkspace || '' });
      if (!list.length) return { handled: true, reply: '这个工作区还没有会话。' };
      const lines = ['最近会话：'];
      list.forEach((item, i) => {
        const mark = item.id === binding.conversationId ? '●' : ' ';
        lines.push(`  ${mark} ${i + 1}. ${item.title || item.id.slice(0, 8)}  [${item.status}]`);
      });
      lines.push('', '回复 /session <序号> 接管');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'session': {
      const list = index.list({ limit: 10, workspace: bot.defaultWorkspace || '' });
      const num = Number.parseInt(arg, 10);
      const picked = Number.isFinite(num) ? list[num - 1] : list.find((item) => item.id.startsWith(arg));
      if (!picked) return { handled: true, reply: '没找到这个会话，先发 /sessions。' };
      const switched = await workbench.sendPrompt === undefined ? { ok: true } : { ok: true };
      state.setBinding(bot.id, chatId, {
        conversationId: picked.id,
        title: picked.title,
        workspace: picked.workspace || bot.defaultWorkspace || '',
        model: binding.model || '',
      });
      return { handled: true, reply: `🔗 已接管：${picked.title || picked.id.slice(0, 8)}（${picked.status}）`, data: switched };
    }

    case 'models':
    case 'model': {
      const info = await listModels(workbench);
      if (!info.ok) return { handled: true, reply: `⚠️ 读不到模型菜单：${info.reason}` };
      if (command === 'models' || !arg) {
        const lines = [`当前模型：${info.current}`];
        info.items.forEach((item, i) => lines.push(`  ${item.label === info.current ? '●' : ' '} ${i + 1}. ${item.label}`));
        lines.push('', '回复 /model <序号|名称> 切换');
        return { handled: true, reply: lines.join('\n') };
      }
      const num = Number.parseInt(arg, 10);
      const target = Number.isFinite(num) ? info.items[num - 1]?.label : arg;
      if (!target) return { handled: true, reply: '序号超出范围。' };
      const picked = await workbench.sendPrompt
        ? await workbench.mutex.run(async () => workbench._selectModel(target))
        : { ok: false, reason: 'unsupported' };
      if (!picked.ok) return { handled: true, reply: `⚠️ 切换失败：${picked.reason}` };
      state.setBinding(bot.id, chatId, { ...binding, model: picked.current || target });
      return { handled: true, reply: `🎛 已切到模型：${picked.current || target}` };
    }

    case 'stop': {
      const result = await workbench.stopGeneration();
      return { handled: true, reply: result?.ok ? '⏹ 已请求中止' : `⚠️ 中止失败：${result?.reason || '未知'}` };
    }

    case 'steer': {
      if (!arg) return { handled: true, reply: '用法：/steer 补充指令' };
      const conversationId = binding.conversationId || (await workbench.currentConversationId());
      const result = await harness.submit({
        bot,
        chatId,
        text: arg,
        mode: 'steer',
        onProgress: null,
        timeoutMs: 120000,
      });
      return { handled: true, reply: result.ok ? '↩️ 已插话' : `⚠️ 插话失败：${result.error}`, data: { conversationId, result } };
    }

    case 'compact': {
      const conversationId = binding.conversationId;
      if (!conversationId) return { handled: true, reply: '先绑定一个会话再压缩。' };
      const result = await harness.submit({ bot, chatId, text: '/compact', mode: 'queue', timeoutMs: 60000 });
      return { handled: true, reply: result.ok ? '🗜 已请求压缩上下文' : `⚠️ 压缩失败：${result.error}` };
    }

    case 'history': {
      const conversationId = binding.conversationId;
      if (!conversationId) return { handled: true, reply: '还没绑定会话。' };
      const { createWatcher } = await import('../bridge/transcript-watcher.mjs');
      const watcher = createWatcher(conversationId, { brainDir: index.brainDir, pollMs: 200, fromStart: true });
      watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 350));
      watcher.stop();
      const turns = watcher.userSteps.slice(-4).map((step) => {
        const text = String(step.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 80);
        return `· ${text}`;
      });
      return { handled: true, reply: turns.length ? ['最近几轮：', ...turns].join('\n') : '这个会话还没有历史。' };
    }

    case 'roam': {
      if (!ctx.roam) return { handled: true, reply: '主动漫游还没启用（面板里打开开关）。' };
      const result = await ctx.roam.runOnce({
        reason: 'manual',
        bot,
        send: async (text) => { await ctx.send?.(text); },
      });
      const pushed = result.pushed || [];
      if (!pushed.length) {
        const why = (result.skipped || []).slice(0, 3).map((x) => `${x.title?.slice(0, 18) || '?'}（${x.reason}）`).join('；');
        return { handled: true, reply: `这轮没刷到够格的东西${why ? `：${why}` : ''}。` };
      }
      return { handled: true, reply: `刷完了，推了 ${pushed.length} 条：${pushed.map((x) => x.title).join(' / ')}` };
    }

    case 'read': {
      if (!arg) return { handled: true, reply: '用法：/read https://…' };
      const res = await ctx.readLink?.(arg);
      if (!res?.ok) return { handled: true, reply: `⚠️ 没读到：${res?.reason || '未知原因'}（不会凭标题编内容）` };
      const body = ctx.condense?.(res.text) || String(res.text).slice(0, 2000);
      return { handled: true, reply: `📄 ${res.engine === 'envoy' ? 'Envoy 深读' : '网页读取'}${res.partial ? '（部分内容）' : ''}：\n\n${body}` };
    }

    case 'diary': {
      const text = ctx.diary?.recentDiary?.(3) || '';
      return { handled: true, reply: text ? text.slice(0, 2500) : '还没有漫游手记。' };
    }

    case 'taste': {
      const [signalRaw, ...rest] = String(arg || '').split(/\s+/);
      const signal = ['like', 'dislike', 'detail'].includes(signalRaw) ? signalRaw : 'like';
      ctx.diary?.recordTaste?.({ signal, note: rest.join(' ') });
      ctx.gate?.markEngaged?.({ signal, detail: rest.join(' ') });
      return { handled: true, reply: `已记下口味：${signal}${rest.length ? `（${rest.join(' ')}）` : ''}` };
    }

    case 'repair':
      return { handled: true, reply: '飞书补权限：在飞书里给机器人发 /repair 会重新拉起扫码（仅飞书渠道支持）。', action: 'repair' };

    default:
      return { handled: false };
  }
}

export function listWorkspaces(index) {
  const all = index.list({ limit: 500 });
  const map = new Map();
  for (const item of all) {
    for (const ws of item.workspaces || []) {
      if (!ws) continue;
      const entry = map.get(ws) || { path: ws, count: 0, lastModified: '' };
      entry.count += 1;
      if (item.lastModified > entry.lastModified) entry.lastModified = item.lastModified;
      map.set(ws, entry);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
}

async function listModels(workbench) {
  try {
    const result = await workbench.listModels();
    return { ok: result.ok, current: result.current || '', items: (result.items || []).map((label, i) => ({ index: i, label })) };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), items: [] };
  }
}
