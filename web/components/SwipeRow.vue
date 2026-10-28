<script setup lang="ts">
/**
 * 滑动操作行（批次 C）—— 会话列表左滑露出 置顶/改名/删除（iOS Mail 式）。
 * Pointer 跟手 + 轴向意图判定；点按已展开行 = 收起（不触发导航）；
 * 松手过半自动吸附展开/收起；动作按钮直排于行内容之下（右侧）。
 */
import { computed, ref } from 'vue';
import { t as tr } from '../i18n';

const props = defineProps<{ actions: Array<{ label: string; danger?: boolean; run: () => void }> }>();

const offset = ref(0);
const open = ref(false);
const animating = ref(false);
let drag: { id: number; x0: number; y0: number; horizontal: boolean | null } | null = null;
/** 本轮为真实拖动时，松手后的 click 必须吞掉（否则拖完直接触发行内导航） */
let suppressClick = false;

const width = computed(() => Math.min(200, Math.max(88, props.actions.length * 60)));

function down(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, horizontal: null };
  animating.value = false;
}
function move(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return;
  const mx = e.clientX - drag.x0;
  const my = e.clientY - drag.y0;
  if (drag.horizontal === null) {
    if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
    if (Math.abs(mx) > Math.abs(my)) drag.horizontal = true;
    else { drag = null; return; }
  }
  suppressClick = true;
  const base = open.value ? -width.value : 0;
  offset.value = Math.min(0, Math.max(-width.value, base + mx));
}
function up(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  animating.value = true;
  const shouldOpen = offset.value < -width.value / 2;
  open.value = shouldOpen;
  offset.value = shouldOpen ? -width.value : 0;
  if (suppressClick) window.setTimeout(() => (suppressClick = false), 60);
}
function collapse(): void {
  animating.value = true;
  open.value = false;
  offset.value = 0;
}
/** 拖动后或行已展开时，拦截点按：本击只收起/吞掉，不触发内容点击（导航） */
function captureClick(e: Event): void {
  if (suppressClick) {
    // 拖动刚结束的这一次 click 只吞掉：展开/收起由松手吸附逻辑决定（此处再 collapse 会把刚展开的行合上）
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  if (open.value) {
    e.stopPropagation();
    e.preventDefault();
    collapse();
  }
}
function act(a: { run: () => void }): void {
  collapse();
  a.run();
}
</script>

<template>
  <div class="swipe-row">
    <div class="swipe-row__actions" :aria-hidden="!open">
      <button v-for="a in actions" :key="a.label" type="button" :class="{ 'swipe-row__danger': a.danger }" @click="act(a)">{{ tr(a.label) }}</button>
    </div>
    <div
      class="swipe-row__main"
      :style="{ transform: `translateX(${Math.round(offset)}px)`, transition: animating ? 'transform 200ms var(--m-ease, ease-out)' : 'none' }"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @click.capture="captureClick"
      @dragstart.prevent
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.swipe-row {
  position: relative;
  overflow: hidden;
  min-width: 0;
}
.swipe-row__actions {
  position: absolute;
  inset: 0 0 0 auto;
  display: flex;
  gap: 3px;
  padding: 3px 0;
  align-items: stretch;
}
.swipe-row__actions button {
  width: 56px;
  min-height: 100%;
  border-radius: 10px;
  font-size: calc(var(--ui-font-size) * 0.92);
  background: var(--m-tonal, var(--surface-3));
  padding: 4px 2px;
  overflow: hidden;
}
.swipe-row__danger {
  background: var(--danger) !important;
  color: #fff !important;
}
.swipe-row__main {
  position: relative;
  background: var(--m-card, var(--surface));
  touch-action: pan-y;
  /* 滑动操作行的内容禁选中/禁原生拖拽：否则按下横拖会先触发文本拖选，中断手势 */
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}
@media (prefers-reduced-motion: reduce) {
  .swipe-row__main {
    transition: none !important;
  }
}
</style>
