<script setup lang="ts">
/**
 * 设备内置摄像头（PC 与移动端共用）
 * ============================================================================
 *  抽成共享组件的原因：实验室监控有两套壳（PC 的 VisionPanel / 移动端 MobileVision），
 *  合并为一份相机预览实现，避免同一能力两份代码。
 *
 *  行为：
 *    · 点「开启内置摄像头」才采集，默认不开启
 *    · 设备有多个摄像头时出现「切换为前置/后置」；只有一个时不显示（不做按不动的按钮）
 *    · 关闭时立刻停止所有轨道，并把 srcObject 置空
 *    · 画面**只在本机渲染**：不上传、不落盘、不写证据
 *    · 失败按原因给可执行提示（HTTPS 限制 / 权限被拒 / 无设备 / 被占用）
 */
import { computed, ref } from 'vue';
import { t as tr } from '../i18n';
import UiIcon from './UiIcon.vue';
import { useCamera } from '../composables/useCamera';

const props = defineProps<{ compact?: boolean }>();

const camera = useCamera();
const videoEl = ref<HTMLVideoElement | null>(null);

/**
 * 镜像显示：**默认开启**。
 * 理由：前置摄像头看人是"照镜子"的直觉，不镜像会让人左右手反向、看着别扭。
 * 但镜像只对前置有意义 —— 后置对着的是真实场景，镜像会让画面与实物左右相反，
 * 属于误导。所以开关保留（切回前置时继续生效），后置时禁用并说明原因。
 */
const mirror = ref(true);
const isFront = computed(() => (camera.actualFacing.value ?? camera.facing.value) === 'user');
const mirrorActive = computed(() => mirror.value && isFront.value);

const nextFacingLabel = computed(() => (camera.facing.value === 'user' ? '后置' : '前置'));
const facingLabel = computed(() => {
  const actual = camera.actualFacing.value ?? camera.facing.value;
  return actual === 'environment' ? '后置' : '前置';
});
const resolutionText = computed(() =>
  camera.resolution.value ? `${camera.resolution.value.width} × ${camera.resolution.value.height}` : ''
);

async function openCamera(): Promise<void> {
  await camera.start(videoEl.value);
}
</script>

<template>
  <section class="builtin" :class="{ 'is-compact': compact }">
    <header class="builtin__head">
      <h2>{{ tr('设备内置摄像头') }}</h2>
      <span class="builtin__tag"><span aria-hidden="true">●</span>{{ tr('本机 · 不上传') }}</span>
    </header>

    <p v-if="!camera.active.value && !camera.failure.value" class="builtin__lead">
      {{ tr('用这台设备的摄像头看现场。画面只在当前页面显示，不会上传到服务器。') }}
    </p>

    <p v-if="camera.failure.value" class="builtin__error" role="alert">{{ tr(camera.failure.value.message) }}</p>

    <div class="builtin__stage" :class="{ 'is-live': camera.active.value }">
      <video
        ref="videoEl"
        :class="{ 'is-mirrored': mirrorActive }"
        autoplay
        playsinline
        muted
        :aria-label="tr('内置摄像头实时画面')"
      />
      <p v-if="!camera.active.value" class="builtin__idle">
        <UiIcon name="camera" />
        <span>{{ tr('摄像头未开启') }}</span>
      </p>
    </div>

    <div v-if="camera.active.value" class="builtin__mirror">
      <label>
        <input v-model="mirror" type="checkbox" :disabled="!isFront" />
        <span>{{ tr('镜像显示') }}</span>
      </label>
      <span v-if="!isFront" class="builtin__mirror-hint">{{ tr('后置摄像头对着真实场景，不镜像') }}</span>
      <span v-else class="builtin__mirror-hint">{{ tr('前置预览左右翻转，符合照镜子的直觉') }}</span>
    </div>

    <dl v-if="camera.active.value" class="builtin__meta">
      <div><dt>{{ tr('朝向') }}</dt><dd>{{ tr(facingLabel) }}</dd></div>
      <div v-if="resolutionText"><dt>{{ tr('分辨率') }}</dt><dd>{{ resolutionText }}</dd></div>
      <div v-if="camera.deviceLabel.value"><dt>{{ tr('设备') }}</dt><dd>{{ camera.deviceLabel.value }}</dd></div>
    </dl>

    <div class="builtin__actions">
      <button
        v-if="!camera.active.value"
        type="button"
        class="builtin__primary"
        :disabled="camera.starting.value"
        @click="openCamera"
      >
        {{ tr(camera.starting.value ? '正在开启…' : '开启内置摄像头') }}
      </button>
      <template v-else>
        <button
          v-if="camera.cameraCount.value > 1"
          type="button"
          :disabled="camera.starting.value"
          @click="camera.flip"
        >
          {{ tr(`切换为${nextFacingLabel}`) }}
        </button>
        <button type="button" @click="camera.stop">{{ tr('关闭摄像头') }}</button>
      </template>
    </div>

    <p class="builtin__hint">
      {{ tr('画面不落盘、不写入证据、不上传；关闭本页或点「关闭摄像头」即停止采集。') }}
    </p>
  </section>
