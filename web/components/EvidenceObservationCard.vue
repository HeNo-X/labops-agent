<script setup lang="ts">
import { t as tr } from '../i18n';
/**
 * 证据照片的 AI 视觉初判卡 —— analyze_evidence_image 的结构化产物
 * ============================================================================
 *  口径纪律：这一卡**永远**带着"非人工核验"声明出现。
 *  视觉模型说"看到裂纹"不等于设备有裂纹，更不等于已修复；
 *  "画面无法确认"必须显式渲染，不能因为它是空列表就省掉——
 *  让用户能看到模型自己承认了哪些看不见。
 */
import { computed } from 'vue';
import type { EvidenceObservationResult } from '@shared/types';
import StatusTag from './StatusTag.vue';

const props = defineProps<{ result: EvidenceObservationResult }>();

const SEVERITY_LABEL: Record<EvidenceObservationResult['observation']['severityGuess'], string> = {
  unknown: '无法初判',
  minor: '轻微',
  moderate: '中等',
  severe: '严重'
};

const severity = computed(() => SEVERITY_LABEL[props.result.observation.severityGuess]);
const confidenceText = computed(() => `${Math.round(props.result.observation.confidence * 100)}%`);
const confidenceLow = computed(() => props.result.observation.confidence < 0.5);
</script>

<template>
  <section class="evo">
    <header class="evo__head">
      <h3 class="evo__title">{{ tr('证据照片 · AI 视觉初判') }}</h3>
      <StatusTag tone="warn" glyph="◉" :label="tr('AI 初判，非人工验收')" :title="tr('本卡内容来自视觉模型对照片画面的观察，不替代现场检查，也不能证明设备已修复或通过验收')" />
      <span class="evo__model">{{ result.model }}</span>
    </header>

    <dl class="evo__grid">
      <div class="evo__row">
        <dt>{{ tr('设备类型') }}</dt>
        <dd>{{ result.observation.deviceType }}</dd>
      </div>
      <div class="evo__row">
        <dt>{{ tr('严重度初判') }}</dt>
        <dd>
          {{ severity }}
          <span :class="['evo__conf', confidenceLow && 'evo__conf--low']">{{ tr('置信度') }} {{ confidenceText }}</span>
        </dd>
      </div>
      <div class="evo__row">
        <dt>{{ tr('铭牌可见文字') }}</dt>
        <dd class="evo__mono">{{ result.observation.nameplateText }}</dd>
      </div>
      <div class="evo__row">
        <dt>{{ tr('可见征象') }}</dt>
        <dd>
          <ul v-if="result.observation.visibleSymptoms.length" class="evo__list">
            <li v-for="(s, i) in result.observation.visibleSymptoms" :key="i">{{ s }}</li>
          </ul>
          <p v-else class="evo__none">{{ tr('画面中没有可确认的异常征象') }}</p>
        </dd>
      </div>
      <div class="evo__row">
        <dt>{{ tr('画面无法确认') }}</dt>
        <dd>
          <ul v-if="result.observation.whatNotVisible.length" class="evo__list evo__list--faint">
            <li v-for="(s, i) in result.observation.whatNotVisible" :key="i">{{ s }}</li>
          </ul>
          <p v-else class="evo__none">{{ tr('模型未列出盲区，请人工复核') }}</p>
        </dd>
      </div>
    </dl>

    <div v-if="result.skipped?.length" class="evo__skipped">
      {{ tr('未分析的附件：') }}{{ result.skipped.join('；') }}
    </div>

    <footer class="evo__foot">
      <p class="evo__scope">{{ result.scope }}</p>
      <ul class="evo__files">
        <li v-for="a in result.attachments" :key="a.id">
          <span class="evo__fname">{{ a.fileName }}</span>
          <span class="evo__meta">{{ a.mimeType }} · sha256:{{ a.sha256.slice(0, 12) }} · {{ a.uploadedAt.slice(0, 16).replace('T', ' ') }}</span>
        </li>
      </ul>
      <p class="evo__src">{{ result.provenance.sourceLabel }} · {{ result.provenance.queryTime.slice(0, 19).replace('T', ' ') }} · {{ result.provenance.coverage }}</p>
    </footer>
  </section>
</template>

<style scoped>
.evo {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-1);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.evo__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.evo__title {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 1.0769);
  font-weight: 600;
}
.evo__model {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) * 0.8846);
  color: var(--text-faint);
}
.evo__grid {
  margin: 0;
  display: grid;
  gap: var(--sp-2);
}
.evo__row {
  display: grid;
  grid-template-columns: 7.5em 1fr;
  gap: var(--sp-3);
  align-items: baseline;
}
.evo__row dt {
  color: var(--text-faint);
  font-size: calc(var(--ui-font-size) * 0.9231);
}
.evo__row dd {
  margin: 0;
}
.evo__mono {
  font-family: var(--font-mono);
}
.evo__conf {
  margin-inline-start: var(--sp-2);
  padding: 0 var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: calc(var(--ui-font-size) * 0.8846);
  color: var(--text-muted);
}
.evo__conf--low {
  border-color: var(--warn-border);
  color: var(--warn);
}
.evo__list {
  margin: 0;
  padding-inline-start: 1.2em;
}
.evo__list--faint {
  color: var(--text-muted);
}
.evo__none {
  margin: 0;
  color: var(--text-faint);
}
.evo__skipped {
  border-top: 1px solid var(--border);
  padding-top: var(--sp-2);
  font-size: calc(var(--ui-font-size) * 0.9231);
  color: var(--text-muted);
}
.evo__foot {
  border-top: 1px solid var(--border);
  padding-top: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.evo__scope {
  margin: 0;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.9231);
}
.evo__files {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.evo__fname {
  font-weight: 500;
}
.evo__meta {
  margin-inline-start: var(--sp-2);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) * 0.8462);
  color: var(--text-faint);
}
.evo__src {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.8462);
  color: var(--text-faint);
}
</style>
