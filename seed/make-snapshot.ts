/**
 * 从真实 state.json 生成【脱敏快照】seed/snapshot.json
 * ============================================================================
 *  用法：
 *    npx tsx seed/make-snapshot.ts <源 state.json 绝对路径> [输出路径]
 *
 *  脱敏原则（比原规格书更严，原因见下）：
 *    1. 【最小数据面】第一阶段的 query_schedule 只需要 实验室 + 课表 + 学期配置。
 *       users / classRoster / keys / notifications / gamification **一个字段都不进快照**。
 *       原规格书 §4.1 的脚本会把 classRoster 的姓名与学号带进公开仓库，本脚本直接整表丢弃。
 *    2. 【字段名纠错】原规格书假设名册字段是 studentId，实际线上 data 里叫 **sno**，
 *       而且是完整 12 位学号。原脚本 `String(r.studentId).slice(-4)` 取不到值 →
 *       两条路都危险（要么报错要么原样泄漏）。本脚本不碰该表，从根上避免。
 *    3. 【补上漏项】原规格书漏了 timetable.teacher —— 真实课表里有 73 个真实教师姓名。
 *       本脚本对教师做稳定伪名化（教师T01、教师T02…）。
 *    4. 自检：生成后扫描产物，确认不含 11 位手机号、12 位学号、以及源里出现过的任何
 *       真实教师姓名。任一命中即 exit(1) 且不写文件。
 *
 *  ⚠️ 只读不写源文件；产出的是**另一个文件**。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

type Any = Record<string, unknown>;

// ⚠️ 必须用 fileURLToPath。早先手写 `new URL(import.meta.url).pathname` 在 Windows 上
// 不会还原 %20，结果在 `D:/Web%20Project/…` 下建了一整棵错误目录树（已清理）。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const KEY_LAB_KEYS = ['id', 'sortOrder', 'name', 'location', 'capacity', 'status', 'description'] as const;
const TIMETABLE_KEYS = [
  'id', 'term', 'classNames', 'className', 'courseId', 'courseName',
  'labId', 'labName', 'weekday', 'periodKey', 'weeks', 'status', 'updatedAt'
] as const;

function pick<T extends Any>(o: T, keys: readonly string[]): Any {
  const out: Any = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** 稳定伪名化：同一次导出内，同一真名 → 同一伪名（保证关联性，且不可逆） */
function makeTeacherPseudonymizer(teachers: string[]) {
  const map = new Map<string, string>();
  teachers
    .slice()
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .forEach((name, i) => map.set(name, `教师T${String(i + 1).padStart(2, '0')}`));
  return (real: unknown): string => {
    const s = typeof real === 'string' ? real.trim() : '';
    if (!s) return '';
    return map.get(s) ?? '教师T99';
  };
}

