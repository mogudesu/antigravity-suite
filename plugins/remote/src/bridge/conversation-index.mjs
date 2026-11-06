/**
 * 会话索引：直接读 Antigravity 自己的 conversation_summaries.db。
 *
 * 为什么不用 gRPC：LanguageServer 的 GetAllCascadeTrajectories 是 gRPC-web + protobuf，
 * 没有 schema 解析成本很高；而这个 SQLite 里已经有标题、工作区、运行状态、最后活跃时间，
 * 是同一份数据的落地形态，读起来稳定得多。
 *
 * 注意：库是 WAL 模式且被主进程占用，所以复制 db + wal 到临时目录再只读打开。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths, ensureRuntimeDirs } from '../store/paths.mjs';

const STATUS_MAP = {
  CASCADE_RUN_STATUS_IDLE: 'idle',
  CASCADE_RUN_STATUS_RUNNING: 'running',
  CASCADE_RUN_STATUS_WAITING: 'waiting',
  CASCADE_RUN_STATUS_QUEUED: 'queued',
  CASCADE_RUN_STATUS_UNSPECIFIED: 'idle',
};

export function decodeWorkspace(uri) {
  const text = String(uri || '').replace(/^file:\/\//i, '');
  try {
    const decoded = decodeURIComponent(text);
    if (process.platform !== 'win32') return decoded;
    // Windows 上统一成 F:/xxx：盘符大写、去掉多余的引导斜杠
    return decoded.replace(/^\/([a-zA-Z]:)/, '$1').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
  } catch {
    return text;
  }
}

function parseWorkspaces(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(decodeWorkspace).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^file:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export class ConversationIndex {
  constructor({ dbFile = paths().summariesDb, brainDir = paths().brain } = {}) {
    this.dbFile = dbFile;
    this.brainDir = brainDir;
    // 每个进程一份副本：多个实例（守护进程 + 测试）同时读写同一份会撞出 disk I/O error
    this._copyPath = path.join(ensureRuntimeDirs().tmp, `conversation_summaries.${process.pid}.db`);
    this._copyStamp = '';
    this._db = null;
  }

  /** 复制一份可读快照（源文件被占用时也不影响）。 */
  _snapshot() {
    let stat;
    try {
      stat = fs.statSync(this.dbFile);
    } catch {
      throw new Error(`找不到会话索引：${this.dbFile}`);
    }
    // WAL 模式下新数据可能只写进 -wal，主库 mtime/size 不变；
    // 所以把 wal 的 mtime+size 也算进指纹，否则状态会一直是旧的 idle。
    const walFile = `${this.dbFile}-wal`;
    let walStat = null;
    try {
      walStat = fs.statSync(walFile);
    } catch {
      walStat = null;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}:${walStat ? `${walStat.mtimeMs}:${walStat.size}` : '0'}`;
    if (stamp === this._copyStamp && this._db) return this._db;

    if (this._db) {
      try {
        this._db.close();
      } catch {
        /* ignore */
      }
      this._db = null;
    }
    fs.copyFileSync(this.dbFile, this._copyPath);
    for (const suffix of ['-wal', '-shm']) {
      const extra = `${this.dbFile}${suffix}`;
      if (fs.existsSync(extra)) {
        try {
          fs.copyFileSync(extra, `${this._copyPath}${suffix}`);
        } catch {
          /* wal 复制失败也能读到旧数据 */
        }
      }
    }
    this._db = new DatabaseSync(this._copyPath, { readOnly: true });
    this._copyStamp = stamp;
    return this._db;
  }

  _rows(sql, params = [], attempt = 0) {
    try {
      const db = this._snapshot();
      return db.prepare(sql).all(...params);
    } catch (error) {
      // 主进程正在写 WAL 时，拷出来的副本可能不一致（disk I/O error / malformed）。
      // 丢掉副本、稍等、重拷重试；这是同步 API，所以用极短的忙等。
      const retriable = /disk I\/O|malformed|not a database|file is not a database/i.test(String(error?.message || ''));
      if (!retriable || attempt >= 3) throw error;
      this._copyStamp = '';
      try {
        this._db?.close();
      } catch {
        /* ignore */
      }
      this._db = null;
      const until = Date.now() + 40 * (attempt + 1);
      while (Date.now() < until) {
        /* 40~120ms 忙等，等这一轮 WAL 写完 */
      }
      return this._rows(sql, params, attempt + 1);
    }
  }

  /**
   * 列出会话。
   * @param {{limit?: number, workspace?: string, query?: string, onlyActive?: boolean}} options
   */
  list({ limit = 60, workspace = '', query = '', onlyActive = false } = {}) {
    const where = [];
    const params = [];
    if (query) {
      where.push('(preview LIKE ? OR title LIKE ?)');
      params.push(`%${query}%`, `%${query}%`);
    }
    if (onlyActive) where.push("status <> 'CASCADE_RUN_STATUS_IDLE'");
    const sql = `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
                        status, project_id, agent_name, not_fully_idle, killed, last_user_input_time
                 FROM conversation_summaries
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY last_modified_time DESC
                 LIMIT ?`;
    // 工作区在 SQL 里不好比（存的是 file:/// 编码串，大小写/斜杠都不统一），映射后再过滤
    params.push(Math.max(1, Math.min(500, workspace ? 500 : limit)));
    let items = this._rows(sql, params).map((row) => this._map(row));
    if (workspace) {
      const want = normalizePath(workspace);
      items = items.filter((item) => item.workspaces.some((ws) => normalizePath(ws) === want));
      items = items.slice(0, Math.max(1, Math.min(500, limit)));
    }
    return items;
  }

  get(conversationId) {
    const rows = this._rows(
      `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
              status, project_id, agent_name, not_fully_idle, killed, last_user_input_time
       FROM conversation_summaries WHERE conversation_id = ?`,
      [conversationId],
    );
    return rows.length ? this._map(rows[0]) : null;
  }

  statusOf(conversationId) {
    const item = this.get(conversationId);
    return item ? item.status : 'unknown';
  }

  _map(row) {
    const workspaces = parseWorkspaces(row.workspace_uris);
    return {
      id: row.conversation_id,
      title: (row.preview || row.title || '').trim(),
      stepCount: Number(row.step_count || 0),
      lastModified: row.last_modified_time || '',
      workspace: workspaces[0] || '',
      workspaces,
      status: STATUS_MAP[row.status] || 'unknown',
      projectId: row.project_id || '',
      agentName: row.agent_name || '',
      notFullyIdle: Boolean(row.not_fully_idle),
      killed: Boolean(row.killed),
      transcript: this.transcriptPath(row.conversation_id),
    };
  }

  transcriptPath(conversationId) {
    return path.join(this.brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  /** 最近活跃的会话（含工作区），给 UI 的默认选择用。 */
  recent(limit = 20) {
    return this.list({ limit });
  }

  close() {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        /* ignore */
      }
      this._db = null;
      this._copyStamp = '';
    }
  }
}

export function defaultIndex() {
  return new ConversationIndex();
}

export const __test__ = { parseWorkspaces, STATUS_MAP, osTmp: () => os.tmpdir() };
