<script setup lang="ts">
/**
 * MobileVision —— 实验室监控与巡检（视觉边缘接入的统一前端）
 * ============================================================================
 *  信息架构（自上而下）：
 *    ① 通道状态条 —— 接入状态 / 最新更新时间 / 手动刷新
 *    ② 实时画面卡 —— 探测内网 MJPEG 可达才展开（拓扑感知降级：
 *       云端部署只见结论，画面留在实验室；同机/内网部署才有画面）
 *    ③ 房间监测网格 —— AI 计数大数字 + 容量/人脸命中/底库命中徽章 + 快照与"让 Agent 核对"
 *    ④ 事件流水 —— 最近上报（异常线索高亮）
 *    ⑤ 合规脚注 —— 画面与人脸不出内网、云端只见剥离身份 JSON、二维码主链
 *
 *  数据全部来自本服务 /api/vision/*；未接入时给的是配置指引，不冒充数据。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { clientFetch } from '../client';
import { useSessionStore } from '../stores/session';
import { t as tr } from '../i18n';
import UiIcon from '../components/UiIcon.vue';
import BuiltInCamera from '../components/BuiltInCamera.vue';
import type { Target } from '@shared/labops-targets.js';

const emit = defineEmits<{ navigate: [Target] }>();
const session = useSessionStore();

interface VisionLabSummary {
  labId: string; online: boolean; lastSeenAt: string; lastSeenEpochMs: number; ageSeconds: number;
  count: number; capacity: number | null; recognized: number | null; unknownFaces: number | null;
  library: Array<{ kind: string; name: string; score: number | null; mode: string | null }>;
  sceneState: string | null; sceneReason: string | null; alert: boolean; snapshotAvailable: boolean;
}
interface VisionEventRow {
  labId: string; ts: number; receivedAt: number; alert: boolean; count: number;
  recognized: number | null; library: Array<{ kind: string; name: string; score: number | null }>;
  sceneState: string | null; sceneReason: string | null; cameraOnline: boolean;
  feedback: { verdict: 'false_alarm' | 'confirmed'; by: string; at: string } | null;
}
interface VisionStatusResponse {
  ok: boolean; configured: boolean; labs: VisionLabSummary[]; eventCount: number; generatedAt: string; retentionNote: string;
}

const status = ref<VisionStatusResponse | null>(null);
const events = ref<VisionEventRow[]>([]);
const loading = ref(true);
const loadError = ref('');
const liveProbe = ref<boolean | null>(null);
const liveFailed = ref(false);
const openSnapshot = ref('');
const snapshotFailed = ref('');
const now = ref(Date.now());

let pollTimer = 0;
let probeTimer = 0;
let clockTimer = 0;
let fetching = false;
let probing = false;

const labs = computed(() => status.value?.labs ?? []);
const alertCount = computed(() => labs.value.filter((lab) => lab.alert).length);
const alertLabs = computed(() => labs.value.filter((lab) => lab.alert));
const channelTone = computed<'unconfigured' | 'alert' | 'live' | 'idle'>(() => {
  if (!status.value?.configured) return 'unconfigured';
  if (alertCount.value > 0) return 'alert';
  if (labs.value.some((lab) => lab.online)) return 'live';
  return 'idle';
});
const updatedLabel = computed(() => {
  if (!status.value) return '';
  return tr('更新于 {t} · 每 5 秒自动刷新', { t: relative(status.value.generatedAt) });
});

function relative(input: string | number): string {
  const ms = typeof input === 'number' ? input : Date.parse(input);
  const diff = Math.max(0, Math.round((now.value - ms) / 1000));
  if (diff < 5) return tr('刚刚');
  if (diff < 60) return tr('{n} 秒前', { n: diff });
  if (diff < 3600) return tr('{n} 分钟前', { n: Math.round(diff / 60) });
  if (diff < 86400) return tr('{n} 小时前', { n: Math.round(diff / 3600) });
  return new Date(ms).toLocaleString();
}

function sceneLabel(lab: VisionLabSummary): string {
  if (!lab.sceneState) return tr('场景未知');
  const map: Record<string, string> = { occupied: '有人', empty: '无人', normal: '正常', over_capacity: '超容量', capacity_unknown: '容量未知', not_evaluable: '无法判定' };
  return tr(map[lab.sceneState] ?? lab.sceneState);
}
/** 底库命中的一行人话（与 PC 端 VisionPanel 同口径） */
function hitText(hit: { kind: string; name: string; score: number | null }): string {
  const kind = hit.kind === 'scene' ? '场景' : '物品';
  const score = hit.score !== null && hit.score !== undefined ? ` ${Math.round(hit.score * 100)}%` : '';
  return `${kind}「${hit.name}」${score}`;
}
function alertLabel(lab: VisionLabSummary): string {
  if (!lab.online) return tr('摄像头离线');
  if (lab.capacity !== null && lab.count > lab.capacity) return tr('超容量');
  return tr('需要关注');
}

