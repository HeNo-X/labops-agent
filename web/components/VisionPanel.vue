<script setup lang="ts">
/**
 * 实验室监控（PC 端）
 * ============================================================================
 *  与移动端 MobileVision 同源数据（/api/vision/*），但按桌面信息密度重排：
 *    左：房间监测网格（多列，一屏看全）
 *    右：事件流水（常驻侧栏，不用来回切）
 *    上：通道状态条 + 最后更新时间
 *  实时画面卡只在「内网 MJPEG 探活可达」时出现（拓扑感知），云端部署自动收起，不造假画面。
 *
 *  纪律（来自 vision 接入文档）：
 *    · 视觉是**线索不是结论** —— 计数与签到不一致时只提示核查，不下判定
 *    · 数据过期（>120s）必须显式说明，不能拿旧数字当"现在"
 *    · 未接入时给配置指引，绝不拿 0 冒充"没人"
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { t as tr } from '../i18n';
import UiIcon from './UiIcon.vue';
import { useModal } from '../composables/useModal';
import { useBusinessStore } from '../stores/business';
import { useVision, type VisionEvent } from '../composables/useVision';
import type { Target } from '@shared/labops-targets.js';

const props = defineProps<{ navigation?: boolean; iconOnly?: boolean }>();

const business = useBusinessStore();
const vision = useVision();
const open = ref(false);

useModal(open, '.vision-panel');

/**
 * 标签表**逐项对齐** `server/tools/vision-query.ts` 的 SCENE_LABELS / PPE_LABELS。
 * 不自己另起一套措辞 —— 否则同一个 ppe_suspect 在 Agent 回答里叫"护具疑似缺失"、
 * 在这里叫别的，用户会以为是两件事。
 * 未知取值原样显示（宁可露出原始码，也不猜一个好听的中文）。
 */
const SCENE_LABEL: Record<string, string> = {
  occupied: '有人',
  empty: '无人',
  normal: '正常',
  over_capacity: '超容量',
  capacity_unknown: '容量未知',
  not_evaluable: '无法判定'
};
const PPE_LABEL: Record<string, string> = {
  ppe_ok: '护具齐全',
  ppe_suspect: '护具疑似缺失',
  ppe_unknown: '护具无法判定',
  ppe_not_applicable: '画面无人，不判定着装'
};

function sceneText(value: string | null): string {
  if (!value) return '暂无场景结论';
  return SCENE_LABEL[value] ?? value;
}
function ppeText(value: string | null, missing: number | null): string {
  if (!value) return '暂无护具结论';
  const base = PPE_LABEL[value] ?? value;
  return typeof missing === 'number' && missing > 0 ? `${base}（缺 ${missing}）` : base;
}

const channelMeta = computed<{ label: string; tone: string; glyph: string }>(() => {
  switch (vision.channel.value) {
    case 'unconfigured':
      return { label: '视觉通道未接入', tone: 'muted', glyph: '○' };
    case 'alert':
      return { label: `${vision.alertLabs.value.length} 个房间告警`, tone: 'danger', glyph: '✕' };
    case 'live':
      return { label: `${vision.onlineCount.value} 个房间在线`, tone: 'ok', glyph: '✓' };
    case 'error':
      return { label: '读取失败', tone: 'danger', glyph: '✕' };
    case 'idle':
      return { label: '暂无在线摄像头', tone: 'warn', glyph: '⚠' };
    default:
      return { label: '正在读取…', tone: 'muted', glyph: '◌' };
  }
});

const updatedLabel = computed(() => {
  if (!vision.lastRefreshedAt.value) return '尚未刷新';
  const seconds = Math.max(0, Math.round((Date.now() - vision.lastRefreshedAt.value) / 1000));
  return seconds < 5 ? '刚刚更新' : `${seconds} 秒前更新`;
});

const feedFailed = ref(false);
const failedSnapshots = ref<Set<string>>(new Set());