</template>

<style scoped>
.builtin {
  display: grid;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  background: var(--surface-2);
}
.builtin.is-compact {
  padding: 12px;
  gap: 8px;
}
.builtin__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.builtin__head h2 {
  margin: 0;
  font-size: 14px;
}
.builtin.is-compact .builtin__head h2 {
  font-size: 15px;
}
.builtin__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--primary);
  color: var(--primary);
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}
.builtin__lead {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}
.builtin__error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #b91c1c);
  line-height: 1.6;
}
.builtin__stage {
  position: relative;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  background: #0b0f14;
  aspect-ratio: 4 / 3;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.builtin__stage.is-live {
  border-style: solid;
  border-color: var(--border);
}
.builtin__stage video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  display: none;
}
.builtin__stage.is-live video {
  display: block;
}
/* 镜像只翻转画面本身，不影响页面上的文字与按钮 */
.builtin__stage video.is-mirrored {
  transform: scaleX(-1);
}
.builtin__mirror {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-muted);
}
.builtin__mirror label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  cursor: pointer;
}
.builtin__mirror input {
  width: 18px;
  height: 18px;
  cursor: pointer;
}
.builtin__mirror input:disabled {
  cursor: not-allowed;
}
.builtin__mirror-hint {
  font-size: 11px;
  color: var(--text-faint);
}
.builtin__idle {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8a97a6;
  font-size: 13px;
}
.builtin__meta {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: 12px;
}
.builtin__meta > div {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.builtin__meta dt {
  color: var(--text-faint);
}
.builtin__meta dd {
  margin: 0;
  color: var(--text-muted);
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.builtin__actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.builtin__actions button {
  min-height: 40px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.builtin__actions button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.builtin__primary {
  background: var(--primary) !important;
  border-color: var(--primary) !important;
  /* 深色模式 --primary 翻转为近白：文字必须用对比色令牌（硬编码 #fff 会白底白字，
     违反 tokens.css『按钮文字一律用 --primary-contrast』规约） */
  color: var(--primary-contrast) !important;
  font-weight: 600;
}
.builtin__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.6;
}
@media (max-width: 640px) {
  .builtin__actions button {
    flex: 1 1 auto;
    min-height: 44px;
  }
  .builtin__stage {
    aspect-ratio: 3 / 4;
  }
}

/* 操作按钮的悬浮与聚焦反馈 */
.builtin__actions button:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: var(--primary-border);
  color: var(--primary);
}
.builtin__actions button.builtin__primary:hover:not(:disabled) {
  background: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
}
.builtin__actions button:active:not(:disabled) {
  background: var(--surface-2);
}
.builtin__actions button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

</style>
