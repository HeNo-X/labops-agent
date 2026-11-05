/**
 * ASR（语音输入）单元测试 —— 全部纯逻辑，不发任何网络请求
 * ============================================================================
 *  覆盖：未配置 Key 的诚实降级、音频载荷校验、MIME 归一化、协议默认值。
 *  上游真实调用不在单元测试范围（需要外部服务）。
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  extForMime,
  getAsrConfig,
  isAllowedMime,
  isAsrConfigured,
  normalizeMime,
  transcribeAudio,
  validateAudioPayload
} from '../server/llm/asr.ts';

const ENV_KEYS = ['ASR_API_KEY', 'ASR_BASE_URL', 'ASR_MODEL', 'ASR_PROTOCOL', 'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>): void | Promise<void> {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return run();
}

describe('ASR 配置门控（诚实降级）', () => {
  it('未配置任何 Key（ASR 与 DASHSCOPE 均空）时 isAsrConfigured=false 且 transcribeAudio 返回 asr_not_configured', async () => {
    await withEnv({}, async () => {
      assert.equal(isAsrConfigured(), false);
      const result = await transcribeAudio({
        base64: Buffer.alloc(2048, 7).toString('base64'),
        mime: 'audio/webm'
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'asr_not_configured');
        assert.match(result.message, /ASR_API_KEY/);
      }
    });
  });

  it('配置 Key 后 isAsrConfigured=true；默认回落百炼 DashScope 端点与 qwen3-asr-flash', () => {
    withEnv({ DASHSCOPE_API_KEY: 'dashscope-key' }, () => {
      assert.equal(isAsrConfigured(), true);
      const config = getAsrConfig();
      assert.equal(config.apiKey, 'dashscope-key');
      assert.equal(config.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
      assert.equal(config.model, 'qwen3-asr-flash');
      assert.equal(config.protocol, 'chat_audio');
    });
  });

  it('ASR_API_KEY 显式设置时优先于 DASHSCOPE_API_KEY（换供应商互不影响聊天链）', () => {
    withEnv({ ASR_API_KEY: 'own-key', ASR_BASE_URL: 'https://api.siliconflow.cn/v1', ASR_MODEL: 'FunAudioLLM/SenseVoiceSmall', ASR_PROTOCOL: 'transcriptions', DASHSCOPE_API_KEY: 'dashscope-key' }, () => {
      const config = getAsrConfig();
      assert.equal(config.apiKey, 'own-key');
      assert.equal(config.baseUrl, 'https://api.siliconflow.cn/v1');
      assert.equal(config.protocol, 'transcriptions');
    });
  });

  it('ASR_PROTOCOL=transcriptions 或 chat_audio 均可显式指定；baseUrl 去尾部斜杠', () => {
    withEnv({ ASR_API_KEY: 'k', ASR_BASE_URL: 'https://example.com/v1/', ASR_PROTOCOL: 'transcriptions' }, () => {
      const config = getAsrConfig();
      assert.equal(config.protocol, 'transcriptions');
      assert.equal(config.baseUrl, 'https://example.com/v1');
    });
  });
});

describe('音频载荷校验', () => {
  it('接受 webm/opus（MediaRecorder 默认产物），MIME 归一化去掉 codecs 后缀', () => {
    const result = validateAudioPayload({ base64: Buffer.alloc(4096, 1).toString('base64'), mime: 'audio/webm;codecs=opus' });
    assert.equal(result.ok, true);
    assert.equal(normalizeMime('audio/webm;codecs=opus'), 'audio/webm');
    assert.equal(isAllowedMime('audio/webm;codecs=opus'), true);
    assert.equal(isAllowedMime('VIDEO/MP4'), false);
  });

  it('拒绝空载荷、过短音频、超上限音频与非法 MIME', () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 1).toString('base64');
    assert.equal(validateAudioPayload({ base64: '', mime: 'audio/webm' }).ok, false);
    assert.equal(validateAudioPayload({ base64: Buffer.alloc(16, 1).toString('base64'), mime: 'audio/webm' }).ok, false);
    assert.equal(validateAudioPayload({ base64: big, mime: 'audio/webm' }).ok, false);
    const badMime = validateAudioPayload({ base64: Buffer.alloc(4096, 1).toString('base64'), mime: 'video/mp4' });
    assert.equal(badMime.ok, false);
    if (!badMime.ok) assert.match(badMime.message, /不支持的音频格式/);
  });

  it('扩展名映射覆盖 MediaRecorder 全部产出', () => {
    assert.equal(extForMime('audio/webm;codecs=opus'), 'webm');
    assert.equal(extForMime('audio/mp4'), 'mp4');
    assert.equal(extForMime('audio/mpeg'), 'mp3');
    assert.equal(extForMime('audio/x-wav'), 'wav');
  });
});
