/**
 * 会话持久化 —— node:sqlite（Node >= 22.13 内置，零依赖）（M1 / F01·F08）
 * ============================================================================
 *  范围（阶段 2A.2，见任务书第 8 节与勘误⑤）：
 *    Conversation / Message / Run 三类实体；ToolCall 与产物嵌入 message.meta（JSON）；
 *    Task 实体待 2B 写操作引入时再拆。
 *  规则：
 *    · 服务端是历史权威；前端刷新/重启后恢复
 *    · (clientRequestId) 唯一 → 重复提交不产生重复任务（幂等）
 *    · 服务重启时，遗留 running 的 run 与 streaming 的消息统一标为 interrupted（不假装还在跑）
 *    · 删除为软删除（deletedAt），误触可恢复
 */

import { currentActor } from '../security/context.ts';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.ts';
import type {
  EffectPreview,
  OperationReceipt,
  Proposal,
  ProposalState,
  SandboxActor,
  SandboxClosure,
  SandboxDutySession,
  SandboxIssue,
  SandboxNotification,
  SandboxRoomStatus,
  ScheduleProvenance,
  TaskRecord,
  TaskStatus
} from '../../shared/operations-contract.ts';

export interface ConversationRow {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  preview: string;
  /** 会话类型：task=任务工作台（默认）；chat=纯聊天（不能执行任务操作） */
  mode: 'chat' | 'task';
  /** 会话来源：null=用户发起；'automation'=主系统定时任务到点触发 */
  source?: string | null;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  status: string;
  meta: Record<string, unknown> | null;
  clientRequestId: string | null;
  ordinal: number;
  createdAt: string;
}

const DB_DIR = path.join(PROJECT_ROOT, 'server', 'data');
/** R25-lite：测试用独立库路径（LABOPS_DB_PATH），不写真实用户数据 */
const DB_PATH = process.env['LABOPS_DB_PATH'] ?? path.join(DB_DIR, 'labops.sqlite');

let db: DatabaseSync | null = null;
let dbInitError: string | null = null;

/** R01：初始化是否成功；失败时 API 层返回 503 与恢复说明，健康检查不再谎报就绪。
 *  初始化是惰性的 —— 首次调用 getDb() 才建库，所以"就绪"必须现场探测一次。 */
export function dbReady(): boolean {
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

export function dbLastError(): string | null {
  return dbInitError;
}

export function getDb(): DatabaseSync {
  if (db) return db;
  db = initDatabase();
  return db;
}

/**
 * R01/C01–C02：在**局部连接**上完成全部初始化（建表 → 恢复遗留 running → 版本迁移 → 约束），
 * 全部成功后才发布为单例；任何一步失败关闭连接、记录原因，绝不保留半初始化对象。
 * 顺序要点：旧版允许同会话多条 running，必须**先**恢复中断、**后**建唯一部分索引。
 */
function initDatabase(): DatabaseSync {
  fs.mkdirSync(DB_DIR, { recursive: true });
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSync(DB_PATH);
    conn.exec('PRAGMA journal_mode = WAL;');
    conn.exec('PRAGMA foreign_keys = ON;');

    // R25-lite：版本化迁移。schema 已存在的判定读 schema，不靠 catch ALTER 推进版本
    const convCols = (
      conn.prepare(`PRAGMA table_info(conversations)`).all() as Array<Record<string, unknown>>
    ).map((r) => String(r['name']));
    const fresh = !convCols.length;

    conn.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        lastActivityAt TEXT NOT NULL,
        deletedAt TEXT,
        contextLab TEXT,
        contextDate TEXT,
        contextTask TEXT,
        mode TEXT NOT NULL DEFAULT 'task'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'completed',
        meta TEXT,
        clientRequestId TEXT,
        ordinal INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        assistantMessageId TEXT NOT NULL,
        status TEXT NOT NULL,
        engine TEXT,
        startedAt TEXT NOT NULL,
        endedAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_req ON messages(clientRequestId) WHERE clientRequestId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversationId, ordinal);
      CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations(lastActivityAt DESC);
    `);

    // 旧库补 context 列（检查 schema 后再 ALTER，缺哪补哪）
    if (!fresh) {
      for (const col of ['contextLab', 'contextDate', 'contextTask']) {
        if (!convCols.includes(col)) {
          conn.exec(`ALTER TABLE conversations ADD COLUMN ${col} TEXT`);
        }
      }
      if (!convCols.includes('mode')) {
        // 会话类型（阶段 2B）：task=任务工作台（默认）；chat=纯聊天，不能执行任务操作
        conn.exec(`ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'task'`);
      }
    }

    const columns = conn.prepare('PRAGMA table_info(conversations)').all() as Array<Record<string, unknown>>;
    if (!columns.some(c => c['name'] === 'ownerId')) conn.exec("ALTER TABLE conversations ADD COLUMN ownerId TEXT NOT NULL DEFAULT 'legacy-unassigned'");
    // 到点自动化（2026-11-09 整合方案 §5）：会话来源标记与任务号，供列表徽标与对账
    if (!columns.some(c => c['name'] === 'source')) conn.exec("ALTER TABLE conversations ADD COLUMN source TEXT");
    if (!columns.some(c => c['name'] === 'jobId')) conn.exec("ALTER TABLE conversations ADD COLUMN jobId TEXT");
    conn.exec(`
      CREATE TABLE IF NOT EXISTS demo_sessions (tokenHash TEXT PRIMARY KEY, subject TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      -- RAG 批次1：知识段落向量索引（余弦检索在 JS 侧完成，语料规模小无需向量库）
      CREATE TABLE IF NOT EXISTS knowledge_chunks_vec (
        chunkKey TEXT PRIMARY KEY,
        docId TEXT NOT NULL,
        paraIndex INTEGER NOT NULL,
        dim INTEGER NOT NULL,
        model TEXT NOT NULL,
        vec BLOB NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kcv_doc ON knowledge_chunks_vec(docId);
      CREATE TABLE IF NOT EXISTS request_quota (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS verified_facts (ownerId TEXT NOT NULL, sessionId TEXT NOT NULL, fact TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(ownerId, sessionId));
    `);
    // 关键顺序：**先**把遗留 running/streaming 恢复为 interrupted（记录原因），
    // **再**建同会话唯一活跃索引 —— 旧库多条 running 不会炸迁移（C01）
    const migrated = recoverInterrupted(conn);

    conn.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active ON runs(conversationId) WHERE status = 'running';`);

    const verRow = conn.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
    const ver = Number(verRow?.['user_version'] ?? 0);
    if (ver < 1) {
      conn.exec('BEGIN');
      conn.exec('PRAGMA user_version = 1');
      conn.exec('COMMIT');
    }
    // ops.v1（阶段 2B）：提案/决策/操作/审计/outbox + 沙盒业务表。
    // 全部 IF NOT EXISTS —— 旧库直接补建，新库一次到位。
    conn.exec(OPS_SCHEMA_V2);
    conn.exec('CREATE TABLE IF NOT EXISTS ops_proposal_commits(proposalId TEXT PRIMARY KEY, operationId TEXT UNIQUE NOT NULL)');
    // 0.6.0 轮次回档：沙盒写入补偿的独立台账。与 ops_audit 并列，不覆盖原始回执 ——
    // 回执记录"发生过什么"，本表记录"后来又撤回了什么"，两者都不改历史。
    conn.exec(`CREATE TABLE IF NOT EXISTS ops_reverts (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      userMessageId TEXT NOT NULL,
      operationId TEXT NOT NULL,
      objectKind TEXT NOT NULL,
      objectId TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      actorId TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ops_reverts_conv ON ops_reverts(conversationId, createdAt);`);
    // 旧库补 biz_notifications.status（检查 schema 后再 ALTER，缺哪补哪）
    const ntfCols = (conn.prepare(`PRAGMA table_info(biz_notifications)`).all() as Array<Record<string, unknown>>).map((r) => String(r['name']));
    if (ntfCols.length && !ntfCols.includes('status')) {
      conn.exec(`ALTER TABLE biz_notifications ADD COLUMN status TEXT NOT NULL DEFAULT 'published'`);
    }
    conn.exec(`CREATE TABLE IF NOT EXISTS message_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversationId TEXT NOT NULL,messageId TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS message_changes_conv ON message_changes(conversationId,seq);
    CREATE TRIGGER IF NOT EXISTS messages_insert_change AFTER INSERT ON messages BEGIN INSERT INTO message_changes(conversationId,messageId) VALUES (NEW.conversationId,NEW.id); DELETE FROM message_changes WHERE seq < last_insert_rowid()-20000; END;
    CREATE TRIGGER IF NOT EXISTS messages_update_change AFTER UPDATE ON messages BEGIN INSERT INTO message_changes(conversationId,messageId) VALUES (NEW.conversationId,NEW.id); DELETE FROM message_changes WHERE seq < last_insert_rowid()-20000; END;
    CREATE TRIGGER IF NOT EXISTS messages_delete_change AFTER DELETE ON messages BEGIN INSERT INTO message_changes(conversationId,messageId) VALUES (OLD.conversationId,OLD.id); DELETE FROM message_changes WHERE seq < last_insert_rowid()-20000; END;`);
    conn.exec('PRAGMA user_version = 6');
    if (migrated) console.log('[persistence] 旧库升级完成（含遗留运行恢复）');
    return conn;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dbInitError = message;
    console.error('[persistence] 初始化失败，会话功能不可用：', message);
    try {
      conn?.close();
    } catch {
      /* 忽略关闭失败 */
    }
    throw err;
  }
}

/** 服务重启：遗留的 running/streaming 在事务内标为 interrupted（带原因），绝不假装还在执行 */
function recoverInterrupted(conn: DatabaseSync): boolean {
  const now = new Date().toISOString();
  conn.exec('BEGIN');
  try {
    const r1 = conn
      .prepare(`UPDATE runs SET status='interrupted', endedAt=? WHERE status IN ('running','queued','save_failed')`)
      .run(now);
    const r2 = conn.prepare(`UPDATE messages SET status='interrupted' WHERE status='streaming'`).run();
    const r3 = conn
      .prepare(`UPDATE messages SET meta = json_set(COALESCE(meta,'{}'), '$.interruptReason', '服务重启时执行尚未完成') WHERE status='interrupted' AND role='assistant'`)
      .run();
    conn.exec('COMMIT');
    if (Number(r1.changes) > 0 || Number(r2.changes) > 0) {
      console.log(`[persistence] 重启恢复：${r1.changes} 个运行、${r2.changes} 条消息标记为 interrupted（${r3.changes} 条写入原因）`);
      return true;
    }
    return false;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

function newId(prefix: string): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? `${prefix}-${c.randomUUID()}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// --------------------------- 会话 ---------------------------

export function listConversations(limit = 100): ConversationRow[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.title, c.lastActivityAt, c.mode, c.source,
              (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id) AS messageCount,
              (SELECT CASE WHEN json_extract(m2.meta,'$.headline') IS NOT NULL
                           THEN json_extract(m2.meta,'$.headline')
                           ELSE substr(m2.text,1,80) END
                 FROM messages m2 WHERE m2.conversationId = c.id ORDER BY m2.ordinal DESC LIMIT 1) AS preview
         FROM conversations c
        WHERE c.deletedAt IS NULL AND (? IS NULL OR c.ownerId = ?)
        ORDER BY c.lastActivityAt DESC
        LIMIT ?`
    )
    .all(currentActor()?.id ?? null, currentActor()?.id ?? null, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r['id']),
    title: String(r['title']) || '未命名会话',
    lastActivityAt: String(r['lastActivityAt']),
    createdAt: '',
    messageCount: Number(r['messageCount']),
    preview: String(r['preview'] ?? '').slice(0, 80),
    mode: String(r['mode'] ?? 'task') as 'chat' | 'task',
    source: r['source'] === null || r['source'] === undefined ? null : String(r['source'])
  }));
}