function snapshotBroken(labId: string): void {
  failedSnapshots.value = new Set([...failedSnapshots.value, labId]);
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

// 面板关闭就停轮询：桌面端不该在后台一直拉
watch(open, (isOpen) => {
  if (isOpen) vision.start();
  else vision.stop();
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
          <span class="vision-badge" :class="`vision-badge--${channelMeta.tone}`">
            <span aria-hidden="true">{{ channelMeta.glyph }}</span>{{ tr(channelMeta.label) }}
          </span>
          <span v-if="vision.configured.value" class="vision-meta">
            {{ tr('共') }} {{ vision.labs.value.length }} {{ tr('个房间') }} · {{ tr('AI 计数合计') }}
            {{ vision.totalCount.value }} · {{ tr(updatedLabel) }}
          </span>
          <button type="button" :disabled="vision.loading.value" @click="vision.refresh">{{ tr('刷新') }}</button>
          <button type="button" :aria-label="tr('关闭实验室监控')" @click="close">{{ tr('关闭') }}</button>
        </header>

        <p v-if="vision.error.value" class="vision-error" role="alert">{{ vision.error.value }}</p>

        <!-- 未接入：给配置指引，而不是显示 0 -->
        <section v-if="vision.status.value && !vision.configured.value" class="vision-setup">
          <h2>{{ tr('视觉通道尚未接入') }}</h2>
          <p>
            {{ tr('当前没有任何边缘机上报数据。视觉是辅助线索，未接入时不会显示人数，也不会用 0 冒充「没人」。') }}
          </p>
          <ol>
            <li>{{ tr('服务端设置') }} <code>VISION_INGEST_SECRET=&lt;长随机串&gt;</code> {{ tr('后重启。') }}</li>
            <li>{{ tr('无摄像头时联调') }} <code>VISION_INGEST_SECRET=dev-secret npm run mock:vision</code></li>
            <li>{{ tr('真实边缘机按') }} <code>docs/vision-agent-integration</code> {{ tr('里的上报契约对接（HMAC 签名）。') }}</li>
          </ol>
        </section>

        <template v-else-if="vision.configured.value">
          <!-- 实时画面：仅内网可达时出现 -->
          <section v-if="vision.liveAvailable.value === true && !feedFailed" class="vision-live">
            <h2>{{ tr('实时画面') }}</h2>
            <img :src="vision.feedUrl()" :alt="tr('实验室实时画面')" @error="feedFailed = true" />
            <p class="vision-live__note">{{ tr('画面只在本机/内网可达时由本服务代理，不上传云端。') }}</p>
          </section>

          <div class="vision-body">
            <section class="vision-rooms">
              <h2>{{ tr('房间监测') }}</h2>
              <p v-if="!vision.labs.value.length" class="vision-empty">
                {{ tr('已接入，但还没有任何房间上报。检查边缘机是否在发心跳。') }}
              </p>
              <ul v-else class="vision-grid">
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
                    <div><dt>{{ tr('场景') }}</dt><dd>{{ tr(sceneText(lab.sceneState)) }}</dd></div>
                    <div><dt>{{ tr('护具') }}</dt><dd>{{ tr(ppeText(lab.ppeState, lab.ppeMissing)) }}</dd></div>
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
                  <p v-else class="vision-card__noshot">{{ tr('暂无可用快照') }}</p>
                </li>
              </ul>
            </section>

            <aside class="vision-events">
              <h2>{{ tr('事件流水') }} <small>{{ vision.events.value.length }}</small></h2>
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
                  <span v-if="row.sceneState">{{ tr(sceneText(row.sceneState)) }}</span>
                  <span v-if="!row.cameraOnline" class="vision-events__off">{{ tr('摄像头离线') }}</span>
                </li>
              </ul>
            </aside>
          </div>
        </template>

        <p v-else-if="vision.loading.value" class="vision-empty">{{ tr('正在读取监控状态…') }}</p>

        <footer class="vision-footnote">
          {{ tr('画面与人脸不出实验室内网；云端只见剥离身份的 JSON；二维码签到永远是主链，视觉只做辅助。') }}
          <template v-if="vision.status.value?.retentionNote">· {{ vision.status.value.retentionNote }}</template>
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
  width: min(1120px, 100%);
  max-height: 94dvh;
  overflow: auto;
  padding: 18px;
  background: var(--surface);
  color: var(--text);
  border-radius: 10px;
  box-sizing: border-box;
  display: grid;
  gap: 14px;
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
.vision-badge--warn {
  color: var(--warning, #a16207);
  border-style: dashed;
}
.vision-badge--muted {
  color: var(--text-faint);
  border-style: dashed;
}
.vision-badge--info {
  color: var(--primary);
}
.vision-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #b91c1c);
}
.vision-setup {
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  padding: 16px;
  background: var(--surface-2);
}
.vision-setup h2 {
  margin: 0 0 8px;
  font-size: 14px;
}
.vision-setup p {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-muted);
}
.vision-setup ol {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--text-muted);
  display: grid;
  gap: 6px;
}
.vision-setup code {
  font-family: var(--font-mono, monospace);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.vision-live h2,
.vision-rooms h2,
.vision-events h2 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-muted);
}
.vision-live {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--surface-2);
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
/* 桌面优势：房间网格与事件流水同屏 */
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
.vision-card__noshot {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}
.vision-events {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--surface-2);
  position: sticky;
  top: 0;
}
.vision-events h2 small {
  color: var(--text-faint);
  font-weight: 400;
}
.vision-events ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  max-height: 60dvh;
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
