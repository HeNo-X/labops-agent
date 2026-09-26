/**
 * 第一阶段验收脚本 —— 直接打 SSE 接口，断言事件序列与结果
 * 用法：npx tsx tests/acceptance.ts [baseUrl]
 *
 * 设计原则：**不硬编码"今天"**。所有与服务端当天相关的预期都从 run_started.serverNow
 * 推导出来，否则这套测试第二天就会烂掉（这是测试代码最常见的自毁方式）。
 * 与"今天"无关的内容断言则用固定的演示日期 2026-09-30（它在快照的学期内，
 * 永远是周三 / 第 4 教学周），保证可重复。
 */

import { WEEKDAY_LABELS, PERIODS } from '../shared/periods.ts';

const BASE = process.argv[2] ?? process.env['LABOPS_BASE'] ?? 'http://127.0.0.1:8787';
/** 固定演示日期：2026-09-30 = 周三，第 4 教学周（双周）。E310 当天有 7 条排课 */
const DEMO_DATE = '2026-09-30';

interface RunEvent {
  seq: number;
  type: string;
  runId: string;
  payload: Record<string, unknown>;
}

async function chat(message: string): Promise<RunEvent[]> {
  const res = await fetch(`${BASE}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error('空响应体');

  const events: RunEvent[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        events.push(JSON.parse(dataLine.slice(6)) as RunEvent);
      } catch {
        /* 注释块或坏块，跳过 */
      }
    }
  }
  return events;
}

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function assert(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}`);
  console.log(`      ${detail}`);
}

const ev1 = (events: RunEvent[], type: string): RunEvent | undefined => events.find((e) => e.type === type);

function answerOf(events: RunEvent[]): string {
  const done = ev1(events, 'run_completed');
  if (done) return String(done.payload['answer'] ?? '');
  return events
    .filter((e) => e.type === 'answer_delta')
    .map((e) => String(e.payload['text'] ?? ''))
    .join('');
}

function resultOf(events: RunEvent[]): Record<string, unknown> | undefined {
  return ev1(events, 'tool_result')?.payload['result'] as Record<string, unknown> | undefined;
}

// ---- 与生产代码独立实现的日期小工具（故意不复用被测代码，避免"用实现验证实现"）----
function utcDate(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}
function addDays(d: string, n: number): string {
  return new Date(utcDate(d).getTime() + n * 86400000).toISOString().slice(0, 10);
}
function weekday(d: string): number {
  return utcDate(d).getUTCDay();
}
/** 含该日的那一周（周一~周日）的周一；周日归到上一个周一 */
function mondayOf(d: string): string {
  const wd = weekday(d);
  return addDays(d, wd === 0 ? -6 : 1 - wd);
}
/** 下一周的周三 */
function nextWednesday(d: string): string {
  return addDays(mondayOf(d), 7 + 2);
}