export function createConversation(title = '', mode: 'chat' | 'task' = 'task', opts?: { ownerId?: string; source?: string; jobId?: string }): { id: string; createdAt: string } {
  const id = newId('conv');
  const now = new Date().toISOString();
  getDb()
    .prepare(`INSERT INTO conversations (id, title, createdAt, lastActivityAt, mode, ownerId, source, jobId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, now, now, mode === 'chat' ? 'chat' : 'task', opts?.ownerId ?? currentActor()?.id ?? 'legacy-unassigned', opts?.source ?? null, opts?.jobId ?? null);
  return { id, createdAt: now };
}

export function getConversationMeta(id: string): { id: string; title: string; createdAt: string; lastActivityAt: string; mode: 'chat' | 'task' } | null {
  const row = getDb()
    .prepare(`SELECT id, title, createdAt, lastActivityAt, mode FROM conversations WHERE id = ? AND deletedAt IS NULL AND (? IS NULL OR ownerId = ?)`)
    .get(id, currentActor()?.id ?? null, currentActor()?.id ?? null) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row['id']),
    title: String(row['title']) || '未命名会话',
    createdAt: String(row['createdAt']),
    lastActivityAt: String(row['lastActivityAt']),
    mode: String(row['mode'] ?? 'task') as 'chat' | 'task'
  };
}

export function renameConversation(id: string, title: string): boolean {
  const r = getDb()
    .prepare(`UPDATE conversations SET title = ? WHERE id = ? AND deletedAt IS NULL`)
    .run(title.slice(0, 60), id);
  return Number(r.changes) > 0;
}

/** 切换会话类型（聊天 ⇄ 任务）。类型是消息路由的权威依据，存服务端 */
export function updateConversationMode(id: string, mode: 'chat' | 'task'): boolean {
  const r = getDb()
    .prepare(`UPDATE conversations SET mode = ? WHERE id = ? AND deletedAt IS NULL`)
    .run(mode === 'chat' ? 'chat' : 'task', id);
  return Number(r.changes) > 0;
}

/** 会话已有多少条消息 —— 模式锁定判定用（≤0 表示还没开始对话） */
export function countMessages(conversationId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversationId = ?`).get(conversationId) as Record<string, unknown>;
  return Number(row['n'] ?? 0);
}

export function deleteConversation(id: string): boolean {
  const now = new Date().toISOString();
  const r = getDb().prepare(`UPDATE conversations SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL`).run(now, id);
  return Number(r.changes) > 0;
}

export function touchConversation(id: string): void {
  getDb().prepare(`UPDATE conversations SET lastActivityAt = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

/** 首条用户消息自动生成会话标题；手动改名后（title 非空）不再覆盖 */
export function ensureTitle(id: string, fallbackTitle: string): void {
  getDb()
    .prepare(`UPDATE conversations SET title = ? WHERE id = ? AND (title = '' OR title IS NULL)`)
    .run(fallbackTitle.slice(0, 40), id);
}

// --------------------------- 消息 ---------------------------

export function getMessages(conversationId: string): MessageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, conversationId, role, text, status, meta, clientRequestId, ordinal, createdAt
         FROM messages WHERE conversationId = ? ORDER BY ordinal ASC`
    )
    .all(conversationId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r['id']),
    conversationId: String(r['conversationId']),
    role: r['role'] as 'user' | 'assistant',
    text: String(r['text'] ?? ''),
    status: String(r['status'] ?? 'completed'),
    meta: r['meta'] ? (JSON.parse(String(r['meta'])) as Record<string, unknown>) : null,
    clientRequestId: r['clientRequestId'] ? String(r['clientRequestId']) : null,
    ordinal: Number(r['ordinal']),
    createdAt: String(r['createdAt'])
  }));
}

