/**
 * 签到红线婉拒守卫单测
 * ============================================================================
 *  refuseSignRequest 是**确定性拦截**——不进模型、不调工具，这类请求的答复
 *  与模型能力/心情无关。这里把「什么必须拒、什么必须放」钉死：
 *    · 必拒：代签 / 补录 / 签上到 / 帮同学签到（动作句式）
 *    · 必放：签到情况/记录/汇总/名单类**查询**（query_checkin_* 系列的正常入口）
 *  误报防线被破坏的话，正常查询会被婉拒——那比答非所问更糟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseSignRequest } from '../server/agent/intent.ts';

test('代签/补录/签上到类请求必须婉拒', () => {
  for (const q of [
    '请帮我给熊海诺这个同学在E310签上到；',
    '帮我给熊海诺这个同学在E310签到',
    '给 2023002 补录今天下午第一大节在 E310 的签到，原因：设备故障',
    '替我代签一下 E312 的上机课',
    '帮 2023003 补录昨天下午的签到'
  ]) {
    const r = refuseSignRequest(q);
    assert.ok(r, `${q} 必须婉拒`);
    assert.match(r, /做不了|不能代签|不能代为补录/);
    assert.match(r, /主系统|本人扫码/);
  }
});

test('婉拒话术不含任何"已代办"语义（不得把婉拒写成已执行）', () => {
  const r = refuseSignRequest('帮我给熊海诺签到')!;
  assert.doesNotMatch(r, /已签|已办理|已补录|已完成/);
});

test('签到类查询不得误伤（query_checkin_* 的正常入口）', () => {
  for (const q of [
    '帮我查一下今天的签到情况',
    '查一下 E310 的签到记录',
    '今天的签到汇总怎么样',
    'E310 现在有多少人签到',
    '这周签到名单有哪些'
  ]) {
    assert.equal(refuseSignRequest(q), null, `${q} 是查询，不得婉拒`);
  }
});

test('非签到话题不触发（守卫只对签到动作句式负责）', () => {
  for (const q of ['E310 今天有哪些课', '把 E310 关门', '生成今天的运营日报']) {
    assert.equal(refuseSignRequest(q), null);
  }
});
