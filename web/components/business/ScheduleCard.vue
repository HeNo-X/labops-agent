<script setup lang="ts">
import {t as tr} from "../../i18n";
import {useNativeCard} from '../../business/controller';
const {result,readonly,context,candidates,date,timetableId,reason,source,showAllCandidates,busy,showExcluded,admin,eligible,visibleCandidates,period,dirty,compare,choose}=useNativeCard();
</script>
<template>
   <div v-if="result.view==='schedule'" class="native-card__section">
    <p v-if="source">{{tr("原安排：")}}{{source.courseName}} · {{source.labName}} · {{period(source.periodKey)}} · {{date}}</p>
    <form v-if="admin&&!readonly" class="native-form" @submit.prevent="compare">
     <label>{{tr("日期")}}<input :aria-label="tr('日期')" v-model="date" type="date" required @input="dirty"></label><label>{{tr("原课程")}}<select :aria-label="tr('原课程')" v-model="timetableId" required @change="dirty"><option value="">{{tr("请选择原课程")}}</option><option v-for="r in context?.timetable||[]" :key="r.id" :value="r.id">{{r.courseName}} · {{r.labName}} · {{period(r.periodKey)}}</option></select></label>
     <label class="wide">{{tr("调课原因")}}<input v-model="reason" :placeholder="tr('填写已观察到的问题与调课原因')" required @input="dirty"></label><button :disabled="busy">{{tr("比较 / 重新计算")}}</button>
    </form>
    <ol class="candidate-list"><li v-for="(c,i) in visibleCandidates" :key="c.roomId+c.periodKey"><div><b>{{tr("方案")}} {{i+1}} · {{c.roomName}} · {{period(c.periodKey)}}</b><p>{{c.headcount}} {{tr("人 / 容量")}} {{c.capacity}} {{tr("· 设备")}} {{tr(c.requiredEquipment?.join('、')||'无额外要求')}} {{tr("· 无房间、教师或班级冲突")}}</p></div><button v-if="!readonly" :disabled="busy" @click="choose(c)">{{tr("选择并准备")}}</button></li></ol>
    <button v-if="eligible.length>3" class="quiet" @click="showAllCandidates=!showAllCandidates">{{tr(showAllCandidates?'收起其他可行方案':'查看全部可行方案（'+eligible.length+'）')}}</button>
    <button v-if="candidates.some(c=>!c.eligible)" class="quiet" @click="showExcluded=!showExcluded">{{tr(showExcluded?'收起':'查看')}}{{tr("排除原因")}}</button><ul v-if="showExcluded" class="excluded-list"><li v-for="c in candidates.filter(c=>!c.eligible)" :key="c.roomId+c.periodKey">{{c.roomName}} · {{period(c.periodKey)}}：{{c.reasons.join('；')}}</li></ul>
   </div>
</template>