export function nextOrdinal(conversationId: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM messages WHERE conversationId = ?`)
    .get(conversationId) as Record<string, unknown>;
  return Number(row['next']);
}

export function insertUserMessage(conversationId: string, text: string, clientRequestId: string): MessageRow | null {
  const d = getDb();
  // 幂等：同一 clientRequestId 只收一次
  const dup = d.prepare(`SELECT id FROM messages WHERE clientRequestId = ?`).get(clientRequestId);
  if (dup) return null;
  const ordinal = nextOrdinal(conversationId);
  const row: MessageRow = {
    id: newId('msg'),
    conversationId,
    role: 'user',
    text,
    status: 'completed',
    meta: null,
    clientRequestId,
    ordinal,
    createdAt: new Date().toISOString()
  };
  d.prepare(
    `INSERT INTO messages (id, conversationId, role, text, status, meta, clientRequestId, ordinal, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.conversationId, row.role, row.text, row.status, row.meta ? JSON.stringify(row.meta) : null, row.clientRequestId, row.ordinal, row.createdAt);
  touchConversation(conversationId);
  ensureTitle(conversationId, text);
  return row;
}

export function insertAssistantPlaceholder(conversationId: string, runId: string): MessageRow {
  const ordinal = nextOrdinal(conversationId);
  const row: MessageRow = {
    id: newId('msg'),
    conversationId,
    role: 'assistant',
    text: '',
    status: 'streaming',
    meta: { toolCalls: [], runId },
    clientRequestId: null,
    ordinal,
    createdAt: new Date().toISOString()
  };
  getDb()
    .prepare(
      `INSERT INTO messages (id, conversationId, role, text, status, meta, clientRequestId, ordinal, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.conversationId, row.role, row.text, row.status, row.meta ? JSON.stringify(row.meta) : null, null, row.ordinal, row.createdAt);
  return row;
}

/** 流式期间增量刷写助手消息（text + 可选 toolCalls + 可选 plan[A5]） */
export function updateAssistantPartial(messageId: string, text: string, toolCalls?: unknown[], plan?: unknown[]): void {
  if (toolCalls !== undefined && plan !== undefined) {
    getDb()
      .prepare(
        `UPDATE messages SET text = ?, meta = json_set(COALESCE(meta,'{}'), '$.toolCalls', json(?), '$.plan', json(?)) WHERE id = ?`
      )
      .run(text, JSON.stringify(toolCalls), JSON.stringify(plan), messageId);
  } else if (toolCalls !== undefined) {
    getDb()
      .prepare(
        `UPDATE messages SET text = ?, meta = json_set(COALESCE(meta,'{}'), '$.toolCalls', json(?)) WHERE id = ?`
      )
      .run(text, JSON.stringify(toolCalls), messageId);
  } else if (plan !== undefined) {
    getDb()
      .prepare(
        `UPDATE messages SET text = ?, meta = json_set(COALESCE(meta,'{}'), '$.plan', json(?)) WHERE id = ?`
      )
      .run(text, JSON.stringify(plan), messageId);
  } else {
    getDb().prepare(`UPDATE messages SET text = ? WHERE id = ?`).run(text, messageId);
  }
}

/**
 * N01：创建消息三件套（user + assistant 占位 + run）必须在**一个短事务**内完成，
 * 任何一步失败整组回滚 —— 绝不留下"半写入"的孤立助手占位或假 running。
 * 活跃 run 互斥（N04）：同会话已有 running 时抛 RunConflictError。
 */
export class RunConflictError extends Error {
  readonly activeRunId: string;
  constructor(activeRunId: string) {
    super(`该会话已有正在执行的任务（${activeRunId}），请等待完成或先停止`);
    this.name = 'RunConflictError';
    this.activeRunId = activeRunId;
  }
}

export interface CreatedRun {
  userMessage: MessageRow;
  assistant: MessageRow;
}

export function createMessageWithRun(
  conversationId: string,
  question: string,
  clientRequestId: string,
  runId: string
): CreatedRun | { duplicate: true } {
  const d = getDb();
  // 幂等预检（唯一索引兜底并发）
  const dup = d.prepare(`SELECT id FROM messages WHERE clientRequestId = ?`).get(clientRequestId);
  if (dup) return { duplicate: true };
  // 同会话活跃 run 互斥（部分唯一索引兜底并发）。
  // R02：活跃登记里 finalizeFailed 的 run 是"保存失败残留"，先尽力修复再放行新请求，
  // 用户不会被一次写库故障永久锁死。
  for (const [rid, entry] of activeRunMap) {
    if (entry.conversationId === conversationId && entry.finalizeFailed) {
      if (tryMarkSaveFailed(conversationId, rid)) {
        activeRunMap.delete(rid);
        break;
      }
      throw new RunConflictError(rid);
    }
  }
  const active = d
    .prepare(`SELECT id FROM runs WHERE conversationId = ? AND status = 'running'`)
    .get(conversationId) as Record<string, unknown> | undefined;
  if (active) throw new RunConflictError(String(active['id']));

  const now = new Date().toISOString();
  const userId = newId('msg');
  const assistantId = newId('msg');
  const baseOrd = nextOrdinal(conversationId);
  d.exec('BEGIN');
  try {
    d.prepare(
      `INSERT INTO messages (id, conversationId, role, text, status, meta, clientRequestId, ordinal, createdAt)
       VALUES (?, ?, 'user', ?, 'completed', NULL, ?, ?, ?)`
    ).run(userId, conversationId, question, clientRequestId, baseOrd, now);
    d.prepare(
      `INSERT INTO messages (id, conversationId, role, text, status, meta, clientRequestId, ordinal, createdAt)
       VALUES (?, ?, 'assistant', '', 'streaming', ?, NULL, ?, ?)`
    ).run(assistantId, conversationId, JSON.stringify({ toolCalls: [], runId }), baseOrd + 1, now);
    d.prepare(
      `INSERT INTO runs (id, conversationId, assistantMessageId, status, engine, startedAt) VALUES (?, ?, ?, 'running', NULL, ?)`
    ).run(runId, conversationId, assistantId, now);
    d.prepare(`UPDATE conversations SET lastActivityAt = ? WHERE id = ?`).run(now, conversationId);
    ensureTitle(conversationId, question);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return {
    userMessage: {
      id: userId,
      conversationId,
      role: 'user',
      text: question,
      status: 'completed',
      meta: null,
      clientRequestId,
      ordinal: baseOrd,
      createdAt: now
    },
    assistant: {
      id: assistantId,
      conversationId,
      role: 'assistant',
      text: '',
      status: 'streaming',
      meta: { toolCalls: [], runId },
      clientRequestId: null,
      ordinal: baseOrd + 1,
      createdAt: now
    }
  };
}

/** 活跃 run 上下文（取消接口用）：runId → conversationId */
/** 活跃 run 登记（取消接口/并发互斥/保存失败修复用）：runId → 会话与控制句柄 */
interface ActiveRunEntry {
  conversationId: string;
  cancelRequested: boolean;
  finalizeFailed: boolean;
  abort: (() => void) | null;
}
const activeRunMap = new Map<string, ActiveRunEntry>();

export function trackActiveRun(
  runId: string,
  conversationId: string
): { cancelRequested: () => boolean; setAbort: (fn: () => void) => void; markUnrecoverable: () => boolean } {
  const entry: ActiveRunEntry = { conversationId, cancelRequested: false, finalizeFailed: false, abort: null };
  activeRunMap.set(runId, entry);
  return {
    cancelRequested: () => entry.cancelRequested,
    setAbort: (fn) => {
      entry.abort = fn;
    },
    // R02：终态事务失败 → 尽力把 run 标为 save_failed；修复成功才允许释放登记
    markUnrecoverable: () => {
      entry.finalizeFailed = true;
      return tryMarkSaveFailed(entry.conversationId, runId);
    }
  };
}

export function releaseActiveRun(runId: string): void {
  activeRunMap.delete(runId);
}

/** R12：会话是否仍有活跃 run（删除拦截用）——内存活跃表 + 持久 running 双查 */
export function hasActiveRunForConversation(conversationId: string): boolean {
  for (const entry of activeRunMap.values()) {
    if (entry.conversationId === conversationId) return true;
  }
  const row = getDb()
    .prepare(`SELECT id FROM runs WHERE conversationId = ? AND status = 'running' LIMIT 1`)
    .get(conversationId);
  return Boolean(row);
}

/** N06：显式取消接口 —— 记录取消意愿并中止执行；服务端终态将记为 cancelled */
export function requestCancel(runId: string): 'requested' | 'not_found' | 'already_finished' {
  const entry = activeRunMap.get(runId);
  if (!entry) return 'not_found';
  if (entry.cancelRequested) return 'requested';
  entry.cancelRequested = true;
  entry.abort?.();
  return 'requested';
}

/** N07：会话上下文快照持久化（重启后承接不丢） */
export interface ContextSnapshot {
  labName: string | null;
  date: string | null;
  task: string | null;
}

export function saveContext(conversationId: string, ctx: ContextSnapshot): void {
  getDb()
    .prepare(`UPDATE conversations SET contextLab = ?, contextDate = ?, contextTask = ? WHERE id = ?`)
    .run(ctx.labName, ctx.date, ctx.task, conversationId);
}

export function loadContext(conversationId: string): ContextSnapshot | null {
  const row = getDb()
    .prepare(`SELECT contextLab, contextDate, contextTask FROM conversations WHERE id = ? AND deletedAt IS NULL`)
    .get(conversationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    labName: row['contextLab'] ? String(row['contextLab']) : null,
    date: row['contextDate'] ? String(row['contextDate']) : null,
    task: row['contextTask'] ? String(row['contextTask']) : null
  };
}

/**
 * R02：终态写入失败后的尽力修复 —— run/消息标为 save_failed（重启恢复也认这个状态）。
 * 这是"待修复登记"，不是把错误藏起来：界面上仍显示保存失败。
 */
function tryMarkSaveFailed(_conversationId: string, runId: string): boolean {
  try {
    const d = getDb();
    const now = new Date().toISOString();
    d.exec('BEGIN');
    try {
      d.prepare(`UPDATE runs SET status='save_failed', endedAt=? WHERE id=? AND status IN ('running','queued')`).run(now, runId);
      d.prepare(
        `UPDATE messages SET status='save_failed' WHERE id=(SELECT assistantMessageId FROM runs WHERE id=?) AND status IN ('streaming','completed')`
      ).run(runId);
      d.exec('COMMIT');
      return true;
    } catch {
      d.exec('ROLLBACK');
      return false;
    }
  } catch {
    return false;
  }
}

/** B09/B12：权威运行状态查询 */
export function getRun(runId: string): Record<string, unknown> | null {
  const row = getDb()
    .prepare(`SELECT id, conversationId, assistantMessageId, status, engine, startedAt, endedAt FROM runs WHERE id = ?`)
    .get(runId) as Record<string, unknown> | undefined;
  return row ?? null;
}

// ===========================================================================
//  ops.v1（阶段 2B）—— 任务 / 提案 / 决策 / 操作回执 / 审计 / outbox / 沙盒业务
// ============================================================================
//  规则（任务书 §9）：
//   · 业务事实以 ops_operations.receipt 为准；聊天文字不是凭据
//   · 决策幂等：ops_decisions.clientRequestId 唯一；重放返回既有结果
//   · 提案参数只存服务端（ops_proposals.payload）；决策请求只带 ID+版本+决定
//   · biz_* 表是"独立业务沙盒"的权威数据，绝不回写 state.json（避免双写）
// ===========================================================================

const OPS_SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS ops_tasks (
  id TEXT PRIMARY KEY,
  conversationId TEXT,
  kind TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  actorId TEXT NOT NULL,
  actorRole TEXT NOT NULL,
  actorLabel TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_proposals (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  actionType TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  payloadHash TEXT NOT NULL,
  environment TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  effects TEXT NOT NULL,
  missingDeps TEXT NOT NULL,
  requiredCaps TEXT NOT NULL,
  evidence TEXT NOT NULL,
  payloadKind TEXT NOT NULL,
  payloadView TEXT NOT NULL,
  canExecute INTEGER NOT NULL,
  cannotReason TEXT,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_decisions (
  id TEXT PRIMARY KEY,
  proposalId TEXT NOT NULL,
  proposalVersion INTEGER NOT NULL,
  decision TEXT NOT NULL,
  clientRequestId TEXT NOT NULL,
  actorId TEXT NOT NULL,
  decidedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_decisions_req ON ops_decisions(clientRequestId);
CREATE TABLE IF NOT EXISTS ops_operations (
  id TEXT PRIMARY KEY,
  clientRequestId TEXT NOT NULL,
  proposalId TEXT NOT NULL,
  actionType TEXT NOT NULL,
  status TEXT NOT NULL,
  requestHash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_operations_req ON ops_operations(clientRequestId);
CREATE INDEX IF NOT EXISTS idx_ops_proposals_task ON ops_proposals(taskId, version);
CREATE TABLE IF NOT EXISTS ops_audit (
  id TEXT PRIMARY KEY,
  actorId TEXT NOT NULL,
  action TEXT NOT NULL,
  objectKind TEXT NOT NULL,
  objectId TEXT NOT NULL,
  operationId TEXT,
  detail TEXT,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS biz_issues (
  id TEXT PRIMARY KEY,
  roomId TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  reporterId TEXT NOT NULL,
  reporterRole TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  attachmentRefs TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS biz_notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  level TEXT NOT NULL,
  audienceSummary TEXT NOT NULL,
  recipientCount INTEGER,
  publishedById TEXT NOT NULL,
  publishedByRole TEXT NOT NULL,
  publishedAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS biz_closures (
  id TEXT PRIMARY KEY,
  roomId TEXT NOT NULL,
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  periodKeys TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  affectedLessons INTEGER NOT NULL DEFAULT 0,
  createdById TEXT NOT NULL,
  createdByRole TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS biz_duty_sessions (
  id TEXT PRIMARY KEY,
  roomId TEXT NOT NULL,
  startedById TEXT NOT NULL,
  startedByRole TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  checklist TEXT,
  handoverNote TEXT,
  linkedIssueIds TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS biz_room_status (
  id TEXT PRIMARY KEY,
  roomId TEXT NOT NULL,
  status TEXT NOT NULL,
  createdById TEXT NOT NULL,
  createdByRole TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
`;

function opsId(prefix: string): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? `${prefix}-${c.randomUUID()}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// --------------------------- 任务 ---------------------------

export function createOpsTask(input: {
  kind: string;
  goal: string;
  actor: SandboxActor;
  conversationId: string | null;
}): TaskRecord {
  const now = new Date().toISOString();
  const id = opsId('task');
  getDb()
    .prepare(
      `INSERT INTO ops_tasks (id, conversationId, kind, goal, status, actorId, actorRole, actorLabel, revision, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'awaiting_confirmation', ?, ?, ?, 1, ?, ?)`
    )
    .run(id, input.conversationId, input.kind, input.goal, input.actor.id, input.actor.role, input.actor.label, now, now);
  return {
    taskId: id,
    conversationId: input.conversationId,
    kind: input.kind as TaskRecord['kind'],
    goal: input.goal,
    status: 'awaiting_confirmation',
    actor: input.actor,
    createdAt: now,
    updatedAt: now,
    proposalIds: [],
    operationIds: []
  };
}

function rowToTask(r: Record<string, unknown>): TaskRecord {
  const proposalIds = getDb()
    .prepare(`SELECT id FROM ops_proposals WHERE taskId = ? ORDER BY version ASC`)
    .all(String(r['id'])) as Array<Record<string, unknown>>;
  const operationIds = getDb()
    .prepare(`SELECT id FROM ops_operations WHERE proposalId IN (SELECT id FROM ops_proposals WHERE taskId = ?) ORDER BY createdAt ASC`)
    .all(String(r['id'])) as Array<Record<string, unknown>>;
  return {
    taskId: String(r['id']),
    conversationId: r['conversationId'] ? String(r['conversationId']) : null,
    kind: String(r['kind']) as TaskRecord['kind'],
    goal: String(r['goal']),
    status: String(r['status']) as TaskStatus,
    actor: { id: String(r['actorId']), role: String(r['actorRole']) as SandboxActor['role'], label: String(r['actorLabel']) },
    createdAt: String(r['createdAt']),
    updatedAt: String(r['updatedAt']),
    proposalIds: proposalIds.map((p) => String(p['id'])),
    operationIds: operationIds.map((o) => String(o['id']))
  };
}

export function getOpsTask(taskId: string): TaskRecord | null {
  const row = getDb().prepare(`SELECT * FROM ops_tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function listOpsTasks(limit = 50): TaskRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM ops_tasks WHERE (? IS NULL OR actorId = ?) ORDER BY createdAt DESC LIMIT ?`)
    .all(currentActor()?.id ?? null, currentActor()?.id ?? null, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToTask);
}

export function updateOpsTaskStatus(taskId: string, status: TaskStatus): void {
  getDb()
    .prepare(
      `UPDATE ops_tasks SET status = ?, revision = revision + 1, updatedAt = ? WHERE id = ?`
    )
    .run(status, new Date().toISOString(), taskId);
}

// --------------------------- 提案 ---------------------------

export interface StoredProposal {
  proposal: Proposal;
  /** 服务端权威载荷 —— 执行时从这里读取，绝不信任决策请求带来的参数 */
  payload: Record<string, unknown>;
  payloadHash: string;
}

export interface CreateProposalInput {
  taskId: string;
  actionType: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  environment: 'sandbox';
  title: string;
  summary: string;
  effects: EffectPreview[];
  missingDependencies: string[];
  requiredCapabilities: string[];
  evidence: ScheduleProvenance[];
  payloadKind: Proposal['payloadKind'];
  payloadView: Record<string, unknown>;
  canExecute: boolean;
  cannotExecuteReason: string | null;
  /** 提案有效期（毫秒），默认 30 分钟 */
  ttlMs?: number;
}

export function createOpsProposal(input: CreateProposalInput): Proposal {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + (input.ttlMs ?? 30 * 60 * 1000)).toISOString();
  const id = opsId('prop');
  // 版本 = 同任务内递增；重新准备（编辑后）生成新版本，旧版本自动作废
  const vRow = getDb()
    .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ops_proposals WHERE taskId = ?`)
    .get(input.taskId) as Record<string, unknown>;
  const version = Number(vRow['v']);
  getDb()
    .prepare(
      `INSERT INTO ops_proposals (id, taskId, actionType, version, state, payload, payloadHash, environment,
        title, summary, effects, missingDeps, requiredCaps, evidence, payloadKind, payloadView,
        canExecute, cannotReason, expiresAt, createdAt)
       VALUES (?, ?, ?, ?, 'awaiting_confirmation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.taskId,
      input.actionType,
      version,
      JSON.stringify(input.payload),
      input.payloadHash,
      input.environment,
      input.title,
      input.summary,
      JSON.stringify(input.effects),
      JSON.stringify(input.missingDependencies),
      JSON.stringify(input.requiredCapabilities),
      JSON.stringify(input.evidence),
      input.payloadKind,
      JSON.stringify(input.payloadView),
      input.canExecute ? 1 : 0,
      input.cannotExecuteReason,
      expiresAt,
      createdAt
    );
  // 新版本就绪后，同任务旧提案一律过期（批准不能跨版本，任务书 §9.3）
  getDb()
    .prepare(`UPDATE ops_proposals SET state = 'expired' WHERE taskId = ? AND id != ? AND state = 'awaiting_confirmation'`)
    .run(input.taskId, id);
  return {
    proposalId: id,
    taskId: input.taskId,
    actionType: input.actionType,
    version,
    state: 'awaiting_confirmation',
    executionEnvironment: input.environment,
    canExecute: input.canExecute,
    cannotExecuteReason: input.cannotExecuteReason,
    title: input.title,
    summary: input.summary,
    effects: input.effects,
    missingDependencies: input.missingDependencies,
    requiredCapabilities: input.requiredCapabilities,
    createdAt,
    expiresAt,
    evidence: input.evidence,
    payloadKind: input.payloadKind,
    payloadView: input.payloadView
  };
}

function rowToProposal(r: Record<string, unknown>): StoredProposal {
  return {
    proposal: {
      proposalId: String(r['id']),
      taskId: String(r['taskId']),
      actionType: String(r['actionType']),
      version: Number(r['version']),
      state: String(r['state']) as ProposalState,
      executionEnvironment: String(r['environment']) as Proposal['executionEnvironment'],
      canExecute: Number(r['canExecute']) === 1,
      cannotExecuteReason: r['cannotReason'] ? String(r['cannotReason']) : null,
      title: String(r['title']),
      summary: String(r['summary']),
      effects: JSON.parse(String(r['effects'])) as EffectPreview[],
      missingDependencies: JSON.parse(String(r['missingDeps'])) as string[],
      requiredCapabilities: JSON.parse(String(r['requiredCaps'])) as string[],
      createdAt: String(r['createdAt']),
      expiresAt: String(r['expiresAt']),
      evidence: JSON.parse(String(r['evidence'])) as ScheduleProvenance[],
      payloadKind: String(r['payloadKind']) as Proposal['payloadKind'],
      payloadView: JSON.parse(String(r['payloadView'])) as Record<string, unknown>
    },
    payload: JSON.parse(String(r['payload'])) as Record<string, unknown>,
    payloadHash: String(r['payloadHash'])
  };
}

export function getOpsProposal(proposalId: string): StoredProposal | null {
  const row = getDb().prepare(`SELECT * FROM ops_proposals WHERE id = ?`).get(proposalId) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

export function getLatestProposalForTask(taskId: string): StoredProposal | null {
  const row = getDb()
    .prepare(`SELECT * FROM ops_proposals WHERE taskId = ? ORDER BY version DESC LIMIT 1`)
    .get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

/**
 * 该会话仍在等待本人确认的提案（只读投影用）。
 * 只返回最小字段：快照不需要提案正文，避免把业务参数带出到诊断接口。
 */
export function listAwaitingProposalsForConversation(
  conversationId: string
): Array<{ taskId: string; proposalId: string; actionType: string; version: number }> {
  const rows = getDb()
    .prepare(
      `SELECT p.id AS proposalId, p.taskId, p.actionType, p.version
         FROM ops_proposals p JOIN ops_tasks t ON t.id = p.taskId
        WHERE t.conversationId = ? AND p.state = 'awaiting_confirmation'
        ORDER BY p.taskId ASC, p.version ASC`
    )
    .all(conversationId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    taskId: String(r['taskId']),
    proposalId: String(r['proposalId']),
    actionType: String(r['actionType']),
    version: Number(r['version'] ?? 1)
  }));
}

export function updateOpsProposalState(proposalId: string, state: ProposalState): void {
  getDb().prepare(`UPDATE ops_proposals SET state = ? WHERE id = ?`).run(state, proposalId);
}

/** 把已到期的待确认提案统一标记过期（惰性清理：每次决策/查询前调用） */
export function expireStaleProposals(): number {
  const now = new Date().toISOString();
  const r = getDb()
    .prepare(`UPDATE ops_proposals SET state = 'expired' WHERE state = 'awaiting_confirmation' AND expiresAt < ?`)
    .run(now);
  if (Number(r.changes) > 0) {
    getDb()
      .prepare(
        `UPDATE ops_tasks SET status = 'expired', revision = revision + 1, updatedAt = ?
          WHERE status = 'awaiting_confirmation'
            AND id NOT IN (SELECT taskId FROM ops_proposals WHERE state = 'awaiting_confirmation')`
      )
      .run(now);
  }
  return Number(r.changes);
}

// --------------------------- 决策 ---------------------------

export function insertOpsDecision(input: {
  proposalId: string;
  proposalVersion: number;
  decision: 'confirm' | 'reject';
  clientRequestId: string;
  actorId: string;
}): 'inserted' | 'duplicate' {
  try {
    getDb()
      .prepare(
        `INSERT INTO ops_decisions (id, proposalId, proposalVersion, decision, clientRequestId, actorId, decidedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(opsId('dec'), input.proposalId, input.proposalVersion, input.decision, input.clientRequestId, input.actorId, new Date().toISOString());
    return 'inserted';
  } catch (err) {
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') return 'duplicate';
    throw err;
  }
}

// --------------------------- 操作回执 ---------------------------

export function insertOpsOperation(input: {
  clientRequestId: string;
  proposalId: string;
  actionType: string;
  requestHash: string;
  receipt: OperationReceipt;
}): 'inserted' | 'duplicate' {
  try {
    getDb()
      .prepare(
        `INSERT INTO ops_operations (id, clientRequestId, proposalId, actionType, status, requestHash, receipt, createdAt)
         VALUES (?, ?, ?, ?, 'committed', ?, ?, ?)`
      )
      .run(input.receipt.operationId, input.clientRequestId, input.proposalId, input.actionType, input.requestHash, JSON.stringify(input.receipt), new Date().toISOString());
    return 'inserted';
  } catch (err) {
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') return 'duplicate';
    throw err;
  }
}

export function getOpsOperation(operationId: string): OperationReceipt | null {
  const row = getDb().prepare(`SELECT receipt FROM ops_operations WHERE id = ?`).get(operationId) as Record<string, unknown> | undefined;
  return row ? (JSON.parse(String(row['receipt'])) as OperationReceipt) : null;
}

export function getOpsOperationByClientRequest(clientRequestId: string): OperationReceipt | null {
  const row = getDb()
    .prepare(`SELECT receipt FROM ops_operations WHERE clientRequestId = ?`)
    .get(clientRequestId) as Record<string, unknown> | undefined;
  return row ? (JSON.parse(String(row['receipt'])) as OperationReceipt) : null;
}

export function getOpsOperationByProposal(proposalId: string): OperationReceipt | null {
  const row = getDb()
    .prepare(`SELECT receipt FROM ops_operations WHERE proposalId = ? ORDER BY createdAt DESC LIMIT 1`)
    .get(proposalId) as Record<string, unknown> | undefined;
  return row ? (JSON.parse(String(row['receipt'])) as OperationReceipt) : null;
}

// --------------------------- 审计与 outbox ---------------------------

export function insertOpsAudit(input: {
  actorId: string;
  action: string;
  objectKind: string;
  objectId: string;
  operationId?: string;
  detail?: Record<string, unknown>;
}): string {
  const id = opsId('audit');
  getDb()
    .prepare(
      `INSERT INTO ops_audit (id, actorId, action, objectKind, objectId, operationId, detail, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.actorId, input.action, input.objectKind, input.objectId, input.operationId ?? null, input.detail ? JSON.stringify(input.detail) : null, new Date().toISOString());
  return id;
}

export function insertOpsOutbox(channel: string, payload: Record<string, unknown>): void {
  getDb()
    .prepare(`INSERT INTO ops_outbox (id, channel, payload, status, attempts, createdAt) VALUES (?, ?, ?, 'delivered', 1, ?)`)
    .run(opsId('obx'), channel, JSON.stringify(payload), new Date().toISOString());
}

// --------------------------- 沙盒业务（biz_*） ---------------------------

export function insertBizIssue(input: {
  roomId: string;
  category: string;
  description: string;
  actor: SandboxActor;
  attachmentRefs: string[];
}): SandboxIssue {
  const now = new Date().toISOString();
  const id = opsId('issue');
  getDb()
    .prepare(
      `INSERT INTO biz_issues (id, roomId, category, description, reporterId, reporterRole, status, attachmentRefs, createdAt, revision)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`
    )
    .run(id, input.roomId, input.category, input.description, input.actor.id, input.actor.role, JSON.stringify(input.attachmentRefs), now);
  return {
    id,
    roomId: input.roomId,
    category: input.category,
    description: input.description,
    reporter: input.actor,
    status: 'open',
    attachmentRefs: input.attachmentRefs,
    createdAt: now,
    revision: 1
  };
}

export function listBizIssues(filters: { roomId?: string; status?: string; actorId?:string } = {}): SandboxIssue[] {
  const clauses: string[] = [];
  const args: Array<string | number | bigint | null> = [];
  if (filters.actorId || currentActor()) { clauses.push('reporterId = ?'); args.push(filters.actorId ?? currentActor()!.id); }
  if (filters.roomId) {
    clauses.push('roomId = ?');
    args.push(filters.roomId);
  }
  if (filters.status) {
    clauses.push('status = ?');
    args.push(filters.status);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM biz_issues ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY createdAt DESC`)
    .all(...args) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r['id']),
    roomId: String(r['roomId']),
    category: String(r['category']),
    description: String(r['description']),
    reporter: {
      id: String(r['reporterId']),
      role: String(r['reporterRole']) as SandboxActor['role'],
      label: String(r['reporterRole'])
    },
    status: String(r['status']) as SandboxIssue['status'],
    attachmentRefs: JSON.parse(String(r['attachmentRefs'] ?? '[]')) as string[],
    createdAt: String(r['createdAt']),
    revision: Number(r['revision'])
  }));
}