function main() {
  const srcPath = process.argv[2];
  if (!srcPath) {
    console.error('[seed] 缺少参数：源 state.json 路径');
    console.error('用法： npx tsx seed/make-snapshot.ts <源 state.json> [输出]');
    process.exit(2);
  }
  const outPath = process.argv[3] || path.join(PROJECT_ROOT, 'seed', 'snapshot.json');

  // 落点自检：默认输出必须落在项目内，否则会像上面那条注释说的那样建到别处去
  if (!process.argv[3] && !path.resolve(outPath).startsWith(PROJECT_ROOT + path.sep)) {
    console.error('[seed] 输出路径异常，已中止：', outPath);
    process.exit(2);
  }

  const absSrc = path.resolve(srcPath);
  if (!fs.existsSync(absSrc)) {
    console.error('[seed] 源文件不存在：', absSrc);
    process.exit(2);
  }

  const buf = fs.readFileSync(absSrc);
  const sourceSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const parsed = JSON.parse(buf.toString('utf8')) as Any;
  const st = ((parsed['state'] as Any) ?? parsed) as Any;

  const users = (st['users'] as Any[]) ?? [];
  const labsRaw = (st['labs'] as Any[]) ?? [];
  const openLabsRaw = (st['openLabs'] as Any[]) ?? [];
  const timetableRaw = (st['timetable'] as Any[]) ?? [];
  const cfg = (st['sysConfig'] as Any) ?? {};

  // 先收集全部真实教师姓名，再统一伪名化
  const realTeachers = Array.from(
    new Set(timetableRaw.map((t) => String(t['teacher'] ?? '').trim()).filter(Boolean))
  );
  const pseudoTeacher = makeTeacherPseudonymizer(realTeachers);

  const labs = labsRaw.map((l) => pick(l, KEY_LAB_KEYS));
  const openLabs = openLabsRaw.map((l) => pick(l, KEY_LAB_KEYS));
  const timetable = timetableRaw.map((t) => {
    const row = pick(t, TIMETABLE_KEYS);
    row['teacher'] = pseudoTeacher(t['teacher']);
    return row;
  });

  const snapshot = {
    meta: {
      format: 'labops-agent/snapshot@1',
      sourceType: 'snapshot',
      sourceLabel: '脱敏快照',
      generatedAt: new Date().toISOString(),
      generatedBy: 'seed/make-snapshot.ts',
      sourceFileBasename: path.basename(absSrc),
      sourceFileBytes: buf.length,
      /** 只留前 16 位：够做「这份快照对应哪一版数据」的追溯，不构成完整指纹 */
      sourceSha256Prefix: sourceSha256.slice(0, 16),
      /** 顶层键白名单：明确列出**故意丢弃**了哪些表，避免以后有人以为漏导了 */
      includedTables: ['sysConfig', 'labs', 'openLabs', 'timetable', 'scheduleAdjust (public fields)'],
      droppedTables: [
        'users', 'classRoster', 'keys', 'courses', 'classes',
        'checkinRecords', 'volunteerRecords', 'openLabRecords',
        'notifications', 'openLabStatus', 'gamification'
      ],
      dropReason: '脱敏快照只用于公开排课查询；身份、签到、钥匙、通知与业务流程通过授权接口读取，不进入快照',
      redaction: {
        teacher: '稳定伪名化（教师T01…，同次导出内一致，不可逆）',
        dropped: ['真实姓名', '手机号', '学号(sno)', '用户名', '钥匙持有人', '凭据/会话'],
        keptNote: '房间号、班级代号（计本2501 等）、课程名属于机构信息而非个人信息，原样保留'
      },
      counts: {
        sourceUsers: users.length,
        sourceTeachersRedacted: realTeachers.length,
        labs: labs.length,
        openLabs: openLabs.length,
        timetable: timetable.length
      }
    },
    term: {
      term: cfg['term'] ?? '',
      termStart: cfg['termStart'] ?? null,
      termEnd: cfg['termEnd'] ?? null,
      specialDays: Array.isArray(cfg['specialDays']) ? cfg['specialDays'] : [],
      holidays: Array.isArray(cfg['holidays']) ? cfg['holidays'] : [],
      labMismatchPolicy: cfg['labMismatchPolicy'] ?? 'warn'
    },
    labs,
    openLabs,
    timetable,
    scheduleAdjust: ((st['scheduleAdjust'] as Any[]) ?? []).map(a => pick(a, ['id', 'date', 'timetableId', 'action', 'toLabId', 'toPeriodKey', 'status']))
  };

  // ---- 残留自检（A5 要求：导出后必须能证明没有真实姓名/手机号/学号残留）----
  const text = JSON.stringify(snapshot, null, 2);
  const problems: string[] = [];

  const phoneHits = text.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g);
  if (phoneHits) problems.push(`疑似手机号 ${phoneHits.length} 处：${phoneHits.slice(0, 3).join(', ')}`);

  const snoHits = text.match(/(?<!\d)\d{10,14}(?!\d)/g);
  if (snoHits) problems.push(`疑似学号/长数字串 ${snoHits.length} 处：${snoHits.slice(0, 3).join(', ')}`);

  const leakedTeachers = realTeachers.filter((n) => n && text.includes(n));
  if (leakedTeachers.length) {
    problems.push(`未脱敏的真实教师姓名 ${leakedTeachers.length} 个：${leakedTeachers.slice(0, 5).join(', ')}`);
  }

  // users / classRoster 的姓名也扫一遍（虽然整表都丢了，双保险）
  const userNames = users.map((u) => String(u['name'] ?? '').trim()).filter((n) => n.length >= 2);
  const leakedUsers = userNames.filter((n) => text.includes(n));
  if (leakedUsers.length) problems.push(`未脱敏的用户姓名 ${leakedUsers.length} 个`);

  for (const kw of ['sno', 'phone', 'studentId', 'credentials', 'token', 'password']) {
    if (text.includes(`"${kw}"`)) problems.push(`产物中出现敏感字段名 "${kw}"`);
  }

  if (problems.length) {
    console.error('[seed] ✗ 脱敏自检未通过，已放弃写出文件：');
    for (const p of problems) console.error('   -', p);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text + '\n', 'utf8');

  console.log('[seed] ✓ 已写出', path.relative(PROJECT_ROOT, outPath));
  console.log('[seed]   源文件         :', path.basename(absSrc), `${buf.length} B`, `sha256(前16)=${sourceSha256.slice(0, 16)}`);
  console.log('[seed]   脱敏教师       :', realTeachers.length, '个 →', pseudoTeacher(realTeachers[0] ?? ''), '…');
  console.log('[seed]   labs/openLabs  :', labs.length, '/', openLabs.length);
  console.log('[seed]   timetable      :', timetable.length, '条');
  console.log('[seed]   丢弃的表       :', snapshot.meta.droppedTables.join(', '));
  console.log('[seed]   自检           : 手机号 0 / 长数字串 0 / 真实姓名 0  ✓');
}

main();
