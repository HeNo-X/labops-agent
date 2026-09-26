<script setup lang="ts">
/**
 * 确认位（预留，第一阶段**不执行任何写操作**）
 * ============================================================================
 *  第一阶段提示词第 5 条：「可扩展的确认单位置：在设计稿中标明未来发布通知、
 *  创建工单时的人工确认交互；**第一阶段不执行任何写操作**。」
 *
 *  所以这里是一个**明确的、不可操作的**骨架：
 *   · 按钮全部 disabled，并用 aria-disabled 说明原因
 *   · 明确写出未来会用到它的两个工具（publish_notification / create_inspection_ticket）
 *   · 明确写出当前服务端根本没有注册这两个工具（注册表 = 真实能力清单）
 *  这不是"忘了实现"，而是"故意不做"。
 */
import StatusTag from './StatusTag.vue';
</script>

<template>
  <section class="dock" aria-labelledby="dock-h">
    <header class="dock__head">
      <h2 id="dock-h">人工确认位</h2>
      <StatusTag tone="neutral" glyph="⏸" shape="dashed" label="第一阶段未启用" title="当前服务端未注册任何写操作工具" />
    </header>

    <p class="dock__desc">
      将来「发布通知」「创建整改工单」这类会改变真实数据的操作，必须由人在此卡片上确认后才执行。
      当前阶段服务端只注册了 1 个只读工具，因此这里不会出现任何可点击的确认操作。
    </p>

    <div class="card" aria-disabled="true">
      <div class="card__bar">
        <span class="card__title">即将发布通知</span>
        <StatusTag tone="warn" glyph="⚠" label="危险操作" />
      </div>
      <dl class="card__body">
        <div class="row"><dt>标题</dt><dd class="ph">志愿值班补报提醒</dd></div>
        <div class="row"><dt>正文</dt><dd class="ph">（全文可编辑）……</dd></div>
        <div class="row"><dt>范围</dt><dd class="ph">全体志愿者</dd></div>
      </dl>
      <div class="card__actions">
        <button type="button" class="btn btn--primary" disabled aria-disabled="true">确认发布</button>
        <button type="button" class="btn" disabled aria-disabled="true">修改</button>
        <button type="button" class="btn" disabled aria-disabled="true">取消</button>
      </div>
      <p class="card__note">以上为占位示意（示例数据），按钮已禁用：第一阶段不执行写操作。</p>
    </div>

    <ul class="dock__future">
      <li><code>publish_notification</code> —— 发布系统通知（危险操作，需二次确认，仅管理员）</li>
      <li><code>create_inspection_ticket</code> —— 创建整改工单（危险操作，需二次确认，仅管理员）</li>
    </ul>
    <p class="dock__none">当前注册表里的可用工具：<b>query_schedule</b>（只读）。</p>
  </section>
</template>

<style scoped>
.dock {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-1);
}
.dock__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-2);
}
.dock__head h2 {
  margin: 0;
  font-size: 15px;
}
.dock__desc {
  margin: 0 0 var(--sp-3);
  font-size: 12px;
  color: var(--text-muted);
}
.card {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: var(--sp-3);
  background: var(--surface-2);
  opacity: 0.72;
}
.card__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.card__title {
  font-size: 13px;
  font-weight: 600;
}
.card__body {
  margin: 0 0 var(--sp-3);
}
.row {
  display: flex;
  gap: var(--sp-3);
  font-size: 12px;
  margin-bottom: 2px;
}
.row dt {
  flex: 0 0 48px;
  color: var(--text-faint);
}
.row dd {
  margin: 0;
}
.ph {
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.card__actions {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.btn {
  padding: 4px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface-3);
  color: var(--text-muted);
  font-size: 12px;
  cursor: not-allowed;
}
.btn--primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.card__note {
  margin: var(--sp-2) 0 0;
  font-size: 11px;
  color: var(--text-faint);
}
.dock__future {
  margin: var(--sp-3) 0 var(--sp-1);
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-muted);
}
.dock__future code,
.dock__none code {
  font-family: var(--font-mono);
  background: var(--surface-3);
  padding: 0 4px;
  border-radius: 4px;
}
.dock__none {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.dock__none b {
  font-family: var(--font-mono);
  color: var(--text-muted);
}
</style>
