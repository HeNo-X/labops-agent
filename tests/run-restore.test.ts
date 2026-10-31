import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@shared/'))return next(new URL('../shared/'+specifier.slice(8)+'.ts',import.meta.url).href,context);if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);return next(specifier,context);}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {snapshotMs,messageStatusOf,isConverged}=await import('../web/lib/run-snapshot.ts');
import type {RunSnapshot} from '../shared/types.ts';

const snap=(over:Partial<RunSnapshot>={}):RunSnapshot=>({
  runId:'run-1',conversationId:'c1',phase:null,toolCalls:[],answerText:'',proposals:[],
  sourceType:'snapshot',engine:'demo',model:null,lastSeq:null,terminal:null,saved:false,
  startedAt:'2026-10-30T02:00:00.000Z',endedAt:null,assistantMessageId:null,plan:null,...over
});

test('T5-06 未拿到明确终态时不得判定为已收敛（awaiting_confirm 也不算完成）',()=>{
  const waiting=snap({phase:'awaiting_confirm',terminal:null,saved:false});
  assert.equal(isConverged(waiting),false,'快照显示等确认时，UI 不得显示"已完成"');
  assert.equal(isConverged(snap({phase:'completed',terminal:'completed',saved:true})),true);
  assert.equal(isConverged(snap({terminal:'interrupted'})),true);
});

test('T5-07 终态映射：completed/failed/cancelled/interrupted 各自如真，不把中断说成成功',()=>{
  assert.equal(messageStatusOf('completed'),'completed');
  assert.equal(messageStatusOf('failed'),'failed');
  assert.equal(messageStatusOf('cancelled'),'cancelled');
  assert.equal(messageStatusOf('interrupted'),'interrupted');
  // null（仍在运行）绝不会被当成 completed —— 调用方在 isConverged 处就已拦住
  assert.notEqual(messageStatusOf(null),'completed');
});

test('T5-08 耗时只由服务端起止时间算出，缺失或倒序时返回 null（不用本地时钟补）',()=>{
  assert.equal(snapshotMs({startedAt:'2026-10-30T02:00:00.000Z',endedAt:'2026-10-30T02:00:08.400Z'}),8400);
  assert.equal(snapshotMs({startedAt:'2026-10-30T02:00:00.000Z',endedAt:null}),null);
  assert.equal(snapshotMs({startedAt:null,endedAt:null}),null);
  assert.equal(snapshotMs({startedAt:'2026-10-30T02:00:09.000Z',endedAt:'2026-10-30T02:00:01.000Z'}),null,'倒序不产生负数耗时');
  assert.equal(snapshotMs({startedAt:'not-a-date',endedAt:'2026-10-30T02:00:01.000Z'}),null);
});
