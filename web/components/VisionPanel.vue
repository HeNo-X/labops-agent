<script setup lang="ts">
/**
 * 实验室监控（PC 端）
 * ============================================================================
 *  两块内容，刻意分开：
 *
 *  ② 【设备内置摄像头】= 本机相机预览（共享组件 BuiltInCamera，移动端同一份）
 *     画面只在本机渲染，不上传、不落盘、不写证据；手机可切前/后置。
 *
 *  ① 【实验室内场摄像头】= 边缘机上报（/api/vision/*）
 *     **未接入就只显示"尚未接入实验室场内摄像头"**，不显示任何人数/告警。
 *     理由：没有真实画面来源时"有没有人""有没有告警"都是不清楚的，
 *     拿演示数据充数会让人误以为真的在监控 —— 这比"看起来有数据"重要得多。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { t as tr } from '../i18n';
import UiIcon from './UiIcon.vue';
import BuiltInCamera from './BuiltInCamera.vue';
import { useModal } from '../composables/useModal';
import { useBusinessStore } from '../stores/business';
import { useVision, type VisionEvent } from '../composables/useVision';
import type { Target } from '@shared/labops-targets.js';

const props = defineProps<{ navigation?: boolean; iconOnly?: boolean }>();

const business = useBusinessStore();
const vision = useVision();
const open = ref(false);
const feedFailed = ref(false);
const failedSnapshots = ref<Set<string>>(new Set());
const feedbackError = ref('');
const guideOpen = ref(false);

useModal(open, '.vision-panel');

/** 标签逐项对齐 server/tools/vision-query.ts；未知取值原样显示，不猜 */
const SCENE_LABEL: Record<string, string> = {
  occupied: '有人',
  empty: '无人',
  normal: '正常',
  over_capacity: '超容量',
  capacity_unknown: '容量未知',
  not_evaluable: '无法判定'
};

function sceneText(value: string | null): string {
  if (!value) return '暂无场景结论';
  return SCENE_LABEL[value] ?? value;
}
/** 底库命中的一行人话：「物品「投影仪遥控器」94%」 */
function hitText(hit: { kind: string; name: string; score: number | null }): string {
  const kind = hit.kind === 'scene' ? '场景' : '物品';
  const score = hit.score !== null && hit.score !== undefined ? ` ${Math.round(hit.score * 100)}%` : '';
  return `${kind}「${hit.name}」${score}`;
}

const updatedLabel = computed(() => {
  if (!vision.lastRefreshedAt.value) return '尚未刷新';
  const seconds = Math.max(0, Math.round((Date.now() - vision.lastRefreshedAt.value) / 1000));
  return seconds < 5 ? '刚刚更新' : `${seconds} 秒前更新`;
});

const edgeMeta = computed(() => {
  const parts = [
    `${vision.labs.value.length} 个房间`,
    `${vision.onlineCount.value} 个在线`,
    ...(vision.alertLabs.value.length ? [`${vision.alertLabs.value.length} 个告警`] : []),
    '数据来源：边缘机上报',
    updatedLabel.value
  ];
  return parts.join(' · ');
});

function snapshotBroken(labId: string): void {
  failedSnapshots.value = new Set([...failedSnapshots.value, labId]);
}

/** 告警一键起草：预填"AI 线索 + 建议动作"，由 Agent 起草工单、本人确认（HITL）。
 *  PC 通道：派发 labops-vision-draft → App.vue 关抽屉、新建工作会话并把文本填进命令栏。 */
function draftIssue(lab: { labId: string; count: number; capacity: number | null; ageSeconds: number; alert: boolean }): void {
  const capacity = lab.capacity !== null ? `/${lab.capacity} 容量` : '';
  const reason = lab.capacity !== null && lab.count > lab.capacity ? tr('超容量') : tr('摄像头离线');
  const question = tr(
    '视觉边缘上报 {lab} {reason}：AI 计数 {n} 人{cap}，数据 {age} 秒前。请直接调用 prepare_business_workflow（kind=issue.create, roomId="{lab}"）起草工单：标题『视觉线索待核查』，正文写明 AI 计数是线索、需人工现场核验，不得写成已确认的违规事实。除本条已给信息外无需再查询，起草后等我确认。',
    { lab: lab.labId, reason, n: lab.count, cap: capacity, age: lab.ageSeconds }
  );
  window.dispatchEvent(new CustomEvent('labops-vision-draft', { detail: question }));
}

