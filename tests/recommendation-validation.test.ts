import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedRecommendation } from '../server/tools/business.ts';
import type { BusinessResult, NativeCandidate } from '../shared/business.ts';

const candidate: NativeCandidate = {
  roomId: 'room-a', roomName: '测试实验室 A', periodKey: 'pm1',
  capacity: 60, headcount: 30, requiredEquipment: [], reasons: [], eligible: true
};
const fact: BusinessResult = {
  summary: '推荐校验单元测试夹具', planId: null, source: 'test', workbenchUrl: '',
  sourceRevision: 'test-v1', candidates: [candidate]
};
const recommendation = {
  candidateId: 'room-a:pm1', capacity: 60, headcount: 30,
  reasonCodes: ['capacity', 'equipment', 'conflict_free', 'service'],
  evidenceRefs: ['snapshot:test-v1']
};
const expected = '经业务事实校验的推荐：\n测试实验室 A pm1：人数与容量满足约束；课程设备需求满足约束；房间、教师和班级在目标节次无冲突；房间开放且该节次未停用（30 人 / 容量 60；依据 snapshot:test-v1）。';
const output = (items: unknown = [recommendation]) => JSON.stringify({ recommendations: items });
const validate = (value: unknown, facts: BusinessResult[] = [fact]) => verifiedRecommendation(JSON.stringify(value), facts);
const reject = (value: unknown, facts: BusinessResult[] = [fact]) => {
  assert.equal(validate(value, facts), null, JSON.stringify(value));
};
const rejectItem = (patch: Record<string, unknown>) => reject({ recommendations: [{ ...recommendation, ...patch }] });

test('合法推荐保留原成功文案，四种理由均可用', () => {
  assert.equal(verifiedRecommendation(output(), [fact]), expected);
});

test('容量和人数可省略，成功文案仍使用候选事实', () => {
  const { capacity: _capacity, headcount: _headcount, ...minimal } = recommendation;
  assert.equal(verifiedRecommendation(output([minimal]), [fact]), expected);
  assert.equal(verifiedRecommendation(output([{ ...minimal, capacity: 60 }]), [fact]), expected);
  assert.equal(verifiedRecommendation(output([{ ...minimal, headcount: 30 }]), [fact]), expected);
});

test('允许两至三项不同候选，保持模型顺序及各自版本引用', () => {
  const facts = [fact, ...['b', 'c'].map(id => ({
    ...fact, sourceRevision: 'test-v-' + id,
    candidates: [{ ...candidate, roomId: 'room-' + id, roomName: '测试实验室 ' + id.toUpperCase() }]
  }))];
  const items = [
    { ...recommendation, candidateId: 'room-c:pm1', evidenceRefs: ['snapshot:test-v-c'] },
    recommendation,
    { ...recommendation, candidateId: 'room-b:pm1', evidenceRefs: ['snapshot:test-v-b'] }
  ];
  for (const count of [2, 3]) {
    const result = verifiedRecommendation(output(items.slice(0, count)), facts);
    assert.ok(result);
    assert.equal(result.split('\n').length, count + 1);
    assert.ok(result.indexOf('测试实验室 C') < result.indexOf('测试实验室 A'));
    if (count === 3) assert.ok(result.indexOf('测试实验室 A') < result.indexOf('测试实验室 B'));
  }
});

test('畸形 JSON、代码围栏和尾随文字均返回 null，不抛异常', () => {
  for (const text of ['', ' ', '{', '{"recommendations":', '{"recommendations":[,]}', 'undefined', '```json\n' + output() + '\n```', output() + '额外解释']) {
    assert.equal(verifiedRecommendation(text, [fact]), null, text);
  }
});

test('顶层只接受对象，拒绝 null、数组与原始值', () => {
  for (const value of [null, [], [recommendation], 'text', 1, true, false]) reject(value);
});

test('recommendations 必须存在且为 1 至 3 项数组', () => {
  for (const items of [undefined, null, false, 1, 'abc', {}, { length: 1, 0: recommendation }, []]) {
    reject({ recommendations: items });
  }
  reject({ recommendations: Array.from({ length: 4 }, (_, i) => ({ ...recommendation, candidateId: 'room-' + i + ':pm1' })) });
});

test('每项必须为对象，candidateId 必须为字符串且确有候选', () => {
  for (const item of [null, [], 'text', 1, true]) reject({ recommendations: [item] });
  for (const candidateId of [undefined, null, 1, true, [], ['room-a:pm1'], {}, '', 'made-up:pm1', 'room-a:pm2']) rejectItem({ candidateId });
});

