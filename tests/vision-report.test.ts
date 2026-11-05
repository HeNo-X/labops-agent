/**
 * 视觉边缘上报单元测试（契约 v2）—— 全部纯逻辑（内存 + 签名），无网络、无磁盘写入
 * ============================================================================
 *  覆盖：HMAC 签名与防重放、v2 载荷白名单归一化（faces/library/capacity）、
 *  v1 兼容接收（ppe_summary 被忽略）、新告警口径（超容量/离线；底库命中不是告警）、
 *  环上限、快照约束、状态查询输出。持久化在测试中关闭（resetVisionStoreForTests）。
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  coerceVisionReport,
  ingestVisionReport,
  isAlertReport,
  MAX_SNAPSHOT_BYTES,
  resetVisionStoreForTests,
  signVisionPayload,
  verifyVisionSignature,
  visionEvents,
  visionIngestConfigured,
  visionSnapshot,
  visionStatus
} from '../server/vision/monitor.ts';

const SECRET = 'unit-test-secret';
const savedSecret = process.env.VISION_INGEST_SECRET;
process.env.VISION_INGEST_SECRET = SECRET;
afterEach(() => {
  resetVisionStoreForTests();
  if (savedSecret === undefined) delete process.env.VISION_INGEST_SECRET;
  else process.env.VISION_INGEST_SECRET = savedSecret;
});

/** v2 标准载荷（与 Vision 侧 schemas.report_payload v2 对齐） */
function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    lab_id: 'E310',
    ts: Math.floor(Date.now() / 1000),
    count: 3,
    capacity: 40,
    faces: { recognized: 2, unknown: 1 },
    library: [],
    camera_online: true,
    quality: { det: 'yolo26n' },
    ...overrides
  };
}

/** 断言成功并取出 VisionReport（失败时测试直接报错） */
function reportOf(overrides: Record<string, unknown> = {}) {
  const coerced = coerceVisionReport(baseReport(overrides));
  assert.ok(coerced.ok, 'baseReport 应当始终可归一化');
  return coerced.value;
}

describe('HMAC 签名与防重放', () => {
  it('正确签名通过校验', () => {
    resetVisionStoreForTests();
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'a1b2c3d4e5f6';
    const raw = JSON.stringify(baseReport());
    const signature = signVisionPayload(SECRET, ts, nonce, raw);
    assert.deepEqual(verifyVisionSignature(SECRET, ts, nonce, raw, signature), { ok: true });
  });

  it('篡改载荷、错误密钥、缺字段均拒绝', () => {
    resetVisionStoreForTests();
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'a1b2c3d4e5f6';
    const raw = JSON.stringify(baseReport());
    const signature = signVisionPayload(SECRET, ts, nonce, raw);
    assert.equal(verifyVisionSignature(SECRET, ts, nonce, raw + ' ', signature).ok, false);
    assert.equal(verifyVisionSignature('wrong-secret', ts, nonce, raw, signature).ok, false);
    assert.equal(verifyVisionSignature(SECRET, 'not-a-number', nonce, raw, signature).ok, false);
    assert.equal(verifyVisionSignature(SECRET, ts, 'short', raw, signature).ok, false);
  });

  it('超出 ±300 秒时间窗判 stale_timestamp', () => {
    resetVisionStoreForTests();
    const ts = Math.floor(Date.now() / 1000) - 400;
    const nonce = 'a1b2c3d4e5f6';
    const raw = '{}';
    const signature = signVisionPayload(SECRET, ts, nonce, raw);
    const check = verifyVisionSignature(SECRET, ts, nonce, raw, signature);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.code, 'stale_timestamp');
  });

  it('同一 nonce 二次使用判 replayed', () => {
    resetVisionStoreForTests();
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'b1b2c3d4e5f6';
    const raw = '{}';
    const signature = signVisionPayload(SECRET, ts, nonce, raw);
    assert.equal(verifyVisionSignature(SECRET, ts, nonce, raw, signature).ok, true);
    const check = verifyVisionSignature(SECRET, ts, nonce, raw, signature);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.code, 'replayed');
  });
});