export function insertBizNotification(input: {
  title: string;
  content: string;
  level: string;
  audienceSummary: string;
  recipientCount: number | null;
  actor: SandboxActor;
}): SandboxNotification {
  const now = new Date().toISOString();
  const id = opsId('ntf');
  getDb()
    .prepare(
      `INSERT INTO biz_notifications (id, title, content, level, audienceSummary, recipientCount, publishedById, publishedByRole, publishedAt, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(id, input.title, input.content, input.level, input.audienceSummary, input.recipientCount, input.actor.id, input.actor.role, now);
  return {
    id,
    title: input.title,
    content: input.content,
    level: input.level as SandboxNotification['level'],
    audienceSummary: input.audienceSummary,
    recipientCount: input.recipientCount,
    readTracking: 'not_connected',
    status: 'published',
    publishedBy: input.actor,
    publishedAt: now,
    revision: 1
  };
}

export function insertBizClosure(input: {
  roomId: string;
  startDate: string;
  endDate: string;
  periodKeys: string[];
  reason: string;
  affectedLessons: number;
  actor: SandboxActor;
}): SandboxClosure {
  const now = new Date().toISOString();
  const id = opsId('clo');
  getDb()
    .prepare(
      `INSERT INTO biz_closures (id, roomId, startDate, endDate, periodKeys, reason, status, affectedLessons, createdById, createdByRole, createdAt, revision)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`
    )
    .run(id, input.roomId, input.startDate, input.endDate, JSON.stringify(input.periodKeys), input.reason, input.affectedLessons, input.actor.id, input.actor.role, now);
  return {
    id,
    roomId: input.roomId,
    startDate: input.startDate,
    endDate: input.endDate,
    periodKeys: input.periodKeys,
    reason: input.reason,
    status: 'active',
    affectedLessons: input.affectedLessons,
    createdBy: input.actor,
    createdAt: now,
    revision: 1
  };
}

export function insertBizDutySession(input: { roomId: string; actor: SandboxActor }): SandboxDutySession {
  const now = new Date().toISOString();
  const id = opsId('duty');
  getDb()
    .prepare(
      `INSERT INTO biz_duty_sessions (id, roomId, startedById, startedByRole, startedAt, status, checklist, handoverNote, linkedIssueIds, revision)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, '[]', 1)`
    )
    .run(id, input.roomId, input.actor.id, input.actor.role, now);
  return {
    id,
    roomId: input.roomId,
    startedBy: input.actor,
    startedAt: now,
    status: 'open',
    checklist: null,
    handoverNote: null,
    linkedIssueIds: [],
    revision: 1
  };
}

export function getBizDutySession(id: string): SandboxDutySession | null {
  const row = getDb().prepare(`SELECT * FROM biz_duty_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row['id']),
    roomId: String(row['roomId']),
    startedBy: { id: String(row['startedById']), role: String(row['startedByRole']) as SandboxActor['role'], label: String(row['startedByRole']) },
    startedAt: String(row['startedAt']),
    status: String(row['status']) as SandboxDutySession['status'],
    checklist: row['checklist'] ? (JSON.parse(String(row['checklist'])) as SandboxDutySession['checklist']) : null,
    handoverNote: row['handoverNote'] ? String(row['handoverNote']) : null,
    linkedIssueIds: JSON.parse(String(row['linkedIssueIds'] ?? '[]')) as string[],
    revision: Number(row['revision'])
  };
}