test('拒绝顶层与推荐项的未知字段，包括原型相关键', () => {
  for (const key of ['extra', 'summary', 'reasons', '__proto__', 'constructor', 'toString']) {
    reject({ recommendations: [recommendation], [key]: {} });
    rejectItem({ [key]: {} });
  }
});

test('reasonCodes 必须为数组且每项都是许可字符串，不进行隐式转换', () => {
  for (const reasonCodes of [undefined, null, 'capacity', 1, {}, [1], [null], [true], [{}], [['capacity']], ['capacity', 'invented'], ['Capacity'], [' capacity']]) {
    rejectItem({ reasonCodes });
  }
});

test('reasonCodes 拒绝所有 Object.prototype 自有键', () => {
  for (const code of Object.getOwnPropertyNames(Object.prototype)) rejectItem({ reasonCodes: ['capacity', code] });
});

test('evidenceRefs 必须是非空字符串数组，不接受空白或非字符串项', () => {
  for (const evidenceRefs of [undefined, null, 'snapshot:test-v1', 1, {}, [], [''], [' '], [null], [1], [true], [{}], [['snapshot:test-v1']], ['snapshot:test-v1', '']]) {
    rejectItem({ evidenceRefs });
  }
});

test('拒绝容量与人数漂移及非数字值', () => {
  for (const capacity of [61, 59, 60.5, 0, -1, '60', null, true, [], {}]) rejectItem({ capacity });
  for (const headcount of [31, 29, 30.5, 0, -1, '30', null, true, [], {}]) rejectItem({ headcount });
  for (const key of ['capacity', 'headcount']) {
    const text = output().replace('"' + key + '":' + recommendation[key as 'capacity' | 'headcount'], '"' + key + '":1e400');
    const facts = [{ ...fact, candidates: [{ ...candidate, [key]: Infinity }] }];
    assert.equal(verifiedRecommendation(text, facts), null, '非有限数字不能因恰好匹配而通过');
  }
});

test('只推荐 eligible 严格为 true 的候选', () => {
  for (const eligible of [false, null, undefined, 0, 1, 'true', {}, []]) {
    const facts = [{ ...fact, candidates: [{ ...candidate, eligible }] }] as unknown as BusinessResult[];
    assert.equal(verifiedRecommendation(output(), facts), null);
  }
});

test('引用必须属于所选候选的事实版本，拒绝过期、混合或借用其他候选版本', () => {
  const otherFact = { ...fact, sourceRevision: 'test-v2', candidates: [{ ...candidate, roomId: 'room-b' }] };
  for (const evidenceRefs of [['snapshot:test-v0'], ['snapshot:test-v2'], ['snapshot:test-v1', 'snapshot:test-v2'], ['test-v1'], ['snapshot:test-v1 ']]) {
    reject({ recommendations: [{ ...recommendation, evidenceRefs }] }, [fact, otherFact]);
  }
});

test('缺失或非数组 candidates 安全忽略，不阻断后续合法事实', () => {
  const { candidates: _candidates, ...withoutCandidates } = fact;
  const incomplete = [withoutCandidates, null, {}, { ...fact, candidates: null }, { ...fact, candidates: {} }, { ...fact, candidates: 'abc' }] as unknown as BusinessResult[];
  assert.equal(verifiedRecommendation(output(), incomplete), null);
  assert.equal(verifiedRecommendation(output(), [...incomplete, fact]), expected);
  assert.equal(verifiedRecommendation(output(), [{ ...fact, candidates: [] }, fact]), expected);
});

test('候选集合中的无效项安全跳过，缺失事实集合返回 null', () => {
  const candidates = [null, undefined, false, 1, 'text', [], {}, { roomId: null }, candidate] as unknown as NativeCandidate[];
  assert.equal(verifiedRecommendation(output(), [{ ...fact, candidates }]), expected);
  for (const facts of [undefined, null, {}, 'text', []]) {
    assert.equal(verifiedRecommendation(output(), facts as BusinessResult[]), null);
  }
});

test('重复 candidateId 拒绝，不通过更换理由或省略数值绕过', () => {
  for (const duplicate of [recommendation, { candidateId: recommendation.candidateId, reasonCodes: ['service'], evidenceRefs: recommendation.evidenceRefs }]) {
    reject({ recommendations: [recommendation, duplicate] });
  }
});

test('任何一项无效都返回 null，不泄漏部分成功推荐', () => {
  reject({ recommendations: [recommendation, null] });
  reject({ recommendations: [recommendation, { ...recommendation, candidateId: 'unknown' }] });
});