async function refresh(): Promise<void> {
  if (fetching || document.visibilityState !== 'visible') return;
  fetching = true;
  try {
    const [statusRes, eventsRes] = await Promise.all([
      clientFetch('/api/vision/status'),
      clientFetch('/api/vision/events?limit=30')
    ]);
    if (!statusRes.ok || !eventsRes.ok) throw new Error(`HTTP ${statusRes.status}/${eventsRes.status}`);
    const statusData = (await statusRes.json()) as VisionStatusResponse;
    const eventsData = (await eventsRes.json()) as { events: VisionEventRow[] };
    status.value = statusData;
    events.value = eventsData.events ?? [];
    loadError.value = '';
  } catch (err) {
    loadError.value = tr('视觉数据读取失败：{m}', { m: (err as Error).message });
  } finally {
    loading.value = false;
    fetching = false;
  }
}

async function probe(): Promise<void> {
  if (probing || document.visibilityState !== 'visible') return;
  probing = true;
  try {
    const response = await clientFetch('/api/vision/live-probe');
    const data = (await response.json()) as { available?: boolean };
    liveProbe.value = Boolean(data.available);
    if (!data.available) liveFailed.value = false;
  } catch {
    liveProbe.value = false;
  } finally {
    probing = false;
  }
}

function toggleSnapshot(lab: VisionLabSummary): void {
  snapshotFailed.value = '';
  openSnapshot.value = openSnapshot.value === lab.labId ? '' : lab.labId;
}

/** 把现场差异交给 Agent：预填草稿并跳到助手首屏（工作台草稿键 '__new'） */
function askAgent(lab: VisionLabSummary): void {
  const question = tr(
    '请核对 {lab} 的现场人数与签到记录是否一致：视觉边缘 AI 计数 {n} 人{cap}，数据 {age} 秒前。两口径如有差异，请只分析原因并给出核查建议，不要直接办理。',
    { lab: lab.labId, n: lab.count, cap: lab.capacity !== null ? `/${lab.capacity} 容量` : '', age: lab.ageSeconds }
  );
  session.saveDraft('__new', question);
  emit('navigate', { view: 'assistant' });
}

/** 告警一键起草：预填"AI 线索 + 建议动作"，由 Agent 起草工单、本人确认（HITL） */
function draftIssue(lab: VisionLabSummary): void {
  const reason = alertLabel(lab);
  const question = tr(
    '视觉边缘上报 {lab} {reason}：AI 计数 {n} 人{cap}，数据 {age} 秒前。请直接调用 prepare_business_workflow（kind=issue.create, roomId="{lab}"）起草工单：标题『视觉线索待核查』，正文写明 AI 计数是线索、需人工现场核验，不得写成已确认的违规事实。除本条已给信息外无需再查询，起草后等我确认。',
    { lab: lab.labId, reason, n: lab.count, cap: lab.capacity !== null ? `/${lab.capacity} 容量` : '', age: lab.ageSeconds }
  );
  session.saveDraft('__new', question);
  emit('navigate', { view: 'assistant' });
}

/** 事件误报/确认回流（批C）；失败静默——下一轮轮询会还原服务端口径 */
async function sendFeedback(event: VisionEventRow, verdict: 'false_alarm' | 'confirmed'): Promise<void> {
  try {
    const res = await clientFetch('/api/vision/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labId: event.labId, receivedAt: event.receivedAt, verdict })
    });
    if (res.ok) event.feedback = { verdict, by: 'me', at: new Date().toISOString() };
  } catch { /* 静默：轮询会还原 */ }
}

onMounted(() => {
  void refresh();
  void probe();
  pollTimer = window.setInterval(() => void refresh(), 5000);
  probeTimer = window.setInterval(() => void probe(), 30000);
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  clearInterval(pollTimer);
  clearInterval(probeTimer);
  clearInterval(clockTimer);
});
</script>

