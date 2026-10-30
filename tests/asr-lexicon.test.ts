/**
 * ASR 专有名词纠错单测
 * ============================================================================
 *  这套纠错的危险性在于"改错"比"不改"更糟：把用户说的话改写掉，等于替他表态。
 *  所以测试的重点不是"能改对"，而是"**不该改的绝不改**"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLexicon,
  correctTranscript,
  editDistance,
  lexiconFromDataset,
  normalizeForKey
} from '../server/llm/asr-lexicon.ts';

const LEX = buildLexicon({
  rooms: ['E310', 'D517', 'DEMO-A101'],
  classes: ['计工本2503', '计本2501'],
  courses: ['计算机网络原理', 'Java 程序设计']
});

test('normalizeForKey：全角/大小写/空格/连接符/中文数字都归一', () => {
  assert.equal(normalizeForKey('Ｅ３１０'), 'e310');
  assert.equal(normalizeForKey('E 310'), 'e310');
  assert.equal(normalizeForKey('e-310'), 'e310');
  assert.equal(normalizeForKey('E三一零'), 'e310');
  assert.equal(normalizeForKey('计工本二五零三'), '计工本2503');
  assert.equal(normalizeForKey('Java 程序设计'), 'java程序设计');
});

test('editDistance：精确、插删替、以及长度差剪枝', () => {
  assert.equal(editDistance('e310', 'e310'), 0);
  assert.equal(editDistance('e31o', 'e310'), 1);
  assert.equal(editDistance('e31', 'e310'), 1);
  assert.equal(editDistance('计公本2503', '计工本2503'), 1);
  assert.equal(editDistance('计算机网络基础', '计算机网络原理'), 2);
  // 长度差大于 max 直接剪枝，不白算
  assert.ok(editDistance('abc', 'abcdef', 2) > 2);
});

test('buildLexicon：去重保留首次写法，过滤过短词', () => {
  const lex = buildLexicon({ rooms: ['E310', 'E310', 'e310', ''], classes: ['AB'] });
  assert.equal(lex.length, 1, '同一房间的不同写法应合并为 1 条');
  assert.equal(lex[0]?.canonical, 'E310', '保留首次出现的标准写法');
  assert.equal(lex[0]?.kind, 'room');
});

test('lexiconFromDataset：从数据集抽房间/班级/课程，字段缺失不报错', () => {
  const lex = lexiconFromDataset({
    labs: [{ name: 'E310' }, { name: 'D517' }],
    openLabs: [{ name: 'DEMO-A101' }],
    timetable: [
      { className: '计工本2503', classNames: ['计工本2503', '计本2501'], courseName: '计算机网络原理' },
      {}
    ]
  });
  const rooms = lex.filter((e) => e.kind === 'room').map((e) => e.canonical);
  const classes = lex.filter((e) => e.kind === 'class').map((e) => e.canonical);
  assert.deepEqual(new Set(rooms), new Set(['E310', 'D517', 'DEMO-A101']));
  assert.deepEqual(new Set(classes), new Set(['计工本2503', '计本2501']));
  assert.equal(lexiconFromDataset(null).length, 0);
  assert.equal(lexiconFromDataset({}).length, 0);
});

test('房间号：中文数字、空格、大小写都纠正到标准写法', () => {
  const a = correctTranscript('e三一零今天有课吗', LEX);
  assert.equal(a.text, 'E310今天有课吗');
  assert.equal(a.corrections.length, 1);
  assert.equal(a.corrections[0]?.from, 'e三一零');
  assert.equal(a.corrections[0]?.to, 'E310');
  assert.equal(a.corrections[0]?.kind, 'room');

  assert.equal(correctTranscript('E 310 现在有人吗', LEX).text, 'E310 现在有人吗');
  assert.equal(correctTranscript('去d五幺七看看', LEX).text, '去D517看看');
});

test('房间号：等长条件下 1 位误识能纠；被截断的候选绝不去"补全"', () => {
  // 等长替换（错一个数字）是真实误识形态 → 纠正
  assert.equal(correctTranscript('D527 有人吗', LEX).text, 'D517 有人吗');

  // 正则只能截到「D51」，3 字候选不得模糊匹配成 4 字的 D517，
  // 否则会输出「D517T」——把对的改错，比不改更糟
  assert.equal(correctTranscript('D51T 有人吗', LEX).text, 'D51T 有人吗');
});

test('★ 不该改的一律不改：裸数字、日期、已正确的文本', () => {
  // 没有字母前缀的裸数字：可能是容量、日期、学号，绝不猜
  assert.equal(correctTranscript('310今天有课吗', LEX).text, '310今天有课吗');
  assert.equal(correctTranscript('2026-10-30 的课表', LEX).text, '2026-10-30 的课表');
  // 已经是对的 → 不产生任何 correction
  const ok = correctTranscript('E310今天有课吗', LEX);
  assert.equal(ok.text, 'E310今天有课吗');
  assert.equal(ok.corrections.length, 0);
  // 库里没有的房间号 → 原样保留，不硬套最近的一个
  assert.equal(correctTranscript('E999 有课吗', LEX).text, 'E999 有课吗');
});

test('班级名/课程名：1 字误差可纠，2 字误差不动', () => {
  const cls = correctTranscript('查一下计公本2503的课', LEX);
  assert.equal(cls.text, '查一下计工本2503的课');
  assert.equal(cls.corrections[0]?.kind, 'class');

  // 课程名少一个空格 + 大小写不规范 → 归一后命中
  const course = correctTranscript('讲java程序设计', LEX);
  assert.equal(course.text, '讲Java 程序设计');

  // 「基础」vs「原理」差 2 字 → 超出容忍，必须不动
  assert.equal(correctTranscript('讲计算机网络基础', LEX).text, '讲计算机网络基础');
});

test('★ 超出改动上限则整段放弃，不做改一半的不可控改写', () => {
  const noisy = 'e三一零'.repeat(12);
  const r = correctTranscript(noisy, LEX);
  assert.equal(r.aborted, true);
  assert.equal(r.text, noisy, '放弃时必须原样返回');
  assert.equal(r.corrections.length, 0);
});

test('空词表 / 空文本：直接原样返回', () => {
  assert.equal(correctTranscript('e三一零今天有课吗', []).text, 'e三一零今天有课吗');
  assert.deepEqual(correctTranscript('', LEX).corrections, []);
});

test('多次纠错位置正确，且不破坏其余文字', () => {
  const r = correctTranscript('E 310 和 d五幺七 都要查', LEX);
  assert.equal(r.text, 'E310 和 D517 都要查');
  assert.equal(r.corrections.length, 2);
  // 下标基于原文，可追溯
  assert.equal(r.text.slice(r.corrections[0]!.at, r.corrections[0]!.at + r.corrections[0]!.to.length), 'E310');
});