export function handOverBizDutySession(input: {
  sessionId: string;
  checklist: Array<{ key: string; label: string; state: 'done' | 'abnormal' | 'unchecked' }>;
  note: string;
  linkedIssueIds: string[];
}): SandboxDutySession | null {
  const cur = getBizDutySession(input.sessionId);
  if (!cur || cur.status !== 'open') return null;
  getDb()
    .prepare(
      `UPDATE biz_duty_sessions SET status = 'handed_over', checklist = ?, handoverNote = ?, linkedIssueIds = ?, revision = revision + 1 WHERE id = ?`
    )
    .run(JSON.stringify(input.checklist), input.note, JSON.stringify(input.linkedIssueIds), input.sessionId);
  return getBizDutySession(input.sessionId);
}

export function getBizRoomStatus(roomId: string): SandboxRoomStatus | null {
  const row = getDb().prepare(`SELECT * FROM biz_room_status WHERE roomId = ?`).get(roomId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row['id']),
    roomId: String(row['roomId']),
    status: String(row['status']) as SandboxRoomStatus['status'],
    createdBy: { id: String(row['createdById']), role: String(row['createdByRole']) as SandboxActor['role'], label: String(row['createdByRole']) },
    updatedAt: String(row['updatedAt']),
    revision: Number(row['revision'])
  };
}