<template>
  <section class="vision-view">
    <!-- ① 通道状态 -->
    <header class="vision-top" :class="`is-${channelTone}`">
      <span class="vision-pulse" aria-hidden="true"></span>
      <div class="vision-top-text">
        <b>{{ tr(status?.configured ? (alertCount ? '有异常线索待核查' : labs.length ? '视觉通道正常' : '等待边缘上报') : '视觉通道未接入') }}</b>
        <small v-if="updatedLabel">{{ updatedLabel }}</small>
      </div>
      <button class="vision-refresh" :aria-label="tr('手动刷新')" @click="refresh"><UiIcon name="history" :size="16"/></button>
    </header>

    <p v-if="loadError" class="vision-error" role="alert">{{ loadError }}</p>

    <!-- 设备内置摄像头：本机预览，与内网边缘画面无关。
         未接入内场摄像头时，这是页面上唯一真实的画面来源；手机可切前/后置。 -->
    <BuiltInCamera compact />

    <!-- 未接入：配置指引（诚实空态，不冒充数据） -->
    <section v-if="status && !status.configured" class="vision-card vision-guide">
      <h2>{{ tr('把实验室摄像头接入 Agent') }}</h2>
      <ol>
        <li>{{ tr('服务端 .env 设置 VISION_INGEST_SECRET（任意长随机串），重启服务端') }}</li>
        <li>{{ tr('实验室边缘机运行视觉服务，edge_client 按剥离身份契约 + HMAC 签名上报') }}</li>
        <li>{{ tr('本地演示可先跑 npm run mock:vision 生成模拟上报') }}</li>
      </ol>
      <p class="vision-guide-note">{{ tr('接入后：Agent 可回答"现在有几个人在实验室"，并提示人数与签到的差异。') }}</p>
    </section>

    <template v-else>
      <!-- 已接入但还没有数据 -->
      <section v-if="!labs.length" class="vision-card vision-guide">
        <h2>{{ tr('已开启接入，等待第一条上报') }}</h2>
        <p>{{ tr('在实验室边缘机运行 edge_client（或 npm run mock:vision 模拟），第一条数据到达后这里会出现房间卡片。') }}</p>
      </section>

      <!-- ② 实时画面（拓扑感知：只有内网/同机部署可达） -->
      <section v-if="labs.length && liveProbe !== false" class="vision-card vision-live">
        <header>
          <UiIcon name="camera"/>{{ tr('实验室实时画面') }}
          <small>{{ tr('画面来自实验室内网，不经云端存储') }}</small>
        </header>
        <img v-if="liveProbe && !liveFailed" :src="'/api/vision/feed'" :alt="tr('实验室实时画面')" @error="liveFailed = true"/>
        <p v-else class="vision-live-note">{{ tr(liveProbe === null ? '正在探测内网画面…' : '内网画面暂时不可达（正常形态：云端只见结论，画面留在实验室）') }}</p>
      </section>

      <!-- ②.5 待核查专区（批C）：告警房间聚合，一键起草工单（Agent 起草 → 本人确认） -->
      <section v-if="alertCount" class="vision-todo" aria-label="待核查">
        <h2>{{ tr('待核查 {n} 处', { n: alertCount }) }}</h2>
        <ul>
          <li v-for="lab in alertLabs" :key="`todo-${lab.labId}`">
            <b>{{ lab.labId }}</b>
            <span class="vision-todo__reason">{{ alertLabel(lab) }} · {{ tr('计数 {n} 人', { n: lab.count }) }}</span>
            <button type="button" @click="draftIssue(lab)">{{ tr('让 Agent 起草工单') }}</button>
          </li>
        </ul>
        <p class="vision-guide-note">{{ tr('起草后由 Agent 生成办理单，最终以你的确认卡为准；视觉是线索不是结论。') }}</p>
      </section>

      <!-- ③ 房间监测网格 -->
      <div v-if="labs.length" class="vision-grid">
        <article
          v-for="lab in labs"
          :key="lab.labId"
          class="vision-card vision-lab"
          :class="{ 'is-alert': lab.alert, 'is-stale': lab.ageSeconds > 120 }"
        >
          <header class="vision-lab-head">
            <b>{{ lab.labId }}</b>
            <span class="vision-chip" :class="lab.online ? 'is-ok' : 'is-warn'">
              <i aria-hidden="true"></i>{{ tr(lab.online ? '在线' : '离线') }}
            </span>
            <span v-if="lab.alert" class="vision-chip is-alert-chip">{{ alertLabel(lab) }}</span>
          </header>
          <div class="vision-count">
            <b>{{ lab.count }}</b>
            <span>{{ lab.capacity !== null ? tr('AI 在室人数 / {c} 容量', { c: lab.capacity }) : tr('AI 在室人数') }}</span>
          </div>
          <div class="vision-chips">
            <span v-if="lab.recognized !== null" class="vision-chip is-neutral">{{ tr('人脸命中 {n}', { n: lab.recognized }) }}</span>
            <span v-for="(hit, hi) in lab.library" :key="hi" class="vision-chip is-neutral">{{ hitText(hit) }}</span>
            <span v-if="lab.sceneState" class="vision-chip is-neutral">{{ sceneLabel(lab) }}</span>
            <span class="vision-chip is-neutral">{{ relative(lab.lastSeenEpochMs) }}</span>
          </div>
          <p v-if="lab.sceneReason" class="vision-reason">{{ lab.sceneReason }}</p>
          <div class="vision-actions">
            <button v-if="lab.snapshotAvailable" type="button" @click="toggleSnapshot(lab)">
              {{ tr(openSnapshot === lab.labId ? '收起快照' : '最新快照') }}
            </button>
            <button type="button" class="is-primary" @click="askAgent(lab)">{{ tr('让 Agent 核对') }}</button>
            <button v-if="lab.alert" type="button" class="is-draft" @click="draftIssue(lab)">{{ tr('让 Agent 起草工单') }}</button>
          </div>
          <template v-if="openSnapshot === lab.labId">
            <img
              v-if="!snapshotFailed"
              class="vision-snapshot"
              :src="`/api/vision/snapshot?lab=${encodeURIComponent(lab.labId)}&t=${lab.lastSeenEpochMs}`"
              :alt="tr('{lab} 最新脱敏快照', { lab: lab.labId })"
              @error="snapshotFailed = lab.labId"
            />
            <p v-else class="vision-live-note">{{ tr('快照读取失败') }}</p>
          </template>
        </article>
      </div>

      <!-- ④ 事件流水 -->
      <section v-if="events.length" class="vision-events">
        <h2>{{ tr('最近事件') }}</h2>
        <ul>
          <li v-for="(event, index) in events" :key="`${event.labId}-${event.receivedAt}-${index}`" :class="{ 'is-alert': event.alert }">
            <span class="vision-event-time">{{ relative(event.receivedAt) }}</span>
            <b>{{ event.labId }}</b>
            <span class="vision-event-text">
              {{ event.cameraOnline ? tr('计数 {n} 人', { n: event.count }) : tr('摄像头离线') }}
              <template v-if="event.recognized !== null"> · {{ tr('人脸命中 {n}', { n: event.recognized }) }}</template>
              <template v-for="(hit, hi) in event.library" :key="hi"> · {{ hitText(hit) }}</template>
              <template v-if="event.sceneState"> · {{ sceneLabel({ sceneState: event.sceneState } as VisionLabSummary) }}</template>
            </span>
            <span v-if="event.feedback" class="vision-event-feedback" :class="event.feedback.verdict === 'false_alarm' ? 'is-fa' : 'is-ok'">
              {{ tr(event.feedback.verdict === 'false_alarm' ? '已标误报' : '已确认') }}
            </span>
            <span v-else-if="event.alert" class="vision-event-actions">
              <button type="button" @click="sendFeedback(event, 'false_alarm')">{{ tr('误报') }}</button>
              <button type="button" @click="sendFeedback(event, 'confirmed')">{{ tr('确认') }}</button>
            </span>
            <span v-if="event.sceneReason" class="vision-event-reason">{{ event.sceneReason }}</span>
          </li>
        </ul>
      </section>
    </template>

    <!-- ⑤ 合规脚注 -->
    <footer class="vision-compliance">
      {{ tr('边缘推理：画面与人脸不出实验室内网；云端仅存剥离身份后的 JSON（人数/场景/事件）。二维码签到永远是主链，视觉只做辅助。') }}
    </footer>
  </section>
