/**
 * U2 用户常用词 —— 清洗与并入热词表
 * ============================================================================
 *  这条路的全部价值在于"说清它做了什么"：常用词只进**事前**通道（上下文实体词表 /
 *  原生即时热词），一个都不碰纠正层。所以测试只钉两件事：
 *    ① 不该进去的东西进不去（单字、超长、控制字符、重复、超上限）；
 *    ② 进去了也不谎报 —— 内置表与用户词撞车时谁赢、被上限截断时截掉的是谁。
 *
 *  运行：node --test tests/asr-keywords.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeKeywords, withKeywordHotwords } from '../server/llm/asr-glossary.ts';

// ---------------------------------------------------------------- 清洗
test('常用词清洗：单字、空、超长、控制字符、非字符串一律丢掉，且顺序可复现', () => {
  const out = sanitizeKeywords([
    '  稳压器  ',
    '枪', // 单字：候选面太大，说不清收益
    '',
    '   ',
    '这是一个长得超出二十四个字符上限的常用词用来验证长度过滤',
    '门禁\u0001电源', // 控制字符
    42,
    null,
    { not: 'a string' },
    '稳压器' // 与第一条同名（含 trim 后同名）只认第一条
  ]);
  assert.deepEqual(out, ['稳压器'], JSON.stringify(out));
});

test('清洗上限 100 条，超出部分不进请求（与前端同一套数字）', () => {
  const many = Array.from({ length: 150 }, (_, i) => `词${i}`);
  const out = sanitizeKeywords(many);
  assert.equal(out.length, 100, `实际 ${out.length}`);
  assert.equal(out[99], '词99');
  assert.deepEqual(sanitizeKeywords(undefined), []);
  assert.deepEqual(sanitizeKeywords('稳压器'), [], '不是数组就不猜它的意思');
});

// ---------------------------------------------------------------- 并入热词表
test('用户词权重取官方区间上限 5，并排在内置表前面（被截断时先保用户说的）', () => {
  const base = { 投影仪: 4, 服务器: 4 };
  const out = withKeywordHotwords(base, ['稳压器', '门禁电源'], 500);
  const keys = Object.keys(out);
  assert.deepEqual(keys, ['稳压器', '门禁电源', '投影仪', '服务器'], JSON.stringify(out));
  assert.equal(out['稳压器'], 5);
  assert.equal(out['投影仪'], 4, '内置表的权重不该被用户词改动');
});

test('用户词与内置表撞车时只留一条，权重取用户那一档（同一个词不许出现两个键）', () => {
  const out = withKeywordHotwords({ 投影仪: 4 }, ['投影仪', '投 影 仪'], 500);
  assert.deepEqual(Object.keys(out), ['投影仪', '投 影 仪'], JSON.stringify(out));
  assert.equal(out['投影仪'], 5, '撞车时以用户登记的那条为准（他只是想让模型更容易听对，不涉及改写）');
});

test('条数上限由 max 决定：截断发生在内置表那一段，用户词优先保留', () => {
  const out = withKeywordHotwords({ 甲甲: 4, 乙乙: 4, 丙丙: 4 }, ['丁丁', '戊戊'], 3);
  assert.deepEqual(Object.keys(out), ['丁丁', '戊戊', '甲甲'], JSON.stringify(out));
  assert.equal(Object.keys(out).length, 3);
});

test('超出官方热词长度限制的用户词不进 vocabulary（防一条长词让整表被拒）', () => {
  const long = '这是一条长度超过十五个字符上限的热词条目';
  const out = withKeywordHotwords({ 投影仪: 4 }, [long, '稳压器'], 500);
  assert.equal(out[long], undefined, '长词不该进表');
  assert.equal(out['稳压器'], 5);
});

test('max=0 时热词表为空 —— 关掉就是真的关掉，不留"构造了但没发"的中间态', () => {
  assert.deepEqual(withKeywordHotwords({ 投影仪: 4 }, ['稳压器'], 0), {});
});
