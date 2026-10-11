<script setup lang="ts">
import {t as tr} from "../../i18n";
import type {NativeReport} from '@shared/business';
defineProps<{report:NativeReport}>();
const coverage:Record<string,string>={complete:'已覆盖',out_of_range:'超出校历',unknown:'依据不足',current_visible:'当前可见状态'};
</script>
<template><div class="native-report"><p>{{report.date}} · {{report.scope.label}}</p><p>{{report.note}}</p><p class="native-card__source">{{tr("查询")}} {{report.queriedAt}} {{tr("· 日报版本")}} {{report.reportRevision}}</p><div v-for="m in report.metrics" :key="m.key" class="object-row"><b>{{m.label}}：{{tr(m.value===null?'未知 / 待核实':m.value)}}</b><p>{{coverage[m.coverage]||m.coverage}} · {{m.source}} {{tr("· 有效时间")}} {{m.effectiveAt}}</p><p v-if="m.note">{{m.note}}</p><details><summary>{{tr("统计对象依据")}}</summary><p>{{tr(m.objectIds.join('、')||(m.value===null?'未取得完整统计依据':'该范围无记录'))}}</p><p>{{m.sourceRevision}}</p></details></div></div></template>
