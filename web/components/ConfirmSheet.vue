<script setup lang="ts">
/**
 * 确认弹层宿主 —— Promise 化替代 window.confirm（H1 品牌化重写）
 * ============================================================================
 *  ⚠️ 本组件 Teleport 到 body，**脱离 .mobile-shell 作用域**：
 *     shell 内的按钮/字体样式全部够不到 —— 样式必须在这里自持（ scoped 对
 *     Teleport 节点同样生效）。此前"素面白块红按钮"正是漏了这一点。
 *  视觉对齐批次 A 分层表面：20px 顶部圆角 + grabber + 分层阴影 + sans 字体；
 *  破坏性操作带警示图标与红色实心主按钮；拖拽关闭 = 取消（批次 C）。
 */
import { t as tr } from '../i18n';
import { useFeedback } from '../mobile/feedback';
import { useDragClose } from '../mobile/gestures';

const { state, answerConfirm } = useFeedback();
const drag = useDragClose(() => answerConfirm(false));
</script>

<template>
  <Teleport to="body">
    <div v-if="state.confirm.open" class="mobile-sheet-mask" @click.self="answerConfirm(false)">
      <section class="mobile-sheet" role="dialog" aria-modal="true" :aria-label="state.confirm.title" v-on="drag.handlers" :style="drag.style.value">
        <div class="m-confirm" :class="{ 'm-confirm--danger': state.confirm.destructive }">
          <h2 class="m-confirm__title">
            <span v-if="state.confirm.destructive" class="m-confirm__glyph" aria-hidden="true">⚠</span>
            {{ state.confirm.title }}
          </h2>
          <p v-if="state.confirm.message" class="m-confirm__msg">{{ state.confirm.message }}</p>
          <div class="m-confirm__actions">
            <button
              type="button"
              class="m-confirm__btn m-confirm__btn--primary"
              :class="{ 'is-danger': state.confirm.destructive }"
              @click="answerConfirm(true)"
            >
              {{ tr(state.confirm.confirmLabel || '确认') }}
            </button>
            <button type="button" class="m-confirm__btn m-confirm__btn--cancel" @click="answerConfirm(false)">
              {{ tr(state.confirm.cancelLabel || '取消') }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* Teleport 节点不在 .mobile-shell 内：令牌回退 + 全套自持样式 */
.m-confirm{
  --m-radius-card:14px;--m-radius:10px;--m-radius-pill:999px;
  --m-tonal:var(--surface-3,#ededed);--m-card:var(--surface,#fff);--m-page:var(--surface-2,#f5f5f5);
  --m-shadow-float:0 2px 6px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.1);
  --m-ease:cubic-bezier(.2,.8,.2,1);
  display:grid;gap:10px;padding:4px 2px 2px;
  font-family:var(--font-sans,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);
  color:var(--text,#171717);
}
.m-confirm__title{
  display:flex;align-items:center;gap:8px;margin:0;
  font-size:16px;line-height:1.45;font-weight:700;word-break:break-word;
}
.m-confirm__glyph{
  display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;border-radius:10px;
  background:var(--danger-bg,#fbf1f1);color:var(--danger,#b91c1c);font-size:15px;
}
.m-confirm__msg{margin:0;font-size:13px;line-height:1.65;color:var(--text-muted,#525252);white-space:pre-line;word-break:break-word}
.m-confirm__actions{display:grid;gap:8px;margin-top:4px}
.m-confirm__btn{
  min-height:48px;border:0;border-radius:var(--m-radius,10px);
  font:inherit;font-size:14px;font-weight:600;cursor:pointer;
  transition:transform 90ms var(--m-ease),background-color 180ms,opacity 180ms;
}
.m-confirm__btn:active{transform:scale(.98)}
.m-confirm__btn--primary{background:var(--primary,#171717);color:var(--primary-contrast,#fff)}
.m-confirm__btn--primary.is-danger{background:var(--danger,#b91c1c);color:var(--danger-contrast)}
.m-confirm__btn--cancel{background:var(--m-tonal,#ededed);color:var(--text,#171717);font-weight:500}
@media(prefers-reduced-motion:reduce){.m-confirm__btn{transition:none!important}}
</style>