</template>

<style scoped>
.vision-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 12px 24px;
  max-width: 720px;
  margin: 0 auto;
}
.vision-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
}
.vision-top.is-unconfigured { border-color: var(--border); }
.vision-top.is-alert { border-color: var(--danger, #c0392b); box-shadow: 0 0 0 1px var(--danger, #c0392b) inset; }
.vision-pulse {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-faint);
}
.vision-top.is-live .vision-pulse { background: var(--positive, #2e9e5b); animation: vision-pulse 2s ease-in-out infinite; }
.vision-top.is-alert .vision-pulse { background: var(--danger, #c0392b); animation: vision-pulse 1s ease-in-out infinite; }
@keyframes vision-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .vision-pulse { animation: none; }
}
.vision-top-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.vision-top-text b { font-size: 15px; }
.vision-top-text small { color: var(--text-faint); }
.vision-refresh {
  flex: 0 0 auto;
  border: 1px solid var(--border);
  background: var(--surface-2, transparent);
  color: var(--text-muted);
  border-radius: 10px;
  padding: 7px 9px;
  cursor: pointer;
}
.vision-error {
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--surface);
  color: var(--danger, #c0392b);
  font-size: 13px;
}
.vision-card {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  padding: 14px;
}
.vision-guide h2 { margin: 0 0 8px; font-size: 15px; }
.vision-guide ol, .vision-guide p { margin: 0 0 6px; padding-left: 18px; font-size: 13px; color: var(--text-muted); line-height: 1.6; }
.vision-guide-note { color: var(--text-faint); }
.vision-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}
.vision-lab { display: flex; flex-direction: column; gap: 10px; }
.vision-lab.is-alert { border-color: var(--danger, #c0392b); }
.vision-lab.is-stale { opacity: 0.75; }
.vision-lab-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vision-lab-head b { font-size: 15px; }
.vision-count { display: flex; align-items: baseline; gap: 8px; }
.vision-count b { font-size: 34px; line-height: 1; font-variant-numeric: tabular-nums; }
.vision-count span { font-size: 12px; color: var(--text-faint); }
.vision-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.vision-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  background: var(--surface-2, transparent);
}
.vision-chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.vision-chip.is-ok { color: var(--positive, #2e9e5b); }
.vision-chip.is-warn { color: var(--warning, #b7791f); border-color: currentColor; }
.vision-chip.is-alert-chip { color: var(--danger, #c0392b); border-color: currentColor; font-weight: 600; }
.vision-chip.is-neutral { color: var(--text-muted); }
.vision-reason { margin: 0; font-size: 12px; color: var(--text-faint); line-height: 1.5; }
.vision-actions { display: flex; gap: 8px; margin-top: auto; }
.vision-actions button {
  flex: 1;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--border-strong, var(--border));
  background: var(--surface-2, transparent);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}
.vision-actions button.is-primary {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-contrast);
  font-weight: 600;
}
.vision-actions button:disabled { opacity: 0.5; cursor: default; }
.vision-snapshot {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border);
}
.vision-live header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
}
.vision-live header small { font-weight: 400; color: var(--text-faint); margin-left: auto; }
.vision-live img {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: #000;
  min-height: 120px;
}
.vision-live-note { margin: 0; font-size: 12px; color: var(--text-faint); }
.vision-events h2 { margin: 0 0 8px; font-size: 14px; }
.vision-events ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.vision-events li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  font-size: 13px;
}
.vision-events li.is-alert { border-color: var(--danger, #c0392b); }
.vision-event-time { color: var(--text-faint); font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.vision-event-text { color: var(--text-muted); }
.vision-event-reason { flex-basis: 100%; font-size: 12px; color: var(--text-faint); }
.vision-compliance {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
  padding: 0 4px;
}

/* ---- 待核查专区（批C）与事件回流 ---- */
.vision-todo {
  border: 1px solid var(--danger, #c0392b);
  border-radius: 14px;
  background: var(--surface);
  padding: 12px 14px;
}
.vision-todo h2 { margin: 0 0 8px; font-size: 14px; color: var(--danger, #c0392b); }
.vision-todo ul { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.vision-todo li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.vision-todo__reason { color: var(--text-muted); flex: 1; min-width: 0; }
.vision-todo button {
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid var(--danger, #c0392b);
  background: transparent;
  color: var(--danger, #c0392b);
  font-size: 12px;
  cursor: pointer;
}
.vision-actions .is-draft {
  border-color: var(--danger, #c0392b);
  background: transparent;
  color: var(--danger, #c0392b);
}
.vision-event-feedback {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
}
.vision-event-feedback.is-fa { color: var(--text-faint); }
.vision-event-feedback.is-ok { color: var(--positive, #2e9e5b); }
.vision-event-actions { display: inline-flex; gap: 6px; margin-left: auto; }
.vision-event-actions button {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2, transparent);
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}
</style>
