<script setup lang="ts">
/**
 * 实验室矩阵 —— 编号矩阵，不是平面图
 * ============================================================================
 *  第一阶段提示词第 1 条明确要求：「没有真实平面图时使用编号矩阵，
 *  不自行绘制虚构的楼层平面图」。所以这里按 楼宇 → 楼层 → 房间号 排布，
 *  并在界面上明说这是编号矩阵。
 *
 *  房间卡片只能携带真实字段（房间号 / 位置 / 容量 / 状态 / 描述），不补任何想象信息。
 */
import { computed } from 'vue';
import { useRunStore } from '../stores/run';
import type { Lab } from '../stores/run';
import StatusTag from './StatusTag.vue';
import type { Tone } from './ui-types';

const store = useRunStore();
const emit = defineEmits<{ ask: [string] }>();

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

function pick(lab: Lab): void {
  store.selectedLab = lab.name;
}

function ask(lab: Lab): void {
  store.selectedLab = lab.name;
  const d = store.demoDate;
  emit('ask', d ? `${lab.name} ${d} 有哪些课？` : `${lab.name} 今天有哪些课？`);
}
</script>

<template>
  <section class="matrix" aria-labelledby="matrix-h">
    <header class="matrix__head">
      <h2 id="matrix-h">实验室矩阵</h2>
      <p class="matrix__sub">
        编号矩阵（非平面图）：按楼宇 / 楼层 / 房间号排布，共
        <b>{{ store.allRooms.length }}</b> 间。
        <template v-if="store.overviewLoaded">
          课表 {{ store.timetableCount }} 条｜数据来源：{{ store.overviewSourceLabel }}
        </template>
      </p>
    </header>

    <p v-if="store.overviewError" class="matrix__err" role="alert">
      <StatusTag tone="danger" label="概览载入失败" />
      {{ store.overviewError }}
    </p>

    <div v-if="!store.overviewLoaded" class="matrix__loading">正在载入实验室清单…</div>

    <div v-else class="matrix__groups">
      <div v-for="g in store.labGroups" :key="g.key" class="group">
        <h3 class="group__title">
          {{ g.building }} <span class="group__floor">{{ g.floor }}</span>
          <span class="group__count">{{ g.rooms.length }} 间</span>
        </h3>
        <ul class="rooms">
          <li v-for="lab in g.rooms" :key="lab.id">
            <div class="room" :class="{ 'room--sel': store.selectedLab === lab.name, 'room--hit': isHit(lab) }">
              <button class="room__pick" type="button" @click="pick(lab)" :aria-pressed="store.selectedLab === lab.name">
                <span class="room__name">{{ lab.name }}</span>
                <span class="room__meta">容量 {{ lab.capacity }}</span>
              </button>
              <StatusTag
                :tone="statusMeta(lab.status).tone"
                :glyph="statusMeta(lab.status).glyph"
                :label="statusMeta(lab.status).label"
              />
              <p class="room__loc">{{ lab.location || '位置未录入' }}</p>
              <p v-if="lab.description" class="room__desc">{{ lab.description }}</p>
              <button class="room__ask" type="button" @click="ask(lab)">
                问这个房间的课<span class="sr-only">（{{ lab.name }}）</span>
              </button>
              <StatusTag v-if="isHit(lab)" tone="info" glyph="◉" label="本次查询命中" class="room__hit" />
            </div>
          </li>
        </ul>
      </div>
    </div>
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
  letter-spacing: 0.02em;
}
.matrix__sub {
  margin: 0 0 var(--sp-3);
  color: var(--text-muted);
  font-size: 12px;
}
.matrix__err {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--danger);
  font-size: 12px;
}
.matrix__loading {
  color: var(--text-faint);
  font-size: 13px;
  padding: var(--sp-4) 0;
}
.matrix__groups {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.group__title {
  margin: 0 0 var(--sp-2);
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.group__floor {
  color: var(--text);
  font-weight: 700;
  font-size: 13px;
}
.group__count {
  margin-left: auto;
  font-weight: 400;
  color: var(--text-faint);
}
.rooms {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(156px, 1fr));
  gap: var(--sp-2);
}
.room {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 0.12s, background 0.12s;
}
.room--sel {
  border-color: var(--primary-border);
  background: var(--primary-weak);
}
/* 命中用「粗左边框 + 角标文字」表示，不只靠颜色 */
.room--hit {
  border-left: 4px solid var(--info);
  padding-left: 9px;
}
.room__pick {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
}
.room__name {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.room__meta {
  font-size: 11px;
  color: var(--text-faint);
}
.room__loc,
.room__desc {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}
.room__desc {
  color: var(--text-faint);
}
.room__ask {
  margin-top: 4px;
  align-self: flex-start;
  background: none;
  border: none;
  border-bottom: 1px dashed var(--border-strong);
  border-radius: 0;
  color: var(--text-faint);
  font-size: 11px;
  padding: 0 0 1px;
  cursor: pointer;
}
.room__ask:hover,
.room__ask:focus-visible {
  color: var(--primary);
  border-bottom-color: var(--primary-border);
}
.room:hover .room__name {
  color: var(--primary);
}
.room__hit {
  position: absolute;
  top: -8px;
  right: 6px;
}

/* 手机：3 列紧凑排布，把矩阵高度压下来（否则 13 间房会拉出 850px+ 的一列） */
@media (max-width: 640px) {
  .rooms {
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 6px;
  }
  .room {
    padding: 8px;
    gap: 3px;
  }
  .room__pick {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }
  .room__name {
    font-size: 14px;
  }
  /* 描述文字在小卡片里放不下，且不是决策必需信息 */
  .room__desc {
    display: none;
  }
  .room__ask {
    font-size: 10px;
    padding: 0 5px;
  }
}
</style>
