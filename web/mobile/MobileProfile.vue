<script setup lang="ts">
/**
 * 移动端「我的」
 * ============================================================================
 *  只保留个人事务：身份、偏好、帮助、退出。
 *  消息中心由全局 Header 铃铛承担；自动化由工作台快捷入口承担；
 *  证据与资料在任务/房间详情内；实验室监控在实验室工具栏。
 *  「提醒偏好」仍统一跳转到自动化面板里的同一份设置，不再重复实现表单。
 */
import {computed} from 'vue';
import {useBusinessStore} from '../stores/business';
import {t as tr} from '../i18n';
import UiIcon from '../components/UiIcon.vue';
import type {Target} from '@shared/labops-targets.js';

const business=useBusinessStore();
const emit=defineEmits<{logout:[];navigate:[Target]}>();
const identity=computed(()=>business.profile?.identity==='admin'?'管理员':'志愿者');
const initial=computed(()=>(business.profile?.username||'L').trim().slice(0,1).toUpperCase());
const PREFERENCES=[
 {view:'automation',label:'提醒偏好',description:'站内提醒与分类',icon:'bell'},
 {view:'settings',label:'界面与连接',description:'主题、字号与安装设置',icon:'settings'}
] as const;
function go(view:Target['view']){emit('navigate',{view} as Target);}
</script>

<template>
<section class="m-profile-card">
  <span class="m-profile-avatar" aria-hidden="true">{{initial}}</span>
  <div class="m-profile-body"><h2>{{business.profile?.username}}</h2><p>{{business.profile?.className||tr('主系统账号')}}</p></div>
  <span class="m-profile-role">{{tr(identity)}}</span>
</section>

<nav class="m-profile-group" :aria-label="tr('偏好')">
  <h3>{{tr('偏好')}}</h3>
  <button v-for="item in PREFERENCES" :key="item.view" @click="go(item.view)"><UiIcon :name="item.icon"/><span>{{tr(item.label)}}<small>{{tr(item.description)}}</small></span><UiIcon name="chevron" :size="14"/></button>
</nav>

<section class="m-profile-group" :aria-label="tr('帮助')">
  <h3>{{tr('帮助')}}</h3>
  <details class="m-profile-help"><summary>{{tr('使用说明')}}<UiIcon name="chevron" :size="14"/></summary>
    <p>{{tr('使用浏览器菜单“添加到主屏幕”可保留独立移动端入口。站内提醒以服务端记录为准，当前没有系统推送能力。')}}</p>
    <p>{{tr('离线时保留当前输入；恢复后刷新会话或同一方案编号。保存失败时先保留回答，不会自动重发或重复办理。')}}</p>
    <p>{{tr('聊天会话只查询；正式办理请新建工作会话或进入实验室工作台。删除对话不撤销已提交业务。')}}</p>
  </details>
  <p class="m-profile-version">LabOps 1.0.5.2 · Asia/Shanghai</p>
</section>

<button class="mobile-danger m-profile-logout" @click="emit('logout')">{{tr('退出登录')}}</button>
</template>
