/**
 * 视觉回答渲染的空值防御（2026-11-06）
 * ============================================================================
 *  线上真实故障：一轮「实验室现在有几个人？摄像头识别到什么？」以
 *  `run_internal_error: 任务执行时发生未预期错误：Cannot read properties of undefined
 *   (reading 'length')` 收尾，而同一问题下一轮又正常。
 *
 *  崩溃点：`renderVisionFieldAnswer` 里 `r.detailLines.length` —— 该函数假定
 *  视觉结果一定带 detailLines。一旦结果来自别的源头（会话恢复/历史回放/字段裁剪），
 *  整个回答直接崩，用户看到的是一轮空回答。
 *
 *  这里锁两件事：① 缺 detailLines 不许抛；② 有 labs 时必须能就地重建明细。
 *  运行：node --test tests/vision-render-guard.test.ts
 */

process.env.LABOPS_AUTH_MODE = 'demo';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderVisionFieldAnswer } = await import('../server/agent/demo-engine.ts');

const lab = {
  labId: 'E312',
  online: true,
  count: 4,
  capacity: 6,
  recognized: 2,
  unknownFaces: 1,
  library: [],
  alert: false,
  ageSeconds: 10
};

test('视觉结果缺 detailLines：不抛异常，改由 labs 重建明细', () => {
  const out = renderVisionFieldAnswer({
    configured: true,
    note: 'AI 计数与底库命中是线索不是结论',
    labs: [lab]
  } as never);
  assert.match(out, /E312/);
  assert.match(out, /AI 计数 4/);
  assert.match(out, /\/6 容量/);
  assert.match(out, /已录入人脸命中 2 人/);
  assert.match(out, /线索不是结论/);
});

test('detailLines 存在时优先原样转达（不被重建覆盖）', () => {
  const out = renderVisionFieldAnswer({
    configured: true,
    labs: [lab],
    detailLines: ['● E312：AI 计数 4/6 容量 人，已录入人脸命中 2 人']
  } as never);
  assert.match(out, /● E312/);
  assert.equal(out.includes('在线，AI 计数'), false, '不应同时出现重建行');
});

test('既无明细也无房间：给出"暂无上报数据"而不是崩', () => {
  const out = renderVisionFieldAnswer({ configured: true, labs: [] } as never);
  assert.match(out, /暂无上报数据/);
});

test('未接入：如实说明未接入', () => {
  const out = renderVisionFieldAnswer({ configured: false, labs: [], detailLines: [] } as never);
  assert.match(out, /未接入/);
});
