<script setup lang="ts">
import {useNativeCard} from '../../business/controller';
const {result,readonly,context,date,reason,roomId,endDate,busy,admin,dirty,prepare,PERIODS}=useNativeCard();
</script>
<template>
   <div v-if="result.view==='closures'">
    <form v-if="admin&&!readonly" class="native-form" @submit.prevent="prepare({kind:'closure.create',roomId,startDate:date,endDate,periodKeys:PERIODS.map(p=>p.key),reason})"><label>房间<select v-model="roomId" required><option v-for="r in context?.rooms||[]" :key="r.id" :value="r.id">{{r.name}}</option></select></label><label>开始日期<input v-model="date" type="date" required @input="dirty"></label><label>结束日期<input v-model="endDate" type="date" required @input="dirty"></label><label class="wide">全天停用原因<input v-model="reason" required @input="dirty"></label><button :disabled="busy">准备停用范围</button></form><div v-for="c in context?.closures||[]" :key="c.id" class="object-row">{{c.roomName||c.roomId}} · {{c.startDate}}–{{c.endDate}} · {{c.status==='revoked'?'已撤销':'生效'}} · {{c.reason}}<button v-if="admin&&c.status!=='revoked'&&!readonly" :disabled="busy" @click="prepare({kind:'closure.revoke',closureId:c.id})">准备撤销</button></div>
   </div>
</template>
