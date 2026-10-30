<script setup lang="ts">
import {t as tr} from '../i18n';
/**
 * 命令面板（Ctrl/Cmd+K）—— 全站唯一快捷键入口
 * ============================================================================
 *  · 空搜索时按分组展示默认内容：建议 / 前往 / 设置项 / 最近会话（≤3）；
 *    某组没有内容就**不渲染空标题**，但注册表与分组顺序不因此删减。
 *  · 范围 tabs（全部 / 操作 / 会话）是**筛选而非前缀快捷**，空搜索切 tab 也出该范围默认内容。
 *  · `>` 限命令、`#` 限会话，可与 tab 叠加。
 *  · 键盘：↑↓ 移动、Enter 执行、Esc 关闭；关闭后焦点归还打开前的元素。
 *  · 无障碍：role=dialog + aria-modal；动效遵循 prefers-reduced-motion。
 *  · 快捷键冲突处置：原 AgentSidebar 的 Ctrl/Cmd+K 已上提到这里，
 *    "聚焦会话搜索"成为第一条建议命令 —— 不再有两个组件监听同一按键。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Command, CommandContext, CommandScope } from '../lib/command-registry';
import { buildCommands, commandsForState, filterCommands, groupCommands, parseQuery } from '../lib/command-registry';

const props = defineProps<{ context: CommandContext }>();
const open = ref(false);
const query = ref('');
const scope = ref<CommandScope>('all');
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
let opener: HTMLElement | null = null;

const allCommands = computed<Command[]>(() => commandsForState(buildCommands(props.context), { busy: props.context.busy }));
const filtered = computed<Command[]>(() => filterCommands(allCommands.value, query.value, scope.value));
const groups = computed(() => groupCommands(filtered.value));
/** 扁平顺序用于键盘上下移动（与视觉分组顺序一致） */
const flat = computed<Command[]>(() => groups.value.flatMap((g) => g.items));
const parsed = computed(() => parseQuery(query.value));

const SCOPES: Array<{ key: CommandScope; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'actions', label: '操作' },
  { key: 'sessions', label: '会话' }
];

function reset(): void {
  query.value = '';
  scope.value = 'all';
  activeIndex.value = 0;
}

async function show(): Promise<void> {
  if (open.value) return;
  opener = (document.activeElement as HTMLElement) ?? null;
  reset();
  open.value = true;
  await nextTick();
  inputEl.value?.focus();
}

function hide(): void {
  if (!open.value) return;
  open.value = false;
  // 焦点归还打开前的元素（命令栏 / 侧栏 / 任意触发按钮）
  const back = opener;
  opener = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
}

async function runCommand(c: Command | undefined): Promise<void> {
  if (!c) return;
  hide();
  try {
    await c.run();
  } catch {
    /* 命令内部错误不应让面板卡住；各自动作自行提示 */
  }
}

function move(delta: number): void {
  const n = flat.value.length;
  if (!n) return;
  activeIndex.value = (activeIndex.value + delta + n) % n;
  void nextTick(() => {
    document.querySelector<HTMLElement>('.palette__item.is-active')?.scrollIntoView({ block: 'nearest' });
  });
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    void runCommand(flat.value[activeIndex.value]);
  }
}

/**
 * 面板打开时在**面板内**先吞掉 Escape；关闭后不拦截，交还既有链路
 * （侧栏账户菜单、RoundActionDialog、历史浮层各自的 Escape 语义不变）。
 */
function onWindowKeydown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'k') {
    e.preventDefault();
    if (open.value) hide();
    else void show();
    return;
  }
  if (!open.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    hide();
    return;
  }
  if (e.key === 'Tab') {
    // 简易 focus trap：面板只有输入框可聚焦，Tab 不逃逸
    e.preventDefault();
    inputEl.value?.focus();
  }
}

watch(query, () => (activeIndex.value = 0));
watch(scope, () => (activeIndex.value = 0));

onMounted(() => window.addEventListener('keydown', onWindowKeydown, true));
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown, true));

defineExpose({ show, hide, isOpen: () => open.value });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="palette__mask" @click.self="hide">
      <section class="palette" role="dialog" aria-modal="true" :aria-label="tr('命令面板')">
        <label class="sr-only" for="palette-input">{{ tr('搜索命令或会话') }}</label>
        <input
          id="palette-input"
          ref="inputEl"
          v-model="query"
          type="text"
          class="palette__input"
          :placeholder="tr('搜索命令或会话（> 只看命令，# 只看会话）')"
          autocomplete="off"
          @keydown="onInputKey"
        />
        <div class="palette__tabs" role="tablist" :aria-label="tr('命令范围')">
          <button
            v-for="s in SCOPES"
            :key="s.key"
            type="button"
            role="tab"
            :aria-selected="scope === s.key"
            :class="{ 'is-on': scope === s.key }"
            @click="scope = s.key"
          >
            {{ tr(s.label) }}
          </button>
        </div>
        <div class="palette__list">
          <template v-for="g in groups" :key="g.group">
            <p class="palette__group">{{ tr(g.title) }}</p>
            <button
              v-for="c in g.items"
              :key="c.id"
              type="button"
              class="palette__item"
              :class="{ 'is-active': flat[activeIndex]?.id === c.id }"
              @click="void runCommand(c)"
              @mouseenter="activeIndex = flat.findIndex((x) => x.id === c.id)"
            >
              <span>{{ tr(c.title) }}</span>
            </button>
          </template>
          <p v-if="!flat.length" class="palette__empty">
            {{ tr(parsed.text ? '没有匹配的命令' : '此范围暂无内容') }}
          </p>
        </div>
        <footer class="palette__foot">
          <span>{{ tr('↑↓ 选择 · Enter 执行 · Esc 关闭') }}</span>
          <span class="palette__hint">{{ tr('Ctrl/Cmd+K 打开或关闭本面板') }}</span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.palette__mask {
  position: fixed;
  inset: 0;
  z-index: 130;
  background: rgb(16 24 40 / 18%);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 16px 16px;
}
.palette {
  width: min(560px, 100%);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}
.palette__input {
  border: 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: calc(var(--ui-font-size) * 1.07692);
  padding: var(--sp-3) var(--sp-4);
  outline: none;
}
.palette__tabs {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.palette__tabs button {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.88462);
  border-radius: 999px;
  padding: 2px 12px;
  cursor: pointer;
}
.palette__tabs button.is-on {
  border-color: var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
}
.palette__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-2) var(--sp-2) var(--sp-3);
}
.palette__group {
  margin: var(--sp-2) var(--sp-2) 2px;
  font-size: calc(var(--ui-font-size) * 0.76923);
  color: var(--text-faint);
}
.palette__item {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: calc(var(--ui-font-size) * 0.96154);
  border-radius: var(--radius-sm);
  padding: 7px var(--sp-2);
  cursor: pointer;
}
.palette__item.is-active {
  background: var(--surface-2);
  box-shadow: inset 2px 0 0 var(--primary);
}
.palette__empty {
  margin: var(--sp-3);
  font-size: calc(var(--ui-font-size) * 0.88462);
  color: var(--text-faint);
}
.palette__foot {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
  border-top: 1px solid var(--border);
  padding: var(--sp-2) var(--sp-4);
  font-size: calc(var(--ui-font-size) * 0.76923);
  color: var(--text-faint);
}
@media (prefers-reduced-motion: reduce) {
  .palette,
  .palette__mask {
    animation: none !important;
    transition: none !important;
  }
}
</style>