/** 事件误报/确认回流（批C）；失败给出行内提示，下一轮轮询还原服务端口径 */
async function sendFeedback(row: VisionEvent, verdict: 'false_alarm' | 'confirmed'): Promise<void> {
  const ok = await vision.sendFeedback(row, verdict);
  feedbackError.value = ok ? '' : tr('标注未保存，请重试');
}

function eventTime(row: VisionEvent): string {
  const stamp = row.ts > 1e12 ? row.ts : row.ts * 1000;
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return String(row.ts);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function show(): void {
  open.value = true;
  // 无条件启动轮询：未配置密钥时 status 也会如实返回 configured=false（带接入指引），
  // 服务端补配密钥重启后，轮询自动发现 configured 翻转，画面卡与数据无需刷新页面
  vision.start();
}

function close(): void {
  open.value = false;
  vision.stop();
}

function onTarget(event: Event): void {
  const target = (event as CustomEvent<Target>).detail;
  if (target?.view !== 'vision') return;
  show();
}

watch(open, (isOpen) => {
  if (isOpen) vision.start();
  if (!isOpen) vision.stop();
});

onMounted(() => window.addEventListener('labops-target', onTarget));
onUnmounted(() => {
  window.removeEventListener('labops-target', onTarget);
  vision.stop();
});
</script>

<template>
  <div v-if="business.connected" class="vision-entry">
    <button
      type="button"
      :class="{ 'nav-tool': navigation }"
      :aria-label="tr('实验室监控')"
      :title="tr('实验室监控')"
      @click="show"
    >
      <UiIcon v-if="navigation" name="camera" />
      <span v-if="!iconOnly">{{ tr('实验室监控') }}</span>
    </button>
  </div>

  <Teleport to="body">
    <div v-if="open" class="vision-mask" @click.self="close">
      <section class="vision-panel" role="dialog" aria-modal="true" :aria-label="tr('实验室监控')">
        <header class="vision-head">
          <h1>{{ tr('实验室监控') }}</h1>
          <span class="vision-meta">{{ vision.configured.value ? tr(edgeMeta) : tr('仅本机摄像头可用') }}</span>
          <button v-if="vision.configured.value" type="button" :disabled="vision.loading.value" @click="vision.refresh">
            {{ tr('刷新') }}
          </button>
          <button type="button" :aria-label="tr('关闭实验室监控')" @click="close">{{ tr('关闭') }}</button>
        </header>

        <!-- ① 内场摄像头：未接入就只说未接入 -->
        <section class="vision-edge">
          <h2>{{ tr('实验室内场摄像头') }}</h2>

          <p v-if="!vision.configured.value" class="vision-notconnected">
            <span aria-hidden="true">○</span>{{ tr('尚未接入实验室场内摄像头') }}
          </p>

          <template v-else>
            <p v-if="vision.error.value" class="vision-error" role="alert">{{ vision.error.value }}</p>

            <section v-if="vision.liveAvailable.value === true && !feedFailed" class="vision-live">
              <img :src="vision.feedUrl()" :alt="tr('实验室实时画面')" @error="feedFailed = true" />
              <p class="vision-live__note">{{ tr('画面只在本机/内网可达时由本服务代理，不上传云端。') }}</p>
            </section>

            <div class="vision-body">
              <section class="vision-rooms">
                <p v-if="!vision.labs.value.length" class="vision-empty">
                  {{ tr('已接入，但还没有任何房间上报。检查边缘机是否在发心跳。') }}
                </p>
                <section v-if="vision.labs.value.length && vision.alertLabs.value.length" class="vision-todo" aria-label="待核查">
                  <h3>{{ tr('待核查 {n} 处', { n: vision.alertLabs.value.length }) }}</h3>
                  <ul>
                    <li v-for="lab in vision.alertLabs.value" :key="`todo-${lab.labId}`">
                      <b>{{ lab.labId }}</b>
                      <span>{{ tr('计数 {n} 人', { n: lab.count }) }}</span>
                      <button type="button" @click="draftIssue(lab)">{{ tr('让 Agent 起草工单') }}</button>
                    </li>
                  </ul>
                  <p class="vision-todo__note">{{ tr('起草后由 Agent 生成办理单，最终以你的确认卡为准；视觉是线索不是结论。') }}</p>
                </section>
                <ul v-if="vision.labs.value.length" class="vision-grid">
                  <li v-for="lab in vision.labs.value" :key="lab.labId" class="vision-card" :class="{ 'is-alert': lab.alert }">
                    <header class="vision-card__head">
                      <b>{{ lab.labId }}</b>
                      <span class="vision-badge" :class="lab.online ? 'vision-badge--ok' : 'vision-badge--muted'">
                        <span aria-hidden="true">{{ lab.online ? '✓' : '○' }}</span>{{ tr(lab.online ? '在线' : '离线') }}
                      </span>
                      <span v-if="lab.alert" class="vision-badge vision-badge--danger">
                        <span aria-hidden="true">✕</span>{{ tr('告警') }}
                      </span>
                    </header>
                    <p class="vision-card__count">
                      <span class="vision-card__num">{{ lab.online ? lab.count : '—' }}</span>
                      <span class="vision-card__unit">{{ tr('AI 计数') }}</span>
                    </p>
                    <dl class="vision-card__facts">
                      <div><dt>{{ tr('人数/容量') }}</dt><dd>{{ lab.capacity !== null ? `${lab.count} / ${lab.capacity}` : `${lab.count}` }}</dd></div>
                      <div v-if="lab.recognized !== null"><dt>{{ tr('已录入人脸') }}</dt><dd>{{ tr('{n} 人命中（不含姓名）', { n: lab.recognized }) }}</dd></div>
                      <div v-if="lab.sceneState"><dt>{{ tr('场景') }}</dt><dd>{{ tr(sceneText(lab.sceneState)) }}</dd></div>
                      <div v-if="lab.library.length"><dt>{{ tr('底库命中') }}</dt><dd>{{ lab.library.map(hitText).join('、') }}</dd></div>
                      <div><dt>{{ tr('更新') }}</dt><dd>{{ tr(vision.staleLabel(lab)) }}</dd></div>
                    </dl>
                    <img
                      v-if="lab.snapshotAvailable && !failedSnapshots.has(lab.labId)"
                      class="vision-card__shot"
                      :src="vision.snapshotUrl(lab)"
                      :alt="tr('脱敏快照')"
                      loading="lazy"
                      @error="snapshotBroken(lab.labId)"
                    />
                  </li>
                </ul>
              </section>

              <aside class="vision-events">
                <h3>{{ tr('事件流水') }} <small>{{ vision.events.value.length }}</small></h3>
                <p v-if="!vision.events.value.length" class="vision-empty">{{ tr('暂无上报事件。') }}</p>
                <ul>
                  <li
                    v-for="row in vision.events.value"
                    :key="`${row.labId}-${row.receivedAt}`"
                    :class="{ 'is-alert': row.alert, 'is-offline': !row.cameraOnline }"
                  >
                    <span class="vision-events__time">{{ eventTime(row) }}</span>
                    <b>{{ row.labId }}</b>
                    <span>{{ row.count }}{{ tr(' 人') }}</span>
                    <span v-if="row.recognized !== null">{{ tr('人脸命中 {n}', { n: row.recognized }) }}</span>
                    <span v-for="(hit, hi) in row.library" :key="hi">{{ hitText(hit) }}</span>
                    <span v-if="row.sceneState">{{ tr(sceneText(row.sceneState)) }}</span>
                    <span v-if="!row.cameraOnline" class="vision-events__off">{{ tr('摄像头离线') }}</span>
                    <span v-if="row.feedback" class="vision-events__feedback" :class="row.feedback.verdict === 'false_alarm' ? 'is-fa' : 'is-ok'">{{ tr(row.feedback.verdict === 'false_alarm' ? '已标误报' : '已确认') }}</span>
                    <span v-else-if="row.alert" class="vision-events__actions">
                      <button type="button" @click="sendFeedback(row, 'false_alarm')">{{ tr('误报') }}</button>
                      <button type="button" @click="sendFeedback(row, 'confirmed')">{{ tr('确认') }}</button>
                    </span>
                  </li>
                </ul>
              </aside>
            </div>
          </template>

          <details v-if="!vision.configured.value" class="vision-guide" @toggle="guideOpen = ($event.target as HTMLDetailsElement).open">
            <summary>{{ tr('内场摄像头怎么接？') }}</summary>
            <ol>
              <li>{{ tr('服务端设置') }} <code>VISION_INGEST_SECRET=&lt;长随机串&gt;</code> {{ tr('后重启。') }}</li>
              <li>{{ tr('无摄像头联调（仅测试用，数据不代表真实内场）') }} <code>npm run mock:vision -- --target http://127.0.0.1:18878</code></li>
              <li>{{ tr('真实边缘机按') }} <code>docs/vision-agent-integration</code> {{ tr('的上报契约对接（HMAC 签名）。') }}</li>
            </ol>
          </details>
        </section>

        <!-- ② 本机相机：当前唯一真实可用的画面来源 -->
        <BuiltInCamera />

        <footer class="vision-footnote">
          {{ tr('内场画面与人脸不出实验室内网；二维码签到永远是主链，视觉只做辅助线索。') }}
          <template v-if="vision.configured.value && vision.status.value?.retentionNote">
            · {{ vision.status.value.retentionNote }}
          </template>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.vision-entry {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 20px;
  font-size: calc(var(--ui-font-size) * 0.92308);
  border-bottom: 1px solid var(--border);
}
.vision-entry button {
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  min-height: 36px;
}
.vision-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: #0006;
  padding: 3dvh 16px;
  display: flex;
  justify-content: center;
}
.vision-panel {
  width: min(75vw, 100%);
  max-height: 94dvh;
  overflow: auto;
  padding: 18px;
  background: var(--surface);
  color: var(--text);
  /* 深色模式 --surface(#141414) 与 --bg(#0a0a0a)+遮罩区分度不足：描边+浮层阴影双保险 */
  border: 1px solid var(--border-strong);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
  border-radius: 10px;
  box-sizing: border-box;
  display: grid;
  gap: 16px;
  align-content: start;
}
.vision-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.vision-head h1 {
  margin: 0;
  font-size: 16px;
  margin-right: 4px;
}
.vision-head button {
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
}
.vision-head button:disabled {
  opacity: 0.55;
}
.vision-meta {
  font-size: 12px;
  color: var(--text-faint);
  margin-right: auto;
}
.vision-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}
.vision-badge--ok {
  color: var(--ok, #2e7d32);
}
.vision-badge--danger {
  color: var(--danger, #b91c1c);
  border-style: double;
  border-width: 3px;
}
.vision-badge--muted {
  color: var(--text-faint);
  border-style: dashed;
}
.vision-edge {
  border-top: 1px solid var(--border);
  padding-top: 14px;
  display: grid;
  gap: 10px;
}
.vision-edge h2 {
  margin: 0;
  font-size: 14px;
  color: var(--text-muted);
}
.vision-notconnected {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  font-size: 13px;
  color: var(--text-muted);
  background: var(--surface-2);
}
.vision-guide {
  font-size: 12px;
  color: var(--text-muted);
}
.vision-guide summary {
  cursor: pointer;
  color: var(--text-faint);
}
.vision-guide ol {
  margin: 8px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 6px;
}
.vision-guide code {
  font-family: var(--font-mono, monospace);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.vision-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #b91c1c);
}
.vision-live img {
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  background: #000;
  border-radius: 8px;
}
.vision-live__note {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-faint);
}
.vision-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
  gap: 14px;
  align-items: start;
}
.vision-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.vision-card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: 10px;
  padding: 12px;
  background: var(--surface-2);
  display: grid;
  gap: 8px;
}
.vision-card.is-alert {
  border-left-style: double;
  border-left-width: 5px;
  border-left-color: var(--danger, #b91c1c);
}
.vision-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.vision-card__head b {
  font-family: var(--font-mono, monospace);
  font-size: 14px;
  letter-spacing: 0.02em;
}
.vision-card__count {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.vision-card__num {
  font-size: 30px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.vision-card__unit {
  font-size: 11px;
  color: var(--text-faint);
}
.vision-card__facts {
  margin: 0;
  display: grid;
  gap: 3px;
  font-size: 12px;
}
.vision-card__facts > div {
  display: flex;
  gap: 8px;
}
.vision-card__facts dt {
  flex: 0 0 32px;
  color: var(--text-faint);
}
.vision-card__facts dd {
  margin: 0;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.vision-card__shot {
  width: 100%;
  max-height: 132px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #000;
}
.vision-events {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--surface-2);
  position: sticky;
  top: 0;
}
.vision-events h3 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-muted);
}
.vision-events h3 small {
  color: var(--text-faint);
  font-weight: 400;
}
.vision-events ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  max-height: 50dvh;
  overflow: auto;
}
.vision-events li {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
  color: var(--text-muted);
  padding: 5px 7px;
  border-radius: 6px;
  border-left: 2px solid var(--border);
  background: var(--surface);
}
.vision-events li.is-alert {
  border-left-color: var(--danger, #b91c1c);
  border-left-style: double;
  border-left-width: 4px;
}
.vision-events li.is-offline {
  opacity: 0.75;
}
.vision-events__time {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-faint);
}
.vision-events__feedback {
  font-size: calc(var(--ui-font-size) * 0.84615);
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  white-space: nowrap;
}
.vision-events__feedback.is-fa { color: var(--text-faint); }
.vision-events__feedback.is-ok { color: var(--positive, #2e9e5b); }
.vision-events__actions { display: inline-flex; gap: 6px; }
.vision-events__actions button {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.84615);
  cursor: pointer;
}
.vision-events__actions button:hover { color: var(--primary); border-color: var(--primary-border); }
.vision-todo {
  border: 1px solid var(--danger, #c0392b);
  border-radius: var(--radius-lg, 12px);
  background: var(--surface);
  padding: var(--sp-3) var(--sp-4);
  margin-bottom: var(--sp-3);
}
.vision-todo h3 { margin: 0 0 var(--sp-2); font-size: calc(var(--ui-font-size) * 1.0); color: var(--danger, #c0392b); }
.vision-todo ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.vision-todo li { display: flex; align-items: center; gap: var(--sp-3); font-size: calc(var(--ui-font-size) * 0.92308); }
.vision-todo li b { font-family: var(--font-mono); }
.vision-todo button {
  margin-left: auto;
  padding: 4px 12px;
  border-radius: var(--radius, 8px);
  border: 1px solid var(--danger, #c0392b);
  background: transparent;
  color: var(--danger, #c0392b);
  cursor: pointer;
}
.vision-todo button:hover { background: var(--surface-3); }
.vision-todo__note { margin: var(--sp-2) 0 0; font-size: calc(var(--ui-font-size) * 0.84615); color: var(--text-faint); }

.vision-events__off {
  color: var(--warning, #a16207);
}
.vision-empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.vision-footnote {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.6;
}
@media (max-width: 900px) {
  .vision-body {
    grid-template-columns: 1fr;
  }
  .vision-events {
    position: static;
  }
  .vision-mask {
    padding: 0;
  }
  .vision-panel {
    max-height: 100dvh;
    border-radius: 0;
    padding: 14px;
  }
}
</style>
