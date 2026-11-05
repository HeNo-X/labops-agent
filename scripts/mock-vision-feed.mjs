#!/usr/bin/env node
/**
 * mock-vision-feed —— 模拟视觉边缘上报（无摄像头联调 / 演示用）
 * ============================================================================
 *  与实验室真实链路完全同构：按 Vision 侧 schemas.report_payload 的剥离身份
 *  字段 + HMAC-SHA256 签名（x-vision-ts / x-vision-nonce / x-vision-signature），
 *  向 labops-agent 的 POST /api/vision/report 推送。
 *
 *  用法（Secret 必须与服务端 .env 的 VISION_INGEST_SECRET 一致）：
 *    VISION_INGEST_SECRET=xxx npm run mock:vision
 *    VISION_INGEST_SECRET=xxx npm run mock:vision -- --target http://127.0.0.1:8787 --every 10
 *
 *  场景按轮次循环：正常 → 有人 → 超容量 → 正常 → 护具疑似 → 正常 → 摄像头离线，
 *  方便依次验证前端卡片、告警徽章与事件流水的各个状态。
 */
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const target = String(argValue('--target', process.env.MOCK_VISION_TARGET || 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const everySeconds = Math.max(2, Number(argValue('--every', '10')) || 10);
const secret = process.env.VISION_INGEST_SECRET || '';
if (!secret) {
  console.error('[mock-vision] 缺少 VISION_INGEST_SECRET 环境变量（与 labops-agent/.env 保持一致）');
  process.exit(1);
}

const LABS = [
  { lab_id: 'E310', capacity: 4, base: 2 },
  { lab_id: 'E312', capacity: 6, base: 3 }
];
const PHASES = ['normal', 'occupied', 'over_capacity', 'normal', 'library_hit', 'normal', 'offline'];

let tick = 0;

function buildReport(lab) {
  const phase = PHASES[Math.floor(tick / 3) % PHASES.length];
  const cameraOnline = phase !== 'offline';
  let count = lab.base;
  let faces = { recognized: Math.min(lab.base, 2), unknown: Math.max(0, lab.base - 2) };
  let library = [];
  if (phase === 'occupied') {
    count = lab.base + 1;
    faces = { recognized: 2, unknown: count - 2 };
  } else if (phase === 'over_capacity') {
    count = lab.capacity + 2;
    faces = { recognized: 1, unknown: count - 1 };
  } else if (phase === 'library_hit') {
    // 底库命中事件：物品/场景条目名（非个人信息），演示"识别到什么"
    library = tick % 2 === 0
      ? [{ kind: 'item', name: '投影仪遥控器', score: 0.94, mode: 'whole' }]
      : [{ kind: 'scene', name: 'E310 讲台区域', score: 0.91, mode: 'partial' }];
    faces = { recognized: 2, unknown: 0 };
  } else if (phase === 'offline') {
    faces = { recognized: 0, unknown: 0 };
  }
  return {
    v: 2,
    lab_id: lab.lab_id,
    ts: Math.floor(Date.now() / 1000),
    count: cameraOnline ? count : 0,
    faces: cameraOnline ? faces : { recognized: 0, unknown: 0 },
    library,
    capacity: lab.capacity,
    camera_online: cameraOnline,
    quality: { det: 'mock-yolo26n' }
  };
}

async function send(lab) {
  const payload = buildReport(lab);
  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${raw}`).digest('hex');
  try {
    const response = await fetch(`${target}/api/vision/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vision-ts': String(ts),
        'x-vision-nonce': nonce,
        'x-vision-signature': signature
      },
      body: raw
    });
    const body = await response.text();
    const summary = payload.camera_online ? `${payload.count}人/容${payload.capacity}${payload.library.length ? '·命中' + payload.library[0].name : ''}` : '离线';
    console.log(`[mock-vision] ${lab.lab_id} (${summary}) → HTTP ${response.status} ${body.slice(0, 120)}`);
  } catch (err) {
    console.error(`[mock-vision] ${lab.lab_id} 上报失败：${err.message}`);
  }
}

console.log(`[mock-vision] 目标 ${target}，每 ${everySeconds}s 一轮；Ctrl+C 停止`);
const timer = setInterval(() => {
  tick += 1;
  for (const lab of LABS) void send(lab);
}, everySeconds * 1000);
// 立即先发一轮，不等第一个间隔
for (const lab of LABS) void send(lab);
process.on('SIGINT', () => {
  clearInterval(timer);
  console.log('\n[mock-vision] 已停止');
  process.exit(0);
});
