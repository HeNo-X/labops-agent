<script setup lang="ts">
import {t as tr} from "../i18n";
/**
 * 任务结果区 —— 按 resultKind 分流渲染
 * ============================================================================
 *  · schedule_hit / schedule_empty / config_insufficient → 课表卡（结构化课程明细）
 *  · lab_status    → 房间状态卡（档案 + 当日概况 + 在室人数明确"未知"）
 *  · free_rooms    → 空闲房间卡（按节次分组）
 *  · none          → 不渲染
 *  数据依据（来源/指纹/覆盖口径/条件说明）默认折叠 —— 结论与明细在前，取证在后。
 *
 *  安全约束：组件只接受经过校验的结构化数据，不插入模型返回的任意 HTML；
 *  模型文本一律走 `{{ }}` 插值（自动转义）。
 */
import { computed } from 'vue';
import { useRunStore } from '../stores/run';
import { PERIODS } from '@shared/periods';
import type { EngineType, FreeRoomsResult, LabStatusResult, ScheduleQueryResult } from '@shared/types';
import StatusTag from './StatusTag.vue';
import SourceBadge from './SourceBadge.vue';
import type { Tone } from './ui-types';

/**
 * N03：结果卡改为**纯 props 输入** —— 一条助手消息拥有自己的结果卡；
 * 不传 artifact 时回退到全局 run store（仅活跃轮渲染使用），历史与实时共用同一渲染器。
 * 注意：本组件只渲染查询类结果（schedule / lab_status / free_rooms）；
 * 提案卡与日报卡分别由 OperationCard / ReportCard 渲染。
 */
const props = defineProps<{
  artifact?: { kind: 'schedule' | 'lab_status' | 'free_rooms'; result: ScheduleQueryResult | LabStatusResult | FreeRoomsResult };
  engine?: EngineType | null;
}>();

const store = useRunStore();

type UiKind = 'none' | 'schedule_hit' | 'schedule_empty' | 'config_insufficient' | 'lab_status' | 'free_rooms';
const kind = computed<UiKind>(() => {
  if (props.artifact) {
    if (props.artifact.kind !== 'schedule') return props.artifact.kind;
    const sr = props.artifact.result as ScheduleQueryResult;
    if (!sr.weekDeterminable || sr.reason === 'timetable_empty') return 'config_insufficient';
    return sr.reason === 'ok' ? 'schedule_hit' : 'schedule_empty';
  }
  return store.resultKind;
});

const r = computed<ScheduleQueryResult | null>(() => {
  if (props.artifact) return props.artifact.kind === 'schedule' ? (props.artifact.result as ScheduleQueryResult) : null;
  return store.lastResult;
});
const extra = computed(() => {
  if (props.artifact) {
    return props.artifact.kind === 'schedule'
      ? null
      : { kind: props.artifact.kind, payload: props.artifact.result as LabStatusResult | FreeRoomsResult };
  }
  return store.extraResult;
});
const engineOf = computed<EngineType | null>(() => props.engine ?? store.activeEngine);

const kindTag = computed<{ tone: Tone; glyph: string; label: string }>(() => {
  switch (kind.value) {
    case 'none':
      return { tone: 'neutral', glyph: '○', label: '无结果' };
    case 'schedule_hit':
      return { tone: 'ok', glyph: '✓', label: '课表命中' };
    case 'schedule_empty':
      return { tone: 'warn', glyph: '▲', label: '无匹配结果' };
    case 'config_insufficient':
      return { tone: 'warn', glyph: '▲', label: '结果有条件' };
    case 'lab_status':
      return { tone: 'ok', glyph: '▣', label: '房间状态' };
    case 'free_rooms':
      return { tone: 'ok', glyph: '▣', label: '空闲房间' };
    default:
      return { tone: 'neutral', glyph: '○', label: '未知' };
  }
});

const REASON_TEXT: Record<string, string> = {
  ok: '已找到排课记录',
  lab_not_found: '系统中没有这个房间号',
  no_class_that_day: '该房间当天没有排课',
  no_class_in_that_period: '该房间当天该节次没有排课',
  lab_not_active: '该房间当前不在开放状态，且当天没有排课',
  timetable_empty: '系统内课表为空'
};

const reasonText = computed(() => (r.value ? REASON_TEXT[r.value.reason] ?? r.value.reason : ''));

const statusMeta: Record<string, { tone: Tone; glyph: string }> = {
  active: { tone: 'ok', glyph: '✓' },
  closed: { tone: 'neutral', glyph: '○' },
  inactive: { tone: 'warn', glyph: '▲' }
};

