/**
 * 语音纠错的"可见 + 可还原 + 可叫停" —— PC 与移动共用一份
 * ============================================================================
 *  为什么单独成模块：CommandBar / MobileConversation / MobileStart 三处都要
 *  "把识别结果并进草稿 + 记住并进的是哪一段 + 允许还原"。写三遍必然分化，
 *  本仓库已经为此付过代价（同一个 bug 在两端各存在一份）。
 *
 *  还原的前提是**那段文字还在草稿里原样存在**。用户已经在上面改过字，
 *  我们就不猜 —— 此时 originalText 给空串，界面上的"还原原文"是禁用态，
 *  而不是把一个改过的句子整个覆盖回上游原文。
 */
import { computed, ref, type Ref } from 'vue';
import type { useVoiceInput } from './useVoiceInput';

type Voice = ReturnType<typeof useVoiceInput>;

export function useVoiceCorrection(voice: Voice, draft: Ref<string>) {
  /** 最近一次由语音写入草稿的那一段（已经过服务端纠错的版本） */
  const lastInsert = ref('');

  /** 识别结果并入草稿而非覆盖 —— 用户可能已经打了一半 */
  function applyText(recognized: string): void {
    draft.value = draft.value ? `${draft.value.replace(/\s+$/, '')} ${recognized}` : recognized;
    lastInsert.value = recognized;
  }

  /**
   * 只在"那段文字仍未被用户动过"时才允许还原。
   * 返回空串 = 界面禁用还原按钮，而不是悄悄把整行覆盖掉。
   */
  const originalText = computed<string>(() => {
    const raw = voice.lastOriginalText.value;
    if (!raw || !lastInsert.value) return '';
    return draft.value.includes(lastInsert.value) ? raw : '';
  });

  function restore(): void {
    const raw = originalText.value;
    if (!raw || !lastInsert.value) return;
    draft.value = draft.value.replace(lastInsert.value, raw);
    lastInsert.value = raw;
    voice.clearCorrections();
  }

  function suppress(): void {
    voice.suppressCorrections();
    lastInsert.value = '';
  }

  return { lastInsert, applyText, originalText, restore, suppress };
}
