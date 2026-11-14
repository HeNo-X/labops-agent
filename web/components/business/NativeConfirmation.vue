<script setup lang="ts">
import {t as tr} from "../../i18n";
import {useNativeCard} from '../../business/controller';
import {useFeedback} from '../../mobile/feedback';
import {formatDateTime} from '../../business/automation-format';
const {readonly,plan,receipt,busy,edited,commitAllowed,labels,planLabels,planStates,checkText,period,perform,refresh,commit,reject}=useNativeCard();
const feedback=useFeedback();
/** 接收范围给人看的叫法，不吐 role 代号（用户视角铁律） */
function audienceText(raw:unknown):string{
 const a=(raw||{}) as Record<string,unknown>;
 if(typeof a['className']==='string'&&a['className'])return a['className'];
 if(a['role']==='volunteer')return tr('志愿者');
 if(a['role']==='student')return tr('学生');
 if(a['kind']==='user')return tr('本人账号')+' '+String(a['userId']||'');
 return tr('全体用户');
}
/** U02：移动端确认走底部弹层（拇指区主按钮 + 摘要预览）；桌面维持原内联直提 */
async function confirmAndCommit(){
 if(!commitAllowed.value)return;
 const current=plan.value;
 if(!current||typeof document!=='object'||!document.querySelector('.mobile-shell'))return commit();
 const p=current.payload as Record<string,unknown>;
 const candidate=p['candidate'] as {roomName?:string;periodKey?:string}|undefined;
 const lines=[
  candidate?tr('目标：')+candidate.roomName+' · '+period(candidate.periodKey??'')+' · '+String(p['date']??''):'',
  p['accountMasked']?tr('班级：')+String(p['beforeClassName']||tr('（未登记）'))+' → '+String(p['afterClassName']||''):'',
  String(p['reason']||p['description']||p['note']||p['title']||'').slice(0,90),
  p['nextStatus']?tr('将工单改为')+(labels[p['nextStatus'] as string]||String(p['nextStatus'])):''
 ].filter(Boolean);
 const ok=await feedback.confirmSheet({title:tr('确认提交（写入原系统）？'),message:lines.join('\n'),confirmLabel:tr('确认执行'),cancelLabel:tr('再想想')});
 if(ok)commit();
}
</script>
<template>
   <div v-if="plan" class="native-confirm"><b>{{tr(planLabels[plan.kind]||'业务办理')}}</b><p>{{tr("业务状态：")}}{{planStates[plan.state]||plan.state}} {{tr("· 有效期")}} {{formatDateTime(plan.expiresAt)}}</p><p v-if="plan.payload.candidate">{{tr("目标：")}}{{plan.payload.candidate.roomName}} · {{period(plan.payload.candidate.periodKey)}} · {{plan.payload.date}}</p><p>{{plan.payload.reason||plan.payload.description||plan.payload.note||plan.payload.title}}</p><p v-if="plan.payload.nextStatus">{{tr("将工单改为")}} {{labels[plan.payload.nextStatus]||plan.payload.nextStatus}}</p><p v-if="plan.payload.checklist">{{checkText(plan.payload.checklist)}} · {{tr(plan.payload.finalize?'最终交接待接收':'检查登记可继续补全')}}</p><p v-if="plan.payload.audience">{{tr("通知对象：")}}{{audienceText(plan.payload.audience)}}</p><p v-if="plan.payload.keyId">{{tr("钥匙：")}}{{plan.payload.keyName||plan.payload.keyId}}{{plan.payload.action==='lend'?tr("｜借用人：")+(plan.payload.holderName||plan.payload.holder):tr("｜归还入柜（现借用人：")+(plan.payload.expectedHolder||'')+tr("）")}}</p><p v-if="plan.payload.accountMasked">{{tr("学生：")}}{{plan.payload.targetName}} · {{plan.payload.accountMasked}}{{tr("｜班级：")}}{{plan.payload.beforeClassName||tr('（未登记）')}} → {{plan.payload.afterClassName}}</p><p v-if="edited&&!receipt">{{tr("条件已修改，请重新准备后确认。")}}</p><div class="button-row" v-if="!readonly"><button data-native-confirm class="btn-primary-write" :disabled="!commitAllowed" @click="confirmAndCommit">{{tr("确认提交（写入原系统）")}}</button><button class="btn-reject" :disabled="!commitAllowed" @click="reject">{{tr("拒绝方案")}}</button><button class="quiet" :disabled="busy" @click="perform(refresh)">{{tr("回查 / 恢复状态")}}</button></div></div>
   <div v-if="receipt" class="native-receipt"><b>{{tr("✓ 原系统回执")}} {{receipt.operationId}}</b><p>{{formatDateTime(receipt.committedAt)}}</p><p v-if="receipt.changes&&receipt.changes.length">{{tr("已变更：")}}{{receipt.changes.map(c=>c.name+' '+c.before+' → '+c.after).join('；')}}</p><p>{{tr("同方案重试回查相同编号。请查询最新安排或对象状态确认实际结果。")}}</p><button :disabled="busy" @click="perform(refresh)">{{tr("回查同编号与最新对象")}}</button></div>

<style scoped>
/* PC-4 确认分级：写操作主按钮（teal 实心，与卡片左侧色条同族），
   拒绝=红描边次按钮（可撤销方向），回查=quiet。 */
.btn-primary-write{background:var(--primary);border:1px solid var(--primary);font-weight:600}
.btn-reject{background:transparent;border:1px solid var(--danger,#b91c1c);color:var(--danger,#b91c1c)}
.btn-reject:hover:not(:disabled){background:rgba(185,28,28,.08)}
</style>
</template>
