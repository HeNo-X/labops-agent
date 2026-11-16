<script setup lang="ts">
/**
 * 会话抽屉（会话页左侧滑入，参考 LibreChat/NextChat 移动端范式）
 * ============================================================================
 *  · 内容：新会话主钮 → 搜索 → 工作/聊天分段过滤 → 会话行（SwipeRow：置顶/改名/删除）
 *  · 全部会话操作直接在抽屉行内完成
 *  · 删除走确认弹层（destructive）；改名为行内编辑（输入 + 保存/取消）
 *  · 关闭：遮罩点击 / Esc（组件自听）；选中会话即关闭并导航
 */
import {computed,ref,onMounted,onUnmounted,nextTick} from 'vue';
import {useSessionStore} from '../stores/session';
import {useBusinessStore} from '../stores/business';
import {useCollection} from '../composables/useCollection';
import {t as tr} from '../i18n';
import UiIcon from './UiIcon.vue';
import SwipeRow from './SwipeRow.vue';
import {useFeedback} from '../mobile/feedback';

const emit = defineEmits<{ close: []; select: [id: string]; new: []; automation: [] }>();
const session = useSessionStore();
const business = useBusinessStore();
const feedback = useFeedback();
const query = ref('');
const section = ref<'work' | 'chat'>('work');
const pins = useCollection('conversations', () => business.profile ? business.profile.identity + ':' + business.profile.username : '');
const editingId = ref<string | null>(null);
const menuId = ref<string | null>(null);
const editTitle = ref('');
const error = ref('');

const list = computed(() =>
  (section.value === 'chat' ? session.chatConversations : session.workConversations)
    .filter((c) => [c.title, c.preview || ''].join(' ').toLowerCase().includes(query.value.toLowerCase()))
    .slice()
    .sort((a, b) => Number(pins.ids.value.includes(b.id)) - Number(pins.ids.value.includes(a.id)))
);

function pick(id: string): void {
  menuId.value = null;
  if (editingId.value) return; // 编辑态下点行不导航
  emit('select', id);
  emit('close');
}

