/**
 * 定时任务「交给 Agent 执行」——主系统侧的接线与失败边界（2026-10-31）
 * ============================================================================
 *  验证四件事：
 *    ① 只有 agent_prompt 模板能切到 agent 模式，且工具白名单只在 agent 模式下可填；
 *    ② 到点真的调了 agentRunner（带 owner / prompt / allowedTools / jobRunId）；
 *    ③ 返回的结论按 approvedEffects 投递（站内信正文 = Agent 的 answer）；
 *    ④ 失败分两类：永久失败直接 skipped（不重试烧配额），临时失败留给既有退避；
 *       没配执行通道时明确 skipped，而不是假装成功。
 *
 *  运行：node --test tests/scheduled-agent.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createScheduler, normalize } = require('../../Pages/server/scheduled-jobs.js');

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

interface Fixture {
  scheduler: any;
  state: any;
  principals: any[];
  time: number;
  advance(ms: number): void;
  create(extra?: Record<string, unknown>): any;
}

function fixture(fn: (f: Fixture) => Promise<void>, agentRunner: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-agent-run-'));
  let time = Date.parse('2030-10-07T04:00:00Z');
  let state: any = {
    labs: [{ id: 'r1', name: 'E310', status: 'active', capacity: 40 }],
    classes: [{ name: 'A' }],
    sysConfig: { termStart: '2030-09-01', termEnd: '2031-01-31', holidays: [], specialDays: [] },
    timetable: [],
    dutyShifts: [],
    notifications: [],
    issueTickets: [],
    scheduledReports: [],
    scheduledReceipts: []
  };
  const principals = [{ username: 'admin', identity: 'admin', status: 'active' }];
  const scheduler = createScheduler({
    directory,
    readState: () => state,
    readPrincipals: () => principals,
    commit: (next: any) => {
      state = next;
    },
    clock: () => time,
    agentRunner: agentRunner ?? null
  });
  const f: Fixture = {
    scheduler,
    get state() {
      return state;
    },
    principals,
    get time() {
      return time;
    },
    advance: (ms: number) => {
      time += ms;
    },
    create: (extra: Record<string, unknown> = {}) => {
      const plan = scheduler.dispatch({
        method: 'POST',
        path: '/scheduled-jobs/preview',
        actor: principals[0],
        body: {
          spec: {
            kind: 'agent_prompt',
            prompt: '查一下今天有哪些课，用一句话总结',
            trigger: { type: 'once', at: new Date(time + 1000).toISOString() },
            approvedEffects: ['report', 'inbox'],
            ...extra
          }
        }
      }).plan;
      return scheduler.dispatch({ method: 'POST', path: '/scheduled-jobs/confirm', actor: principals[0], body: { planId: plan.id } }).job;
    }
  };
  return (async () => {
    try {
      await fn(f);
    } finally {
      scheduler.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  })();
}

test('执行方式与工具白名单的入参边界', () => {
  const base = {
    kind: 'agent_prompt',
    prompt: '查 E310 明天的课',
    trigger: { type: 'daily', time: '20:30' },
    recipients: [{ kind: 'user', userId: 'admin' }]
  };
  const actor = { username: 'admin', identity: 'admin', className: '' };
  const users = [{ username: 'admin', identity: 'admin', status: 'active' }];
  const state = { labs: [], classes: [], sysConfig: {}, timetable: [], dutyShifts: [], notifications: [] };

  assert.equal(normalize({ ...base, execMode: 'agent' }, actor, users, state).execMode, 'agent');
  assert.equal(normalize(base, actor, users, state).execMode, 'message', '默认是只发消息');
  assert.throws(() => normalize({ ...base, execMode: 'robot' }, actor, users, state), /执行方式/);
  assert.throws(
    () => normalize({ ...base, kind: 'daily_report', prompt: undefined, execMode: 'agent' }, actor, users, state),
    /只有自定义指令/
  );
  assert.throws(() => normalize({ ...base, agentTools: ['query_schedule'] }, actor, users, state), /白名单/);
  assert.deepEqual(
    normalize({ ...base, execMode: 'agent', agentTools: ['prepare_notification', 'prepare_notification'] }, actor, users, state).agentTools,
    ['prepare_notification'],
    '白名单要去重'
  );
});

test('到点调用 Agent 并把结论投递给接收人', async () => {
  const calls: any[] = [];
  const runner = async (input: any) => {
    calls.push(input);
    return { answer: '今天 E310 有 3 节课，10:00 与 14:00 各有实验。', runId: 'run-xyz', model: 'qwen3.8-flash', toolCalls: 2 };
  };
  await fixture(async (f) => {
    const job = f.create({ execMode: 'agent' });
    f.advance(1200);
    f.scheduler.tick();
    await flush();

    assert.equal(calls.length, 1, '必须真的调了一次');
    assert.equal(calls[0].owner.id, 'admin');
    assert.equal(calls[0].prompt, '查一下今天有哪些课，用一句话总结');
    assert.deepEqual(calls[0].allowedTools, [], '没填白名单就是纯只读');
    assert.ok(calls[0].jobRunId, '必须带幂等键');

    const run = f.scheduler.db.prepare('SELECT status FROM JobRun WHERE jobId=?').get(job.id);
    assert.equal(run.status, 'success');
    assert.equal(f.state.notifications.length, 1);
    assert.match(f.state.notifications[0].content, /3 节课/);
    assert.equal(f.state.notifications[0].audience.userId, 'admin');
    assert.equal(f.state.scheduledReports.length, 1);
  }, runner);
});

test('永久失败（如白名单不存在）直接 skipped，不反复重试烧配额', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    const err: any = new Error('白名单里有不存在的工具：read_only_magic');
    err.code = 'bad_tools';
    err.permanent = true;
    throw err;
  };
  await fixture(async (f) => {
    const job = f.create({ execMode: 'agent' });
    f.advance(1200);
    f.scheduler.tick();
    await flush();
    const run = f.scheduler.db.prepare('SELECT status,error FROM JobRun WHERE jobId=?').get(job.id);
    assert.equal(run.status, 'skipped');
    assert.match(String(run.error), /bad_tools/);
    assert.equal(calls, 1, '永久失败不该重试');
  }, runner);
});

test('临时失败写回 failed 等下一轮退避，不是直接判死', async () => {
  const runner = async () => {
    const err: any = new Error('调用 Agent 失败：ECONNREFUSED');
    err.code = 'agent_unreachable';
    err.permanent = false;
    throw err;
  };
  await fixture(async (f) => {
    const job = f.create({ execMode: 'agent' });
    f.advance(1200);
    f.scheduler.tick();
    await flush();
    const run = f.scheduler.db.prepare('SELECT status,retryAt FROM JobRun WHERE jobId=?').get(job.id);
    assert.equal(run.status, 'failed');
    assert.ok(run.retryAt, '必须给下一次重试排期');
    assert.equal(f.state.notifications.length, 0);
  }, runner);
});

test('没配执行通道：明确 skipped，不假装成功', async () => {
  await fixture(async (f) => {
    const job = f.create({ execMode: 'agent' });
    f.advance(1200);
    f.scheduler.tick();
    await flush();
    const run = f.scheduler.db.prepare('SELECT status,error FROM JobRun WHERE jobId=?').get(job.id);
    assert.equal(run.status, 'skipped');
    assert.match(String(run.error), /未配置 Agent 执行通道/);
  }, null);
});
