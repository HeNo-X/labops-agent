/** UI 层的共享类型（放在独立模块里 —— `<script setup>` 内不允许 export） */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

/** 非颜色编码：形状符号 + 边框样式，保证黑白/色盲下也能区分状态 */
export const TONE_GLYPH: Record<Tone, string> = {
  ok: '✓',
  warn: '▲',
  danger: '✕',
  info: '●',
  neutral: '○'
};

export const TONE_SHAPE: Record<Tone, 'solid' | 'dashed' | 'double'> = {
  ok: 'solid',
  warn: 'dashed',
  danger: 'double',
  info: 'solid',
  neutral: 'dashed'
};