function startRename(c: { id: string; title: string }): void {
  menuId.value = null;
  editingId.value = c.id;
  editTitle.value = c.title;
  void nextTick(() => document.getElementById('m-drawer-rename')?.focus());
}
async function saveRename(): Promise<void> {
  if (!editingId.value || !editTitle.value.trim()) { editingId.value = null; return; }
  try {
    await session.renameConversation(editingId.value, editTitle.value.trim());
    editingId.value = null;
    feedback.toast(tr('已保存名称'));
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function remove(c: { id: string; title: string }): Promise<void> {
  const ok = await feedback.confirmSheet({
    title: tr('删除此会话？'),
    message: tr('删除其聊天显示，不撤销已提交的业务。'),
    confirmLabel: tr('删除'),
    cancelLabel: tr('取消'),
    destructive: true
  });
  if (!ok) return;
  try {
    await session.removeConversation(c.id);
    feedback.toast(tr('已删除会话'));
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <aside class="m-drawer" role="dialog" aria-modal="true" :aria-label="tr('会话导航')">
    <button type="button" class="mobile-primary m-drawer__new" @click="emit('new'); emit('close')">
      <UiIcon name="new" :size="16"/>{{ tr('新会话') }}
    </button>
    <!-- 自动化入口：会话抽屉直达定时任务（与 PC 侧栏同能力） -->
    <button type="button" class="m-drawer__automation" @click="emit('automation'); emit('close')">
      <UiIcon name="clock" :size="16"/>{{ tr('自动化') }}
    </button>
    <label class="m-drawer__search">
      <UiIcon name="search" :size="14"/>
      <input v-model="query" type="search" :placeholder="tr('搜索会话')" :aria-label="tr('搜索会话')">
    </label>
    <div class="mobile-segments m-drawer__seg" role="tablist" :aria-label="tr('会话分区')">
      <button role="tab" :aria-selected="section === 'work'" @click="section = 'work'">{{ tr('工作') }} {{ session.workConversations.length }}</button>
      <button role="tab" :aria-selected="section === 'chat'" @click="section = 'chat'">{{ tr('聊天') }} {{ session.chatConversations.length }}</button>
    </div>
    <p v-if="error" role="alert" class="m-drawer__error">{{ error }}</p>
    <div class="m-drawer__list" role="list">
<template v-for="c in list" :key="c.id">
        <!-- 改名：整行替换为编辑表单（避免 button 嵌 button 的非法 DOM 吞点击） -->
        <div v-if="editingId === c.id" class="m-drawer__edit">
          <input
            id="m-drawer-rename"
            v-model="editTitle"
            maxlength="120"
            :aria-label="tr('会话名称')"
            @keydown.enter.prevent="saveRename"
            @keydown.escape.prevent="editingId = null"
          >
          <span class="m-drawer__editrow">
            <button type="button" class="mobile-primary" @click="saveRename">{{ tr('保存') }}</button>
            <button type="button" @click="editingId = null">{{ tr('取消') }}</button>
          </span>
        </div>
        <div v-else class="m-drawer__item">
          <div class="m-drawer__itemrow">
            <SwipeRow
              class="m-drawer__itemswipe"
              :actions="[
                { label: tr(pins.ids.value.includes(c.id) ? '取消置顶' : '置顶'), run: () => pins.toggle(c.id) },
                { label: tr('改名'), run: () => startRename(c) },
                { label: tr('删除'), danger: true, run: () => remove(c) }
              ]"
            >
              <button type="button" role="listitem" class="m-drawer__row" @click="pick(c.id)">
                <b><UiIcon v-if="pins.ids.value.includes(c.id)" name="star" :size="12"/>{{ c.title || tr('新会话') }}</b>
                <span>{{ c.preview || tr('尚未开始对话') }}</span>
                <small>{{ c.source === 'automation' ? tr('定时自动化') + ' · ' : '' }}{{ session.timeLabel(c.lastActivityAt) }} · {{ c.messageCount }} {{ tr('条消息') }}</small>
              </button>
            </SwipeRow>
            <button
              type="button"
              class="m-drawer__more"
              :aria-label="tr('管理会话') + ': ' + (c.title || tr('新会话'))"
              :aria-expanded="menuId === c.id"
              @click="menuId = menuId === c.id ? null : c.id"
            >
              <UiIcon name="more" :size="16"/>
            </button>
          </div>
          <!-- 可见操作菜单：不必依赖滑动即可 删改/置顶 -->
          <div v-if="menuId === c.id" class="m-drawer__menu" role="menu">
            <button type="button" role="menuitem" @click="pins.toggle(c.id); menuId = null">
              <UiIcon name="star" :size="14"/>{{ tr(pins.ids.value.includes(c.id) ? '取消置顶' : '置顶会话') }}
            </button>
            <button type="button" role="menuitem" @click="startRename(c); menuId = null">
              <UiIcon name="new" :size="14"/>{{ tr('改名') }}
            </button>
            <button type="button" role="menuitem" class="m-drawer__menu-danger" @click="remove(c); menuId = null">
              <UiIcon name="close" :size="14"/>{{ tr('删除') }}
            </button>
          </div>
        </div>
      </template>
      <p v-if="!list.length" class="m-drawer__empty">{{ tr(query ? '无匹配会话' : '此分区暂无会话') }}</p>
    </div>
  </aside>
</template>

<style scoped>
.m-drawer{position:fixed;inset:0 auto 0 0;width:min(300px,84vw);z-index:120;display:flex;flex-direction:column;gap:10px;background:var(--m-card,var(--surface));box-shadow:var(--m-shadow-float,0 8px 24px rgba(0,0,0,.18));padding:12px 10px calc(12px + env(safe-area-inset-bottom));animation:m-drawer-in var(--m-page-t,240ms) var(--m-ease,ease-out)}
@keyframes m-drawer-in{from{transform:translateX(-100%)}}
.m-drawer__new{display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px}
.m-drawer__search{display:flex;align-items:center;gap:6px;padding:0 8px;border-radius:var(--m-radius,10px);background:var(--m-page,var(--surface-2))}
.m-drawer__search input{flex:1;min-height:40px;border:0;background:transparent;box-shadow:none!important}
.m-drawer__seg{margin:0}
.m-drawer__list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}
.m-drawer__row{display:flex;flex-direction:column;gap:2px;text-align:left;padding:10px 8px;border:0;border-bottom:1px solid var(--m-hairline,var(--border));background:transparent;border-radius:0;min-height:0}
.m-drawer__row b{font-size:calc(var(--ui-font-size)*1.07692);display:flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m-drawer__row span{color:var(--text-muted);font-size:calc(var(--ui-font-size)*0.92308);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m-drawer__row small{color:var(--text-faint);font-size:calc(var(--ui-font-size)*0.84615)}
.m-drawer__edit{display:grid;gap:6px;padding:10px 8px;border-bottom:1px solid var(--m-hairline,var(--border))}
.m-drawer__edit input{min-height:40px}
.m-drawer__editrow{display:flex;gap:6px}
.m-drawer__editrow .mobile-primary{min-height:38px;padding:4px 14px}
.m-drawer__editrow button:not(.mobile-primary){min-height:38px;padding:4px 12px}
.m-drawer__empty{color:var(--text-faint);padding:12px 8px;margin:0}
.m-drawer__error{color:var(--danger);font-size:calc(var(--ui-font-size)*0.92308);margin:0;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.m-drawer{animation:none!important}}
</style>