/** 开门/关门状态落库：同一房间一条记录，重复登记在原记录上递增 revision */
export function upsertBizRoomStatus(input: {
  roomId: string;
  status: 'active' | 'closed';
  actor: SandboxActor;
}): SandboxRoomStatus {
  const now = new Date().toISOString();
  const existing = getBizRoomStatus(input.roomId);
  if (existing) {
    getDb()
      .prepare(`UPDATE biz_room_status SET status = ?, createdById = ?, createdByRole = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?`)
      .run(input.status, input.actor.id, input.actor.role, now, existing.id);
    return { ...existing, status: input.status, createdBy: input.actor, updatedAt: now, revision: existing.revision + 1 };
  }
  const id = opsId('rstat');
  getDb()
    .prepare(`INSERT INTO biz_room_status (id, roomId, status, createdById, createdByRole, updatedAt, revision) VALUES (?, ?, ?, ?, ?, ?, 1)`)
    .run(id, input.roomId, input.status, input.actor.id, input.actor.role, now);
  return { id, roomId: input.roomId, status: input.status, createdBy: input.actor, updatedAt: now, revision: 1 };
}

/** 终态落库：status ∈ completed|failed|cancelled|interrupted */
/**
 * R02/C03：终态落库为**单事务**（Message + Run + Context + 会话时间），
 * 任一失败整组回滚 —— 不再出现"消息 completed、run running"的半完成。
 * Run 终态转换带当前状态条件（running/streaming 才允许写终态），终态只确认一次。
 */