function fmtIso(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function weeksText(w: { from: number; to: number; parity: string }): string {
  const p = w.parity === 'odd' ? '单周' : w.parity === 'even' ? '双周' : '每周';
  return `第 ${w.from}-${w.to} 周 · ${p}`;
}

/** 节次条：命中节次用「实心 + 文字计数」表示，未命中用空心，不靠颜色区分 */
const periodBars = computed(() =>
  PERIODS.map((p) => {
    const hit = r.value?.byPeriod?.find((b) => b.periodKey === p.key);
    const count = hit?.count ?? 0;
    return { ...p, count, hit: count > 0 };
  })
);

function labStatusOf(l: FreeRoomsResult['freeByPeriod'][number]['rooms'][number]): string {
  if (l.status === 'active') return '';
  return l.status === 'inactive' ? '（停用/修整）' : '（关闭）';
}

/** 空闲房间卡：默认只展开"有空房"的节次？不 —— 全部折叠由用户展开会看不到重点。
 *  这里选择：卡片直接列出每节次的空闲房号（等宽短行），房间数多的节次折叠。 */
const freeList = computed(() => {
  const fr = extra.value?.payload as FreeRoomsResult | undefined;
  if (!fr || extra.value?.kind !== 'free_rooms') return [];
  return fr.freeByPeriod.map((p) => ({ ...p, compact: p.rooms.length > 8 }));
});
</script>

<template>
  <!-- 无结果：不渲染 -->
  <template v-if="kind !== 'none'" />

  <section v-if="r && (kind === 'schedule_hit' || kind === 'schedule_empty' || kind === 'config_insufficient')" class="res" aria-labelledby="res-h">
    <header class="res__head">
      <h2 id="res-h" class="sr-only">{{tr("查询结果与依据")}}</h2>
      <StatusTag :tone="kindTag.tone" :glyph="kindTag.glyph" :label="kindTag.label" />
    </header>

    <!-- 配置不足：必须显眼，且说明"这是有条件的结论" -->
    <div v-if="kind === 'config_insufficient'" class="alert alert--warn" role="status">
      <StatusTag tone="warn" label="配置不足" />
      <p class="alert__msg">
        {{tr(r && !r.weekDeterminable ? '无法确定该日期属于第几教学周。' : '课表数据为空。')}} {{tr("下面显示的是按已知数据能给出的**有条件**结果，请勿直接当作最终排课。")}} </p>
      <p v-if="r?.weekNote" class="alert__hint">{{ r.weekNote }}</p>
    </div>

    <!-- 无匹配 -->
    <div v-else-if="kind === 'schedule_empty'" class="alert alert--warn" role="status">
      <StatusTag tone="warn" label="无匹配结果" />
      <p class="alert__msg">{{ reasonText }}{{tr("。系统没有编造任何课程。")}}</p>
      <div v-if="r?.suggestions?.length" class="suggest">
        <span class="suggest__label">{{tr("可选房间号：")}}</span>
        <span v-for="s in r.suggestions" :key="s" class="suggest__item">{{ s }}</span>
      </div>
    </div>

    <!-- 命中 -->
    <div v-else-if="r" class="hit">
      <div class="hit__head">
        <strong class="hit__room">{{ r.labName }}</strong>
        <span class="hit__loc">{{ r.labLocation }}</span>
        <span class="hit__when">{{ r.date }}（{{ r.weekdayLabel }}）</span>
        <StatusTag
          v-if="r.weekNo !== null"
          tone="info"
          :label="`第 ${r.weekNo} 教学周 · ${r.weekNo % 2 === 1 ? '单周' : '双周'}`"
        />
        <StatusTag v-else tone="warn" label="教学周无法确定" />
      </div>

      <div class="bars" role="img" :aria-label="`当天排课分布：${periodBars.map((b) => `${b.label}${b.count}条`).join('，')}`">
        <span
          v-for="b in periodBars"
          :key="b.key"
          class="bar"
          :class="{ 'bar--hit': b.hit }"
          :title="`${b.label} ${b.start}-${b.end}：${b.count} 条`"
        >
          <span class="bar__sym" aria-hidden="true">{{ b.hit ? '▮' : '▯' }}</span>
          <span class="bar__label">{{tr(b.label.replace('上午第', '上午').replace('下午第', '下午').replace('大节', ''))}}</span>
          <span class="bar__count">{{ b.count }}</span>
        </span>
      </div>

      <ul class="lessons">
        <li v-for="(l, i) in r.lessons" :key="`${l.timetableId}-${i}`" class="lesson">
          <div class="lesson__time">
            <span class="lesson__period">{{ l.periodLabel }}</span>
            <span class="lesson__clock">{{ l.startTime }}–{{ l.endTime }}</span>
          </div>
          <div class="lesson__main">
            <span class="lesson__course">{{ l.courseName }}</span>
            <StatusTag v-if="l.merged" tone="info" glyph="⧉" shape="dashed" label="合班" />
          </div>
          <div class="lesson__meta">
            <span>{{ l.teacher }}</span>
            <span class="lesson__sep">·</span>
            <span>{{ l.className }}</span>
            <span class="lesson__sep">·</span>
            <span>{{ weeksText(l.weeks) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <!-- 数据依据：默认折叠 -->
    <details class="prov">
      <summary class="prov__sum">{{tr("数据依据与条件说明")}}</summary>
      <div class="prov__body">
        <div class="prov__badges">
          <SourceBadge :source-type="r.provenance.sourceType" :engine="engineOf" />
        </div>
        <dl class="prov__list">
          <div class="prov__row">
            <dt>{{tr("数据类型")}}</dt>
            <dd>{{ r.provenance.sourceLabel }}（{{ r.provenance.sourceType }}）</dd>
          </div>
          <div class="prov__row">
            <dt>{{tr("数据覆盖")}}</dt>
            <dd>{{ r.provenance.coverage }}</dd>
          </div>
          <div class="prov__row">
            <dt>{{tr("查询时间")}}</dt>
            <dd>{{ fmtIso(r.provenance.queryTime) }}（{{ r.provenance.timezone }}）</dd>
          </div>
          <div v-if="r.provenance.snapshotAt" class="prov__row">
            <dt>{{tr("快照导出时间")}}</dt>
            <dd>{{ fmtIso(r.provenance.snapshotAt) }}</dd>
          </div>
          <div v-if="r.provenance.sourceSha256Prefix" class="prov__row">
            <dt>{{tr("源数据指纹")}}</dt>
            <dd class="prov__mono">{{tr("sha256 前 16 位：")}}{{ r.provenance.sourceSha256Prefix }}</dd>
          </div>
          <div class="prov__row">
            <dt>{{tr("查询条件")}}</dt>
            <dd class="prov__mono">
              labName={{ r.labName }}，date={{ r.date }}<template v-if="r.periodFilter">，periodKey={{ r.periodFilter }}</template>
            </dd>
          </div>
        </dl>
        <template v-if="r.notes.length">
          <h4 class="prov__h4">{{tr("条件说明（必须一并阅读）")}}</h4>
          <ul class="notes">
            <li v-for="(n, i) in r.notes" :key="i">{{ n }}</li>
          </ul>
        </template>
      </div>
    </details>
  </section>

  <!-- 房间状态卡 -->
  <section v-else-if="extra && extra.kind === 'lab_status'" class="res" :aria-label="tr('房间状态')">
    <header class="res__head">
      <StatusTag :tone="kindTag.tone" :glyph="kindTag.glyph" :label="kindTag.label" />
    </header>
    <template v-if="(extra.payload as LabStatusResult).labName === null">
      <div class="alert alert--warn" role="status">
        <p class="alert__msg">{{tr("系统中没有这个房间号，未编造任何数据。")}}</p>
        <div v-if="(extra.payload as LabStatusResult).suggestions.length" class="suggest">
          <span class="suggest__label">{{tr("可选房间号：")}}</span>
          <span v-for="s in (extra.payload as LabStatusResult).suggestions" :key="s" class="suggest__item">{{ s }}</span>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="hit">
        <div class="hit__head">
          <strong class="hit__room">{{ (extra.payload as LabStatusResult).labName }}</strong>
          <span class="hit__loc">{{ (extra.payload as LabStatusResult).labLocation }}</span>
          <StatusTag
            :tone="statusMeta[(extra.payload as LabStatusResult).status ?? 'closed']?.tone ?? 'neutral'"
            :glyph="statusMeta[(extra.payload as LabStatusResult).status ?? 'closed']?.glyph ?? '○'"
            :label="`${(extra.payload as LabStatusResult).statusLabel} · 容量 ${(extra.payload as LabStatusResult).capacity ?? '未知'}`"
          />
        </div>
        <p v-if="(extra.payload as LabStatusResult).description" class="labdesc">{{ (extra.payload as LabStatusResult).description }}</p>
        <dl class="labfacts">
          <div class="prov__row">
            <dt>{{tr("当日排课")}}</dt>
            <dd>
              {{ (extra.payload as LabStatusResult).schedule.lessonCount }} {{tr("条（")}}{{ (extra.payload as LabStatusResult).date }}
              {{ (extra.payload as LabStatusResult).weekdayLabel }}）
            </dd>
          </div>
          <div class="prov__row">
            <dt>{{tr("占用节次")}}</dt>
            <dd>
              <template v-if="(extra.payload as LabStatusResult).schedule.occupiedPeriods.length">
                <span v-for="p in (extra.payload as LabStatusResult).schedule.occupiedPeriods" :key="p.periodKey" class="suggest__item">
                  {{ p.periodLabel }} {{ p.courseNames.join('、') }}
                </span>
              </template>
              <template v-else>{{tr("无")}}</template>
            </dd>
          </div>
          <div class="prov__row">
            <dt>{{tr("下一节课")}}</dt>
            <dd>
              <template v-if="(extra.payload as LabStatusResult).schedule.nextLesson">
                {{ (extra.payload as LabStatusResult).schedule.nextLesson!.startTime }}
                《{{ (extra.payload as LabStatusResult).schedule.nextLesson!.courseName }}》（{{ (extra.payload as LabStatusResult).schedule.nextLesson!.periodLabel }}）
              </template>
              <template v-else-if="(extra.payload as LabStatusResult).schedule.nextLessonReason === 'not_applicable'"> {{tr("所查日期非今天，此处不提供\"下一节课\"——请看当天排课明细")}} </template>
              <template v-else-if="(extra.payload as LabStatusResult).schedule.nextLessonReason === 'unknown'"> {{tr("无法确定（教学周不可判定）")}} </template>
              <template v-else>{{tr("当天剩余时间没有更多排课")}}</template>
            </dd>
          </div>
          <div class="prov__row">
            <dt>{{tr("在室人数")}}</dt>
            <dd v-if="(extra.payload as LabStatusResult).occupancy">
              {{ (extra.payload as LabStatusResult).occupancy!.present }} {{tr("人（")}}{{ (extra.payload as LabStatusResult).occupancy!.date }}{{tr("） —— 当日有效签到−有效签退，与主系统页面同源；逐人明细未开放，记录数口径不等于\"此刻屋里一定有人\"")}} </dd>
            <dd v-else class="alert__hint">{{tr("未知 —— 当前没有取到签到数据（业务通道未连接或未取得授权），请勿据此判断")}}</dd>
          </div>
        </dl>
      </div>
      <details class="prov">
        <summary class="prov__sum">{{tr("数据依据与条件说明")}}</summary>
        <div class="prov__body">
          <div class="prov__badges">
            <SourceBadge :source-type="(extra.payload as LabStatusResult).provenance.sourceType" :engine="engineOf" />
          </div>
          <ul class="notes">
            <li v-for="(n, i) in (extra.payload as LabStatusResult).notes" :key="i">{{ n }}</li>
          </ul>
        </div>
      </details>
    </template>
  </section>

  <!-- 空闲房间卡 -->
  <section v-else-if="extra && extra.kind === 'free_rooms'" class="res" :aria-label="tr('空闲房间')">
    <header class="res__head">
      <StatusTag :tone="kindTag.tone" :glyph="kindTag.glyph" :label="kindTag.label" />
      <span class="hit__when">
        {{ (extra.payload as FreeRoomsResult).date }}（{{ (extra.payload as FreeRoomsResult).weekdayLabel }}）
        <template v-if="(extra.payload as FreeRoomsResult).weekNo !== null"> {{tr("· 第")}} {{ (extra.payload as FreeRoomsResult).weekNo }} {{tr("教学周")}} </template>
      </span>
    </header>
    <!-- R08：覆盖不足 → 无法判断，候选是"未知"而不是"无空闲" -->
    <div v-if="(extra.payload as FreeRoomsResult).coverage !== 'complete'" class="alert alert--warn" role="status">
      <p class="alert__msg">
        {{tr((extra.payload as FreeRoomsResult).coverage === 'missing'
            ? '课表数据为空，无法判断哪些房间空闲。'
            : (extra.payload as FreeRoomsResult).coverage === 'out_of_range'
              ? '日期超出学期覆盖范围，无法判断空闲。'
              : '学期结束日未配置（或教学周不可确定），无法证明该日期的课表完整覆盖。')}} {{tr("下列候选的空闲状态**未知**，不能作为可用推荐。")}} </p>
      <div v-if="(extra.payload as FreeRoomsResult).unknownCandidates.length" class="suggest">
        <span class="suggest__label">{{tr("未知候选（非确认空闲）：")}}</span>
        <span v-for="u in (extra.payload as FreeRoomsResult).unknownCandidates" :key="u" class="suggest__item">{{ u }}</span>
      </div>
    </div>
    <ul v-if="(extra.payload as FreeRoomsResult).coverage === 'complete'" class="freelist">
      <li v-for="p in freeList" :key="p.periodKey" class="freetier">
        <span class="freetier__period">{{ p.periodLabel }}（{{ p.startTime }}–{{ p.endTime }}）</span>
        <span v-if="p.rooms.length" class="freetier__rooms">
          <span v-for="room in p.rooms" :key="room.labName" class="suggest__item" :title="`${room.labName} ${room.location ?? ''} 容量 ${room.capacity ?? '未知'}`">
            {{ room.labName }}{{ labStatusOf(room) }}
          </span>
        </span>
        <span v-else class="freetier__none">{{tr("无空闲房间")}}</span>
      </li>
    </ul>
    <details class="prov">
      <summary class="prov__sum">{{tr("数据依据与条件说明")}}</summary>
      <div class="prov__body">
        <ul class="notes">
          <li v-for="(n, i) in (extra.payload as FreeRoomsResult).notes" :key="i">{{ n }}</li>
        </ul>
      </div>
    </details>
  </section>
</template>

<style scoped>
.res {
  border-top: 1px dashed var(--border);
  padding-top: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.res__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.alert {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--sp-3);
  border-radius: var(--radius);
  border: 1px solid;
}
.alert--warn {
  background: var(--warn-bg);
  border-color: var(--warn-border);
  color: var(--warn);
}
.alert__msg {
  margin: 0;
  color: var(--text);
  font-size: calc(var(--ui-font-size) * 1.0);
}
.alert__hint {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-muted);
}
.suggest {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.suggest__label {
  color: var(--text-muted);
}
.suggest__item {
  font-family: var(--font-mono);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 6px;
}
.hit__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.hit__room {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) * 1.38462);
  letter-spacing: 0.03em;
}
.hit__loc,
.hit__when {
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-muted);
}
.hit__when {
  font-family: var(--font-mono);
}
.labdesc {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-muted);
}
.labfacts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bars {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
  background: var(--surface-2);
}
.bar--hit {
  border-style: solid;
  border-color: var(--info-border);
  background: var(--info-bg);
  color: var(--info);
}
.bar__sym {
  font-size: calc(var(--ui-font-size) * 0.76923);
}
.bar__count {
  font-family: var(--font-mono);
  font-weight: 700;
}
.lessons {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.lesson {
  display: grid;
  grid-template-columns: 128px 1fr;
  grid-template-areas: 'time main' 'time meta';
  gap: 2px var(--sp-3);
  padding: var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary-border);
  border-radius: var(--radius);
}
.lesson__time {
  grid-area: time;
  display: flex;
  flex-direction: column;
}
.lesson__period {
  font-size: calc(var(--ui-font-size) * 0.92308);
  font-weight: 600;
}
.lesson__clock {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.lesson__main {
  grid-area: main;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.lesson__course {
  font-size: calc(var(--ui-font-size) * 1.07692);
  font-weight: 600;
}
.lesson__meta {
  grid-area: meta;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-muted);
}
.lesson__sep {
  margin: 0 4px;
  color: var(--text-faint);
}
.freelist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.freetier {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.freetier__period {
  font-size: calc(var(--ui-font-size) * 0.92308);
  font-weight: 600;
}
.freetier__rooms {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.freetier__none {
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-faint);
}
.prov {
  border-top: 1px dashed var(--border);
  padding-top: var(--sp-2);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.prov__sum {
  cursor: pointer;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
  user-select: none;
}
.prov__body {
  margin-top: var(--sp-2);
}
.prov__badges {
  margin-bottom: var(--sp-2);
}
.prov__list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.prov__row {
  display: flex;
  gap: var(--sp-3);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.prov__row dt {
  flex: 0 0 96px;
  color: var(--text-faint);
}
.prov__row dd {
  margin: 0;
  color: var(--text-muted);
  word-break: break-word;
}
.prov__mono {
  font-family: var(--font-mono);
}
.prov__h4 {
  margin: var(--sp-3) 0 var(--sp-1);
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-muted);
}
.notes {
  margin: 0;
  padding-left: 18px;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-muted);
}
.notes li {
  margin-bottom: 2px;
}

@media (max-width: 640px) {
  .lesson {
    grid-template-columns: 1fr;
    grid-template-areas: 'time' 'main' 'meta';
  }
  .prov__row {
    flex-direction: column;
    gap: 0;
  }
  .prov__row dt {
    flex: none;
  }
}
</style>