describe('载荷归一化（v2 白名单 + v1 兼容）', () => {
  it('v2：faces/library/capacity 正确归一化，未知顶层字段剥离（身份嫌疑字段进不来）', () => {
    resetVisionStoreForTests();
    const coerced = coerceVisionReport(baseReport({
      faces: { recognized: 3, unknown: 1 },
      library: [
        { kind: 'item', name: '投影仪遥控器', score: 0.94, mode: 'whole' },
        { kind: 'scene', name: 'E310 讲台区域', score: 0.91, mode: 'partial' }
      ],
      capacity: 40,
      // 以下全是"想夹带身份"的字段，必须被白名单挡掉
      names: ['张三'],
      face_names: ['李四'],
      operator: 'someone'
    }));
    assert.equal(coerced.ok, true);
    if (coerced.ok) {
      assert.equal(coerced.value.v, 2);
      assert.deepEqual(coerced.value.faces, { recognized: 3, unknown: 1 });
      assert.equal(coerced.value.library.length, 2);
      assert.equal(coerced.value.library[0].name, '投影仪遥控器');
      assert.equal(coerced.value.capacity, 40);
      assert.equal(!('names' in coerced.value), true);
      assert.equal(!('face_names' in coerced.value), true);
      assert.equal(!('operator' in coerced.value), true);
      assert.equal(!('ppe_summary' in coerced.value), true);
    }
  });

  it('v2：library 截断到 20 条、非法条目被过滤；faces 非法值回落 0', () => {
    resetVisionStoreForTests();
    const coerced = coerceVisionReport(baseReport({
      library: [
        ...Array.from({ length: 30 }, (_, i) => ({ kind: 'item', name: `条目${i}`, score: 0.5, mode: null })),
        { kind: 'item' },
        'garbage'
      ],
      faces: { recognized: 'not-a-number', unknown: -5 }
    }));
    assert.equal(coerced.ok, true);
    if (coerced.ok) {
      assert.equal(coerced.value.library.length, 20);
      assert.deepEqual(coerced.value.faces, { recognized: 0, unknown: 0 });
    }
  });

  it('v1 兼容：无 v 字段的旧载荷可接收，ppe_summary/scene 按白名单处理（ppe 忽略、scene 透传）', () => {
    resetVisionStoreForTests();
    const v1 = {
      lab_id: 'E312',
      ts: Math.floor(Date.now() / 1000),
      count: 2,
      ppe_summary: { state: 'ppe_ok', evaluable: 2, missing: 0 },
      scene: { state: 'library_match', confidence: 0.9, reason: '命中讲台场景', clues: [] },
      camera_online: true,
      quality: { det: 'yolo26n' }
    };
    const coerced = coerceVisionReport(v1);
    assert.equal(coerced.ok, true);
    if (coerced.ok) {
      assert.equal(coerced.value.v, 1);
      assert.equal(coerced.value.faces, null);
      assert.deepEqual(coerced.value.library, []);
      assert.equal(coerced.value.capacity, null);
      assert.equal(coerced.value.sceneState, 'library_match');
      assert.equal(coerced.value.sceneReason, '命中讲台场景');
    }
  });

  it('非法 lab_id 与缺失 ts 拒绝', () => {
    resetVisionStoreForTests();
    assert.equal(coerceVisionReport(baseReport({ lab_id: '坏 id' })).ok, false);
    assert.equal(coerceVisionReport(baseReport({ ts: undefined })).ok, false);
    assert.equal(coerceVisionReport('not-an-object').ok, false);
  });
});

describe('告警判定与摄取（v2 口径）', () => {
  it('正常不告警；超容量与离线告警；底库命中/人脸数量不是告警（防告警疲劳）', () => {
    resetVisionStoreForTests();
    assert.equal(isAlertReport(reportOf()), false);
    assert.equal(isAlertReport(reportOf({ count: 41, capacity: 40 })), true);
    assert.equal(isAlertReport(reportOf({ count: 40, capacity: 40 })), false);
    assert.equal(isAlertReport(reportOf({ camera_online: false })), true);
    assert.equal(isAlertReport(reportOf({
      library: [{ kind: 'item', name: '投影仪遥控器', score: 0.94, mode: 'whole' }],
      faces: { recognized: 5, unknown: 9 }
    })), false);
    // 容量未知时不误报
    assert.equal(isAlertReport(reportOf({ capacity: null, count: 999 })), false);
  });

  it('摄取后 status 输出 v2 字段；快照有效入内存、超限忽略', () => {
    resetVisionStoreForTests();
    const report = reportOf({
      library: [{ kind: 'item', name: '投影仪遥控器', score: 0.94, mode: 'whole' }]
    });

    const okSnapshot = Buffer.alloc(1024, 2).toString('base64');
    const ingested = ingestVisionReport(report, { snapshotBase64: okSnapshot });
    assert.equal(ingested.ok, true);
    const status = visionStatus();
    assert.equal(status.labs.length, 1);
    assert.equal(status.labs[0].labId, 'E310');
    assert.equal(status.labs[0].count, 3);
    assert.equal(status.labs[0].capacity, 40);
    assert.equal(status.labs[0].recognized, 2);
    assert.equal(status.labs[0].unknownFaces, 1);
    assert.equal(status.labs[0].library[0]?.name, '投影仪遥控器');
    assert.equal(status.labs[0].snapshotAvailable, true);
    assert.equal(visionSnapshot('E310')?.base64, okSnapshot);

    const tooBig = Buffer.alloc(MAX_SNAPSHOT_BYTES + 2048, 3).toString('base64');
    const second = ingestVisionReport(report, { snapshotBase64: tooBig });
    assert.equal(second.ok, true);
    if (second.ok) assert.match(second.snapshotIgnored ?? '', /too large/);
    assert.equal(visionSnapshot('E310')?.base64, okSnapshot);

    const events = visionEvents({ labId: 'E310' });
    assert.equal(events.length >= 2, true);
    assert.equal(events[0].library[0]?.name, '投影仪遥控器');
    assert.equal(events[0].faces?.recognized, 2);
    assert.equal(visionEvents({ labId: 'E999' }).length, 0);
  });

  it('未配置 Secret 时 configured=false', () => {
    delete process.env.VISION_INGEST_SECRET;
    assert.equal(visionIngestConfigured(), false);
    process.env.VISION_INGEST_SECRET = SECRET;
  });
});
