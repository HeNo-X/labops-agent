<script setup lang="ts">
import {t as tr} from "../../i18n";
import {businessApi} from '../../stores/business';
import {useNativeCard} from '../../business/controller';
import {formatDateTime,humanizeIsoText} from '../../business/automation-format';
const {result,readonly,context,plan,title,content,audience,busy,admin,payload,perform,refresh,dirty,prepare}=useNativeCard();
</script>
<template>
   <div v-if="result.view==='notifications'">
    <form v-if="admin&&!readonly&&!plan" class="native-form" @submit.prevent="prepare({kind:'notification.publish',title,content,audience:audience.startsWith('user:')?{kind:'user',userId:audience.slice(5)}:audience==='all'?{kind:'all'}:audience.startsWith('class:')?{kind:'class',className:audience.slice(6)}:{kind:'role',role:audience}})"><label class="wide">{{tr("标题")}}<input :aria-label="tr('标题')" v-model="title" required @input="dirty"></label><label class="wide">{{tr("正文")}}<textarea :aria-label="tr('正文')" v-model="content" rows="2" required @input="dirty"></textarea></label><label>{{tr("接收范围")}}<select :aria-label="tr('接收范围')" v-model="audience" @change="dirty"><option value="volunteer">{{tr("志愿者")}}</option><option value="student">{{tr("学生")}}</option><option value="all">{{tr("所有用户")}}</option><option v-for="u in context?.notificationRecipients||[]" :key="u.username" :value="'user:'+u.username">{{tr("本人账号")}} {{u.username}} · {{u.identity}}</option><option v-for="c in context?.classes||[]" :key="c.name" :value="'class:'+c.name">{{c.name}}</option></select></label><button :disabled="busy">{{tr("准备站内通知")}}</button></form>
    <details v-if="(context?.notifications||[]).length" class="card__more"><summary>{{tr("历史通知")}} {{(context?.notifications||[]).length}} {{tr("条")}}</summary>
    <article v-for="n in context?.notifications||[]" :key="n.id" class="object-row"><b>{{n.title}}</b><p>{{humanizeIsoText(n.content)}}</p><p class="notice-meta">{{formatDateTime(n.time)}}{{tr(" 已存入站内信箱")}}<span v-if="admin"> · {{tr("已读")}} {{Object.keys(n.reads||{}).length}} {{tr("人")}}</span><span v-if="n.readAt"> · {{tr("本人已读")}} {{formatDateTime(n.readAt)}}</span></p><button v-if="!n.readAt&&!readonly" :disabled="busy" @click="perform(async()=>{await businessApi('proxy/notifications/read',payload({id:n.id}));await refresh()})">{{tr("标记本人已读")}}</button></article>
    </details>
   </div>
</template>

<style scoped>
/* 状态行只作弱化背景信息，不与标题正文抢视线 */
.notice-meta{color:var(--muted,#6b7280);font-size:.85em;margin:.25em 0 0}
</style>