async function main(): Promise<void> {
  console.log(`LabOps Agent 第一阶段验收 —— 目标 ${BASE}\n`);

  let health: Record<string, unknown>;
  try {
    health = (await (await fetch(`${BASE}/api/agent/health`)).json()) as Record<string, unknown>;
  } catch (e) {
    console.error('服务端不可达，验收中止：', (e as Error).message);
    process.exit(1);
  }
  const cap = health['capability'] as Record<string, unknown>;
  const data = health['data'] as Record<string, unknown>;
  console.log(
    `[前置] 引擎=${String(cap['engine'])} 数据来源=${String(data['sourceLabel'])} ` +
      `房间=${(cap['rooms'] as string[]).length} 课表=${String((data['counts'] as Record<string, unknown>)['timetable'])} 条\n`
  );

  // 取得服务端"现在"，后续所有相对时间断言都从它推导
  const warm = await chat('E310 2026-09-30 有哪些课？');
  const serverNow = ev1(warm, 'run_started')?.payload['serverNow'] as Record<string, unknown>;
  const today = String(serverNow['date']);
  const todayWd = Number(serverNow['weekday']);
  console.log(`[前置] 服务端当天 = ${today}（${String(serverNow['weekdayLabel'])}，weekday=${todayWd}）\n`);

  // ================================================================= 用例 1
  console.log('[用例 1] 指定演示日期问某房间的课 —— 期望：工具调用事件 + 课程结果 + 数据来源标识');
  {
    const ev = warm;
    const tr = ev1(ev, 'tool_result');
    const r = resultOf(ev);
    const lessons = (r?.['lessons'] as unknown[]) ?? [];
    const started = ev1(ev, 'run_started');

    assert(
      '事件 seq 严格单调递增、无重复、无缺号',
      ev.every((e, i) => e.seq === i),
      `seq 应为 0..${ev.length - 1}，实际首尾 ${ev[0]?.seq}..${ev[ev.length - 1]?.seq}（共 ${ev.length} 条）`
    );
    const types = ev.map((e) => e.type);
    const idx = (t: string): number => types.indexOf(t);
    assert(
      '事件顺序 run_started → tool_started → tool_result → answer_delta → run_completed → end',
      idx('run_started') === 0 &&
        idx('tool_started') > idx('run_started') &&
        idx('tool_result') > idx('tool_started') &&
        idx('answer_delta') > idx('tool_result') &&
        idx('run_completed') > idx('answer_delta') &&
        idx('end') === ev.length - 1,
      `下标 ${['run_started', 'tool_started', 'tool_result', 'answer_delta', 'run_completed', 'end'].map((t) => `${t}=${idx(t)}`).join(' ')}`
    );
    assert('run_started 带数据来源标识', started?.payload['sourceType'] === 'snapshot', `sourceType=${String(started?.payload['sourceType'])}（脱敏快照）`);
    assert('调用了 query_schedule', ev1(ev, 'tool_started')?.payload['tool'] === 'query_schedule', String(ev1(ev, 'tool_started')?.payload['tool']));
    assert('工具调用成功', tr?.payload['ok'] === true, String(tr?.payload['summary']).slice(0, 70) + '…');
    assert('返回 7 条排课（合班已按班展开）', lessons.length === 7, `lessons=${lessons.length}`);
    assert('周次解算正确：第 4 教学周且可确定', r?.['weekNo'] === 4 && r?.['weekDeterminable'] === true, `weekNo=${String(r?.['weekNo'])} determinable=${String(r?.['weekDeterminable'])}`);
    const am2 = (r?.['byPeriod'] as Array<Record<string, unknown>>).find((p) => p['periodKey'] === 'am2');
    assert('单双周过滤生效：该房间 am2 是单周课，双周（第 4 周）应为 0', am2?.['count'] === 0, `am2 count=${String(am2?.['count'])}（对照：该房间周三共 37 条记录里的 odd 那条被正确排除）`);
    assert(
      '结果按节次排序且六节次齐全',
      (r?.['byPeriod'] as unknown[]).length === PERIODS.length,
      `byPeriod 长度 ${(r?.['byPeriod'] as unknown[]).length}`
    );
    assert('教师已脱敏（教师Txx 形式）', lessons.length > 0 && /^教师T\d{2}$/.test(String((lessons[0] as Record<string, unknown>)['teacher'])), String((lessons[0] as Record<string, unknown>)['teacher']));
    const prov = r?.['provenance'] as Record<string, unknown>;
    assert('结果带来源、查询时间与覆盖范围说明', Boolean(prov?.['sourceLabel'] && prov?.['queryTime'] && prov?.['coverage']), `${String(prov?.['sourceLabel'])}｜${String(prov?.['queryTime'])}`);
    assert('回答里明确写出数据来源标签', answerOf(ev).includes('脱敏快照'), answerOf(ev).split('\n').filter((l) => l.includes('数据来源'))[0] ?? '');
  }

  // ================================================================= 用例 2
  console.log('\n[用例 2] 不存在的房间号 E999 —— 期望：明确无匹配，不编造课程');
  {
    const ev = await chat(`E999 ${DEMO_DATE} 有哪些课？`);
    const r = resultOf(ev);
    const answer = answerOf(ev);
    assert('reason = lab_not_found', r?.['reason'] === 'lab_not_found', String(r?.['reason']));
    assert('lessons 为空', ((r?.['lessons'] as unknown[]) ?? []).length === 0, 'lessons=0');
    assert('给出候选房间号而不是编造', ((r?.['suggestions'] as string[]) ?? []).includes('E310'), `候选 ${(r?.['suggestions'] as string[])?.length} 个，含 E310`);
    assert('回答明确说没有收录该房间号', answer.includes('没有收录这个房间号'), answer.split('\n')[0]);
    assert('回答未出现任何课程名（未编造）', !/程序设计|计算机网络|操作系统|数据库/.test(answer), '未出现课程名');
  }

  // ================================================================= 用例 3
  console.log('\n[用例 3] 今天 —— 期望：日期解算为服务端当天，结果如实（有课说课、无课说无课）');
  {
    const ev = await chat('E310 今天有哪些课？');
    const r = resultOf(ev);
    const answer = answerOf(ev);
    assert('日期 = 服务端当天', r?.['date'] === today, `${String(r?.['date'])} vs ${today}`);
    assert('星期标签与服务端一致', r?.['weekdayLabel'] === WEEKDAY_LABELS[todayWd], `${String(r?.['weekdayLabel'])}（weekday=${todayWd}）`);
    const lessons = (r?.['lessons'] as unknown[]) ?? [];
    const expectedNoClass = lessons.length === 0;
    assert(
      '有课则给出课程、无课则明确说没有课（二者必居其一，不允许含糊）',
      expectedNoClass ? answer.includes('没有课') : answer.includes('共有'),
      `${expectedNoClass ? '无课' : `${lessons.length} 条排课`}：${answer.split('\n')[0]}`
    );
    assert('weekDeterminable 与 termStart 配置一致', r?.['weekDeterminable'] === true, `weekNo=${String(r?.['weekNo'])}`);
  }

  // ================================================================= 用例 4
  console.log('\n[用例 4] 断网/服务端不可达 —— 期望：前端能拿到明确失败，不无限加载');
  {
    // 服务端侧只能验证"错误路径有明确的 HTTP 状态码"，前端侧由 tests/ 之外的浏览器验收覆盖
    const res = await fetch(`${BASE}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert('空 message → 400 且带错误码', res.status === 400, `HTTP ${res.status} ${JSON.stringify(await res.json())}`);

    const res2 = await fetch(`${BASE}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ 这不是合法 JSON'
    });
    assert('非法 JSON → 400 且带错误码', res2.status === 400, `HTTP ${res2.status} ${JSON.stringify(await res2.json())}`);

    const res3 = await fetch(`${BASE}/api/agent/nope`);
    assert('未知接口 → 404 且带错误码', res3.status === 404, `HTTP ${res3.status} ${JSON.stringify(await res3.json())}`);
  }

  // ================================================================= 用例 5
  console.log('\n[用例 5] 能力外问题 —— 期望：明确说第一阶段做不到，不编造、不假装查过');
  {
    const ev = await chat('D526 现在几个人？');
    const answer = answerOf(ev);
    assert('未调用任何工具（不该拿课表工具硬凑人数）', ev1(ev, 'tool_started') === undefined, 'tool_started 不存在');
    assert('明确说明未接入', /未接入|做不到|不包含/.test(answer), answer.split('\n')[0]);
    const done = ev1(ev, 'run_completed');
    assert('正常收尾（run_completed，不是 run_failed）', done !== undefined && ev1(ev, 'run_failed') === undefined, `toolCalls=${String(done?.payload['toolCalls'])}`);
  }

  // ================================================================= 用例 6
  console.log('\n[用例 6] 中文时间指代 —— 期望：服务端解算出精确日期且依据可追溯');
  {
    const expected = nextWednesday(today);
    const ev = await chat('下周三 D517 有哪些课？');
    const hint = ev1(ev, 'run_started')?.payload['resolvedTimeHint'] as Record<string, unknown>;
    assert(`"下周三" → ${expected}`, hint?.['date'] === expected, String(hint?.['source']));

    const ev2 = await chat('D517 昨天有哪些课？');
    const r2 = resultOf(ev2);
    assert(`"昨天" → ${addDays(today, -1)}`, r2?.['date'] === addDays(today, -1), String(r2?.['date']));

    const ev3 = await chat(`E310 ${DEMO_DATE} 上午第一大节有哪些课？`);
    const r3 = resultOf(ev3);
    assert('节次精确指代："上午第一大节" → 只查 am1', r3?.['periodFilter'] === 'am1' && ((r3?.['lessons'] as unknown[]) ?? []).length === 2, `periodFilter=${String(r3?.['periodFilter'])} lessons=${((r3?.['lessons'] as unknown[]) ?? []).length}`);
  }

  // ================================================================= 用例 7
  console.log('\n[用例 7] 单双周对齐验证 —— 期望：同一门单周课在第 5 周出现、第 4 周不出现');
  {
    const r4 = resultOf(await chat(`E310 ${DEMO_DATE} 有哪些课？`));
    const wk5 = addDays(DEMO_DATE, 7); // 2026-10-07，第 5 教学周（单周）
    const r5 = resultOf(await chat(`E310 ${wk5} 有哪些课？`));
    const countOf = (r: Record<string, unknown> | undefined, key: string): number =>
      ((r?.['byPeriod'] as Array<Record<string, unknown>>) ?? []).find((p) => p['periodKey'] === key)?.['count'] as number;
    assert(`第 4 周（双周）am2 无课`, countOf(r4, 'am2') === 0, `am2=${countOf(r4, 'am2')}`);
    assert(`第 5 周（单周）am2 有课（计工本2501/2502 计算机组成原理）`, countOf(r5, 'am2') === 2, `am2=${countOf(r5, 'am2')}`);
    assert('两周的课表条数不同（证明单双周真的在起作用）', ((r4?.['lessons'] as unknown[]) ?? []).length !== ((r5?.['lessons'] as unknown[]) ?? []).length, `第4周 ${((r4?.['lessons'] as unknown[]) ?? []).length} 条 vs 第5周 ${((r5?.['lessons'] as unknown[]) ?? []).length} 条`);
  }

  // ================================================================= 汇总
  const pass = checks.filter((c) => c.pass).length;
  const total = checks.length;
  console.log('\n────────────────────────────────────────────');
  console.log(`验收结果：${pass}/${total} PASS`);
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  }
  console.log('────────────────────────────────────────────');
  process.exit(failed.length ? 1 : 0);
}

void main();
