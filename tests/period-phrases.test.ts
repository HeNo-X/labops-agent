/**
 * 节次口径回归
 * ============================================================================
 *  上午第一大节=第1-2节、上午第二大节=第3-4节、下午第一大节=第5-6节、
 *  下午第二大节=第7-8节、晚上AB节、晚上CD节；单说"第5节""第7节"分别属于 56、78。
 *  缩写：上一=am1、下二=pm2、早八=am1、AB/CD。
 *
 *  这层存在的意义：用户不会写"下午第一大节"，他会说"56节""第5节""下二""早八"。
 *  口径一旦错，后面所有查询都错，所以钉死在这里。
 *
 *  运行：node --test tests/period-phrases.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriodKey, resolvePeriodRange, resolveTimeSegments } from '../server/agent/intent.ts';
import { serverNow } from '../server/time/term.ts';

test('单节数字归属正确', () => {
  for (const [q, key] of [
    ['第1节', 'am1'], ['第2节', 'am1'],
    ['第3节', 'am2'], ['第4节', 'am2'],
    ['第5节', 'pm1'], ['第6节', 'pm1'],
    ['第7节', 'pm2'], ['第8节', 'pm2']
  ] as const) {
    assert.equal(resolvePeriodKey(q), key, `${q} → ${key}`);
  }
});

test('组合写法（12/34/56/78）等价于对应大节', () => {
  assert.equal(resolvePeriodKey('第56节'), 'pm1');
  assert.equal(resolvePeriodKey('78节'), 'pm2');
  assert.equal(resolvePeriodKey('第12节'), 'am1');
  assert.equal(resolvePeriodKey('34节'), 'am2');
});

test('缩写：上一 / 上二 / 下一 / 下二 / 早八 / AB / CD', () => {
  assert.equal(resolvePeriodKey('上一'), 'am1');
  assert.equal(resolvePeriodKey('上二'), 'am2');
  assert.equal(resolvePeriodKey('下一'), 'pm1');
  assert.equal(resolvePeriodKey('下二'), 'pm2');
  assert.equal(resolvePeriodKey('早八'), 'am1');
  assert.equal(resolvePeriodKey('晚上AB节'), 'eve_ab');
  assert.equal(resolvePeriodKey('CD节'), 'eve_cd');
});

test('「上一」不等于「上一个」：否定前瞻生效', () => {
  assert.equal(resolvePeriodKey('上一个问题'), null);
  assert.equal(resolvePeriodKey('下一次'), null);
});

test('范围写法落在同一大节内 → 单节次', () => {
  assert.equal(resolvePeriodKey('5-6节'), 'pm1');
  assert.equal(resolvePeriodKey('第5~6节'), 'pm1');
  assert.equal(resolvePeriodKey('5到6节'), 'pm1');
});

test('跨大节并列 → 返回范围而不是单节', () => {
  assert.equal(resolvePeriodKey('第5、7节'), null);
  assert.deepEqual(resolvePeriodRange('第5、7节'), ['pm1', 'pm2']);
  assert.deepEqual(resolvePeriodRange('第1、7节'), ['am1', 'pm2']);
});

test('原有中文写法仍然可用（不回归）', () => {
  assert.equal(resolvePeriodKey('下午第二大节'), 'pm2');
  assert.equal(resolvePeriodKey('上午第一大节'), 'am1');
  assert.deepEqual(resolvePeriodRange('下午'), ['pm1', 'pm2']);
});

test('一句多问按段拆开：周一上二 / 周三早八+下一 各自是独立日期与节次', () => {
  const now = serverNow(new Date('2026-11-11T12:00:00+08:00'));
  const segs = resolveTimeSegments('周一上二应该是哪两个志愿者值班？周三早八和下一呢', now);
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.date, '2026-11-09');
  assert.deepEqual(segs[0]!.periodKeys, ['am2']);
  assert.equal(segs[1]!.date, '2026-11-11');
  assert.deepEqual(segs[1]!.periodKeys, ['am1', 'pm1']);
});

test('后句省略日期时承接前句，仍按各自节次拆段', () => {
  const now = serverNow(new Date('2026-11-11T12:00:00+08:00'));
  const segs = resolveTimeSegments('周一上二有课吗？下午呢', now);
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.date, '2026-11-09');
  assert.deepEqual(segs[0]!.periodKeys, ['am2']);
  assert.equal(segs[1]!.date, '2026-11-09');
  assert.deepEqual(segs[1]!.periodKeys, ['pm1', 'pm2']);
});