export function finalizeAssistantMessage(
  messageId: string,
  runId: string,
  status: string,
  text: string,
  meta: Record<string, unknown>
): void {
  const d = getDb();
  const now = new Date().toISOString();
  const conversationId = meta['conversationId'] ? String(meta['conversationId']) : null;
  const ctx = (meta['context'] ?? null) as { labName?: string | null; date?: string | null; task?: string | null } | null;
  d.exec('BEGIN');
  try {
    const runUpd = d
      .prepare(
        `UPDATE runs SET status = ?, endedAt = ? WHERE id = ? AND status IN ('running','queued')`
      )
      .run(status, now, runId);
    const msgUpd = d
      .prepare(`UPDATE messages SET text = ?, status = ?, meta = ? WHERE id = ?`)
      .run(text, status, JSON.stringify(meta), messageId);
    if (Number(runUpd.changes) === 0 && Number(msgUpd.changes) === 0) {
      // 目标已不在可转换状态：视为幂等重放，不报错也不重复写
      d.exec('COMMIT');
      return;
    }
    if (conversationId) {
      if (ctx) {
        d.prepare(`UPDATE conversations SET lastActivityAt = ?, contextLab = COALESCE(?, contextLab), contextDate = COALESCE(?, contextDate), contextTask = COALESCE(?, contextTask) WHERE id = ?`)
          .run(now, ctx.labName ?? null, ctx.date ?? null, ctx.task ?? null, conversationId);
      } else {
        d.prepare(`UPDATE conversations SET lastActivityAt = ? WHERE id = ?`).run(now, conversationId);
      }
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// ===========================================================================
//  轮次（round）—— 删除本轮 / 回档到本轮发起前（0.6.0）
// ============================================================================
//  一轮 = 一条 user 消息 + 紧随其后、直到下一条 user 之前的全部 assistant 消息。
//  纪律：
//   · 删除与回档都只动本会话的消息与 runs，绝不触碰 ops_* 历史与 biz_* 业务表
//     （业务写入的撤销是独立的一步，见 operations/revert.ts，且必须在审计里留痕）。
//   · 上下文快照按**与 finalizeAssistantMessage 完全一致**的语义重算：
//     该函数用 COALESCE 写入 contextLab/Date/Task，所以"最后一个非空值"才是当时的真实值，
//     直接取最后一条消息的 context 会把仍有效的上下文误清空。
// ============================================================================

export interface RoundSlice {
  /** 本轮全部消息（含 user，按 ordinal 升序） */
  round: MessageRow[];
  /** 从本轮起、到会话末尾的全部消息（回档范围） */
  fromHere: MessageRow[];
  /** 本轮之后的消息（删除本轮时保持不动） */
  following: MessageRow[];
}

/** 定位 userMessageId 所属轮次；非本会话 / 非 user 消息返回 null */
export function selectRound(conversationId: string, userMessageId: string): RoundSlice | null {
  const all = getMessages(conversationId);
  const idx = all.findIndex((m) => m.id === userMessageId);
  if (idx < 0) return null;
  if (all[idx]!.role !== 'user') return null;
  let end = idx + 1;
  while (end < all.length && all[end]!.role !== 'user') end += 1;
  return { round: all.slice(idx, end), fromHere: all.slice(idx), following: all.slice(end) };
}

export interface RemovalResult {
  removedMessageIds: string[];
  removedRunIds: string[];
}

/**
 * 删除指定消息及引用它们的 runs（单事务）。runs 以 assistantMessageId 反查 ——
 * 不删的话会留下悬空的 running 记录，把会话永久锁死（createMessageWithRun 的活跃互斥）。
 */
export function deleteMessagesAndRuns(conversationId: string, messageIds: string[]): RemovalResult {
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (!ids.length) return { removedMessageIds: [], removedRunIds: [] };
  const d = getDb();
  const marks = ids.map(() => '?').join(',');
  d.exec('BEGIN');
  try {
    const runRows = d
      .prepare(`SELECT id FROM runs WHERE conversationId = ? AND assistantMessageId IN (${marks})`)
      .all(conversationId, ...ids) as Array<Record<string, unknown>>;
    const removedRunIds = runRows.map((r) => String(r['id']));
    for (const rid of removedRunIds) {
      activeRunMap.delete(rid);
      d.prepare(`DELETE FROM runs WHERE id = ?`).run(rid);
    }
    // 只报实际存在的消息，调用方据此判断"是否真的删掉了东西"（幂等重放返回空数组）
    const existing = (d
      .prepare(`SELECT id FROM messages WHERE conversationId = ? AND id IN (${marks})`)
      .all(conversationId, ...ids) as Array<Record<string, unknown>>).map((r) => String(r['id']));
    d.prepare(`DELETE FROM messages WHERE conversationId = ? AND id IN (${marks})`).run(conversationId, ...ids);
    d.prepare(`UPDATE conversations SET lastActivityAt = ? WHERE id = ?`).run(new Date().toISOString(), conversationId);
    d.exec('COMMIT');
    return { removedMessageIds: existing, removedRunIds };
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 重算会话上下文快照：对每个字段取"最近一条 assistant 消息 meta.context 中的非空值"，
 * 与 finalizeAssistantMessage 的 COALESCE 写入语义严格对应。无消息时全部清空。
 */
export function recomputeConversationContext(conversationId: string): ContextSnapshot {
  const rows = getDb()
    .prepare(`SELECT meta FROM messages WHERE conversationId = ? AND role = 'assistant' ORDER BY ordinal DESC`)
    .all(conversationId) as Array<Record<string, unknown>>;
  const ctx: ContextSnapshot = { labName: null, date: null, task: null };
  for (const r of rows) {
    if (ctx.labName && ctx.date && ctx.task) break;
    if (!r['meta']) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(String(r['meta'])) as Record<string, unknown>;
    } catch {
      continue; // 损坏的 meta 不该让回档整体失败
    }
    const c = meta['context'] as { labName?: string | null; date?: string | null; task?: string | null } | null | undefined;
    if (!c) continue;
    if (!ctx.labName && c.labName) ctx.labName = c.labName;
    if (!ctx.date && c.date) ctx.date = c.date;
    if (!ctx.task && c.task) ctx.task = c.task;
  }
  saveContext(conversationId, ctx);
  return ctx;
}

/**
 * 轮次失效：把该轮涉及的待确认提案标为 superseded（不是 expired —— 它没有过期，
 * 是被用户回档作废的），并把对应任务置为 cancelled 时一并返回。
 * 已执行（executed）的提案不动：业务写入的撤销走 revert 通道。
 */
export function supersedePendingProposals(proposalIds: string[]): string[] {
  const out: string[] = [];
  const stmt = getDb().prepare(`UPDATE ops_proposals SET state = 'superseded' WHERE id = ? AND state = 'awaiting_confirmation'`);
  for (const id of [...new Set(proposalIds.filter(Boolean))]) {
    if (Number(stmt.run(id).changes) > 0) out.push(id);
  }
  return out;
}

/** 任务置为 cancelled（已完成/已失败的保持原状 —— 那是既成事实，不该被回档改写） */
export function cancelOpsTasks(taskIds: string[]): string[] {
  const out: string[] = [];
  const stmt = getDb().prepare(`UPDATE ops_tasks SET status = 'cancelled', revision = revision + 1, updatedAt = ? WHERE id = ? AND status IN ('awaiting_confirmation','expired')`);
  const now = new Date().toISOString();
  for (const id of [...new Set(taskIds.filter(Boolean))]) {
    if (Number(stmt.run(now, id).changes) > 0) out.push(id);
  }
  return out;
}

// --------------------------- 沙盒业务对象的补偿（回档专用） ---------------------------

export interface BizRevertOutcome {
  objectKind: string;
  objectId: string;
  action: string;
  status: 'reverted' | 'skipped';
  detail: string;
}

/** 工单：撤回为 reverted（不再是 open，日报与未结计数自然不再包含它） */
export function revertBizIssue(id: string): BizRevertOutcome {
  const r = getDb().prepare(`UPDATE biz_issues SET status = 'reverted', revision = revision + 1 WHERE id = ? AND status <> 'reverted'`).run(id);
  return { objectKind: 'issue', objectId: id, action: 'issue.revert', status: Number(r.changes) > 0 ? 'reverted' : 'skipped', detail: Number(r.changes) > 0 ? '工单已撤回，不再计为未结' : '工单不存在或已撤回，未重复处理' };
}

/** 站内通知：撤回为 reverted；outbox 投递记录一并作废 */
export function revertBizNotification(id: string): BizRevertOutcome {
  const d = getDb();
  const r = d.prepare(`UPDATE biz_notifications SET status = 'reverted', revision = revision + 1 WHERE id = ? AND status <> 'reverted'`).run(id);
  d.prepare(`UPDATE ops_outbox SET status = 'cancelled' WHERE status <> 'cancelled' AND json_extract(payload, '$.notificationId') = ?`).run(id);
  return {
    objectKind: 'notification',
    objectId: id,
    action: 'notification.revert',
    status: Number(r.changes) > 0 ? 'reverted' : 'skipped',
    detail: Number(r.changes) > 0 ? '站内通知已撤回（本系统内作废；已送达的告知无法收回）' : '通知不存在或已撤回，未重复处理'
  };
}

/** 房间停用：恢复为 restored（契约里既有的终态，语义就是"停用已解除"） */
export function revertBizClosure(id: string): BizRevertOutcome {
  const r = getDb().prepare(`UPDATE biz_closures SET status = 'restored', revision = revision + 1 WHERE id = ? AND status = 'active'`).run(id);
  return { objectKind: 'closure', objectId: id, action: 'closure.restore', status: Number(r.changes) > 0 ? 'reverted' : 'skipped', detail: Number(r.changes) > 0 ? '房间停用已解除' : '停用不存在或已解除，未重复处理' };
}

/** 值班会话：开班的撤销为 reverted；已交接的退回 open（等于撤销这次交接） */
export function revertBizDutySession(id: string, handedOver: boolean): BizRevertOutcome {
  const d = getDb();
  if (handedOver) {
    const r = d.prepare(`UPDATE biz_duty_sessions SET status = 'open', checklist = NULL, handoverNote = NULL, revision = revision + 1 WHERE id = ? AND status = 'handed_over'`).run(id);
    return { objectKind: 'duty_session', objectId: id, action: 'duty.handover.revert', status: Number(r.changes) > 0 ? 'reverted' : 'skipped', detail: Number(r.changes) > 0 ? '交接已撤销，值班会话回到进行中' : '值班会话不存在或不是已交接状态，未重复处理' };
  }
  const r = d.prepare(`UPDATE biz_duty_sessions SET status = 'reverted', revision = revision + 1 WHERE id = ? AND status = 'open'`).run(id);
  return { objectKind: 'duty_session', objectId: id, action: 'duty.start.revert', status: Number(r.changes) > 0 ? 'reverted' : 'skipped', detail: Number(r.changes) > 0 ? '值班已撤销' : '值班会话不存在、已交接或已撤销，未重复处理' };
}

export interface RevertRecordInput {
  conversationId: string;
  userMessageId: string;
  operationId: string;
  outcome: BizRevertOutcome;
  actorId: string;
}

/** 回档留痕：独立台账 + 审计双写，便于"回执说发生了什么 / 本表说撤回了什么"对照 */
export function recordOpsRevert(input: RevertRecordInput): void {
  const d = getDb();
  const now = new Date().toISOString();
  const id = opsId('rvk');
  d.prepare(
    `INSERT INTO ops_reverts (id, conversationId, userMessageId, operationId, objectKind, objectId, action, status, detail, actorId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.conversationId, input.userMessageId, input.operationId, input.outcome.objectKind, input.outcome.objectId, input.outcome.action, input.outcome.status, input.outcome.detail, input.actorId, now);
  insertOpsAudit({
    actorId: input.actorId,
    action: input.outcome.action,
    objectKind: input.outcome.objectKind,
    objectId: input.outcome.objectId,
    operationId: input.operationId,
    detail: { revertId: id, conversationId: input.conversationId, userMessageId: input.userMessageId, status: input.outcome.status }
  });
}

export function listOpsReverts(conversationId: string, limit = 50): Array<Record<string, unknown>> {
  return getDb()
    .prepare(`SELECT * FROM ops_reverts WHERE conversationId = ? ORDER BY createdAt DESC LIMIT ?`)
    .all(conversationId, limit) as Array<Record<string, unknown>>;
}

/** 该 operation 是否已被回档过（幂等：同一对象不重复记两次） */
export function hasRevertedOperation(operationId: string): boolean {
  const row = getDb().prepare(`SELECT id FROM ops_reverts WHERE operationId = ? AND status = 'reverted' LIMIT 1`).get(operationId);
  return Boolean(row);
}
