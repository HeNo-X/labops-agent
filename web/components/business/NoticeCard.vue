<script setup lang="ts">
import {businessApi} from '../../stores/business';
import {useNativeCard} from '../../business/controller';
const {result,readonly,context,title,content,audience,busy,admin,payload,perform,refresh,dirty,prepare}=useNativeCard();
</script>
<template>
   <div v-if="result.view==='notifications'">
    <form v-if="admin&&!readonly" class="native-form" @submit.prevent="prepare({kind:'notification.publish',title,content,audience:audience.startsWith('user:')?{kind:'user',userId:audience.slice(5)}:audience==='all'?{kind:'all'}:audience.startsWith('class:')?{kind:'class',className:audience.slice(6)}:{kind:'role',role:audience}})"><label class="wide">标题<input aria-label="标题" v-model="title" required @input="dirty"></label><label class="wide">正文<textarea aria-label="正文" v-model="content" rows="2" required @input="dirty"></textarea></label><label>接收范围<select aria-label="接收范围" v-model="audience" @change="dirty"><option value="volunteer">志愿者</option><option value="student">学生</option><option value="all">所有用户</option><option v-for="u in context?.notificationRecipients||[]" :key="u.username" :value="'user:'+u.username">本人账号 {{u.username}} · {{u.identity}}</option><option v-for="c in context?.classes||[]" :key="c.name" :value="'class:'+c.name">{{c.name}}</option></select></label><button :disabled="busy">准备站内通知</button></form>
    <article v-for="n in context?.notifications||[]" :key="n.id" class="object-row"><b>{{n.title}}</b><p>{{n.content}}</p><p>{{n.id}} · {{n.time}} · 已存入站内信箱<span v-if="admin"> · 已读 {{Object.keys(n.reads||{}).length}} 人</span><span v-if="n.readAt"> · 本人已读 {{n.readAt}}</span></p><button v-if="!n.readAt&&!readonly" :disabled="busy" @click="perform(async()=>{await businessApi('proxy/notifications/read',payload({id:n.id}));await refresh()})">标记本人已读</button></article>
   </div>
</template>
