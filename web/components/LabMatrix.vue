<script setup lang="ts">
/**
 * 实验室房间清单 —— 侧栏辅助，不是主角
 * ============================================================================
 *  第一阶段提示词明确要求：「没有真实平面图时使用编号矩阵，不自行绘制虚构的楼层
 *  平面图」。这里按 楼宇 → 楼层 → 房间号 排布成**紧凑行清单**（不再是大卡片墙），
 *  配搜索框（按房号/位置过滤）。房间行只能携带真实字段（房号 / 位置 / 容量 / 状态）。
 *  点击房间行 = 立即就该房间发起课表任务（主区任务流承接）。
 */
import { computed, ref } from 'vue';
import { useRunStore } from '../stores/run';
import type { Lab } from '../stores/run';
import StatusTag from './StatusTag.vue';
import type { Tone } from './ui-types';

const store = useRunStore();
const emit = defineEmits<{ ask: [string] }>();
const keyword = ref('');

/** 实验室状态 → 展示口径。不靠颜色区分：文字 + 符号 + 边框都不同。 */
function statusMeta(status: string): { tone: Tone; label: string; glyph: string } {
  switch (status) {
    case 'active':
      return { tone: 'ok', label: '开放', glyph: '✓' };
    case 'closed':
      return { tone: 'neutral', label: '关闭', glyph: '○' };
    case 'inactive':
      return { tone: 'warn', label: '停用/修整', glyph: '▲' };
    default:
      return { tone: 'warn', label: `未知(${status || '空'})`, glyph: '?' };
  }
}

/** 结果里命中的房间 → 打标。用形状而非颜色区分。 */
const hitRoom = computed(() => store.lastResult?.labName ?? null);

function isHit(lab: Lab): boolean {
  return hitRoom.value !== null && hitRoom.value === lab.name;
}

const filteredGroups = computed(() => {
  const kw = keyword.value.trim().toUpperCase();
  if (!kw) return store.labGroups;
  return store.labGroups
    .map((g) => ({
      ...g,
      rooms: g.rooms.filter((r) => r.name.toUpperCase().includes(kw) || (r.location ?? '').toUpperCase().includes(kw))
    }))
    .filter((g) => g.rooms.length > 0);
});

function ask(lab: Lab): void {
  store.selectedLab = lab.name;
  const d = store.demoDate;
  emit('ask', d ? `${lab.name} ${d} 有哪些课？` : `${lab.name} 今天有哪些课？`);
}
</script>

<template>
  <section class="matrix" aria-labelledby="matrix-h">
    <header class="matrix__head">
      <h2 id="matrix-h">房间清单</h2>
      <p class="matrix__sub">
        按楼宇 / 楼层 / 房间号排布，共 <b>{{ store.allRooms.length }}</b> 间。点击房间即发起课表查询。
      </p>
    </header>

    <p v-if="store.overviewError" class="matrix__err" role="alert">
      <StatusTag tone="danger" label="概览载入失败" />
      {{ store.overviewError }}
    </p>

    <div v-if="!store.overviewLoaded" class="matrix__loading">正在载入房间清单…</div>

    <template v-else>
      <div class="matrix__search">
        <label class="sr-only" for="room-kw">搜索房间</label>
        <input
          id="room-kw"
          v-model="keyword"
          type="search"
          class="matrix__kw"
          placeholder="搜房号或位置，如 E310 / E区"
          autocomplete="off"
        />
      </div>

      <div class="matrix__groups">
        <div v-for="g in filteredGroups" :key="g.key" class="group">
          <h3 class="group__title">
            {{ g.building }} <span class="group__floor">{{ g.floor }}</span>
            <span class="group__count">{{ g.rooms.length }} 间</span>
          </h3>
          <ul class="rooms">
            <li v-for="lab in g.rooms" :key="lab.id">
              <button
                type="button"
                class="room"
                :class="{ 'room--sel': store.selectedLab === lab.name, 'room--hit': isHit(lab) }"
                :title="`${lab.name}：${lab.location}，容量 ${lab.capacity}，点击查询该房间课表`"
                @click="ask(lab)"
              >
                <span class="room__code">{{ lab.name }}</span>
                <span class="room__meta">
                  <span class="room__cap">容量 {{ lab.capacity }}</span>
                  <StatusTag :tone="statusMeta(lab.status).tone" :glyph="statusMeta(lab.status).glyph" :label="statusMeta(lab.status).label" />
                </span>
              </button>
            </li>
          </ul>
        </div>
        <p v-if="!filteredGroups.length" class="matrix__loading">没有匹配「{{ keyword }}」的房间。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.matrix {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-1);
}
.matrix__head h2 {
  margin: 0 0 var(--sp-1);
  font-size: 15px;
}
.matrix__sub {
  margin: 0 0 var(--sp-3);
  font-size: 12px;
  color: var(--text-faint);
}
.matrix__err {
  margin: 0 0 var(--sp-2);
  font-size: 12px;
  color: var(--danger);
}
.matrix__loading {
  margin: 0;
  padding: var(--sp-3) 0;
  font-size: 12px;
  color: var(--text-faint);
}
.matrix__search {
  margin-bottom: var(--sp-3);
}
.matrix__kw {
  width: 100%;
  box-sizing: border-box;
  padding: 6px var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.matrix__kw:focus-visible {
  outline: 2px solid var(--primary-border);
  outline-offset: 1px;
}
.group {
  margin-bottom: var(--sp-3);
}
.group:last-child {
  margin-bottom: 0;
}
.group__title {
  margin: 0 0 var(--sp-1);
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.group__floor {
  color: var(--text-faint);
  font-weight: 400;
}
.group__count {
  margin-left: auto;
  color: var(--text-faint);
  font-weight: 400;
}
.rooms {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.room {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 6px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.room:hover {
  border-color: var(--primary-border);
  background: var(--primary-weak);
}
.room--sel {
  border-color: var(--primary-border);
}
.room--hit {
  border-color: var(--ok);
  border-style: solid;
  box-shadow: inset 3px 0 0 var(--ok);
}
.room__code {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
}
.room__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.room__cap {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
