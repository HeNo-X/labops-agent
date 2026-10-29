<script setup lang="ts">
/**
 * 移动端「更多」
 * ============================================================================
 *  ⚠️ 本轮重构删除了一处**重复实现**：
 *  这里原本自己写了一份「本人站内提醒偏好」表单（7 个字段 + 保存逻辑），
 *  与自动化面板里的那份是两套代码 —— 字段一样但缺 categories（模板分类多选），
 *  已经出现"PC 能选分类、手机不能"的功能不一致。
 *  现在统一收敛到自动化面板（AutomationPanel 的「本人提醒偏好」折叠区），
 *  这里只保留入口，不再各写一遍。
 */
import { useBusinessStore } from '../stores/business';
import { t as tr } from '../i18n';
import UiIcon from '../components/UiIcon.vue';
import type { Target } from '@shared/labops-targets.js';

const business = useBusinessStore();
const emit = defineEmits<{ logout: []; navigate: [Target] }>();

const LINKS = [
  { view: 'settings', label: '设置', icon: 'settings' },
  { view: 'automation', label: '自动化', icon: 'clock' },
  { view: 'messages', label: '消息中心', icon: 'chat' },
  { view: 'evidence', label: '资料与证据', icon: 'evidence' },
  { view: 'vision', label: '实验室监控', icon: 'camera' }
] as const;
</script>

<template>
  <section class="mobile-section">
    <h2>{{ business.profile?.username }}</h2>
    <p>
      {{ tr('身份：') }}{{ tr(business.profile?.identity === 'admin' ? '管理员' : '志愿者') }}{{
        business.profile?.className ? ' · ' + business.profile.className : ''
      }}
    </p>
  </section>

  <nav class="mobile-more-links" :aria-label="tr('更多')">
    <button v-for="item in LINKS" :key="item.view" @click="emit('navigate', { view: item.view } as Target)">
      <UiIcon :name="item.icon" />
      <span>{{ tr(item.label) }}</span>
      <UiIcon name="chevron" :size="14" />
    </button>
  </nav>

  <p class="mobile-note">{{ tr('提醒偏好已收进「自动化」里统一维护，PC 与手机看到的是同一份设置。') }}</p>

  <details class="mobile-section">
    <summary>{{ tr('帮助与安装') }}</summary>
    <p>
      {{ tr('使用浏览器菜单“添加到主屏幕”可保留独立移动端入口。站内提醒以服务端记录为准，当前没有系统推送能力。') }}
    </p>
    <p>
      {{ tr('离线时保留当前输入；恢复后刷新会话或同一方案编号。保存失败时先保留回答，不会自动重发或重复办理。') }}
    </p>
    <p>{{ tr('聊天会话只查询；正式办理请新建工作会话或进入实验室工作台。删除对话不撤销已提交业务。') }}</p>
    <p>LabOps 1.0.4.5 · Asia/Shanghai</p>
  </details>

  <button class="mobile-danger" @click="emit('logout')">{{ tr('退出登录') }}</button>
</template>
