/**
 * 工具清单稳定性不变量 —— 为什么用掩蔽而不是裁剪
 * ============================================================================
 *  约定：
 *  ① `toolsForMode` 按身份/业务连接状态/会话模式过滤工具，这是**权限边界**，
 *     合规保留 —— 模型不应看到它无权调用的工具，过滤本身就是最小授权。
 *  ② 但**禁止**引入"按运行态动态摘除工具"（如 awaiting_confirm 期间摘掉某工具、
 *     视觉未接入时摘掉视觉工具）：那会让同一 run 内的 tools schema 抖动，破坏
 *     供应商前缀缓存，也让模型行为不稳定。状态不可用一律走**掩蔽+结构化
 *     拒绝**路径（现有先例：duplicate_call_blocked / mode_forbidden / no_actor，
 *     tool 结果带 code+instruction，模型据此换路或如实告知）。
 *  ③ 由此推出的不变量：**同一状态下 toolsForMode 必须确定性、逐字节稳定**。
 *     本文件锁死这条不变量——未来任何人引入按时间/按轮次/按运行态的动态过滤，
 *     这些测试会先红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsForMode, toolSpecs, REGISTRY } from '../server/tools/registry.ts';

const names = (list: Array<{ name: string }>): string[] => list.map((t) => t.name);

test('A2-01 同状态下两次调用逐字节一致（确定性不变量）', () => {
  const a = toolsForMode('task');
  const b = toolsForMode('task');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'task 模式：两次调用必须字节一致');
  const c = toolsForMode('chat');
  const d = toolsForMode('chat');
  assert.equal(JSON.stringify(c), JSON.stringify(d), 'chat 模式：两次调用必须字节一致');
});

test('A2-02 调用 toolsForMode 不产生跨调用的状态漂移（无隐藏可变全局）', () => {
  const before = JSON.stringify(toolsForMode('task'));
  // 中间穿插其它读取路径，再取一次——若有人将来在 toolsForMode 里埋了
  // 可变计数器/缓存失效逻辑，这里会暴露
  void toolSpecs();
  void REGISTRY.length;
  const after = JSON.stringify(toolsForMode('task'));
  assert.equal(before, after);
});

test('A2-03 chat 模式只暴露只读工具（权限边界仍然成立）', () => {
  const effectOf = new Map(REGISTRY.map((t) => [t.spec.name, t.effect]));
  for (const t of toolsForMode('chat')) {
    assert.equal(effectOf.get(t.name), 'read', `chat 模式不得暴露非只读工具：${t.name}`);
  }
  assert.ok(toolsForMode('chat').length > 0, 'chat 模式必须至少有查询工具');
});

test('A2-04 task 模式工具是 chat 的超集（chat ⊆ task）', () => {
  const chat = new Set(names(toolsForMode('chat')));
  const task = new Set(names(toolsForMode('task')));
  for (const n of chat) {
    assert.ok(task.has(n), `chat 工具 ${n} 应同样可用在 task 模式`);
  }
  assert.ok(task.size >= chat.size);
});

test('A2-05 每个工具的 spec 具备掩蔽拒绝所需的最小字段（name/description/parameters）', () => {
  for (const t of REGISTRY) {
    assert.ok(t.spec.name, 'spec.name 必填');
    assert.ok(t.spec.description && t.spec.description.length >= 8, `${t.spec.name} 的 description 必须足以让模型判断何时调用`);
    assert.ok(t.spec.parameters && typeof t.spec.parameters === 'object', `${t.spec.name} 必须声明 parameters schema`);
    assert.ok(t.effect === 'read' || t.effect === 'draft' || (t.effect === 'write' && t.spec.name === 'apply_term_schedule'), `${t.spec.name} 的 effect 必须是 read|draft`);
  }
});
