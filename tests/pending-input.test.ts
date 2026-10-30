import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enqueuePending,resolvePendingOnTerminal,resolvePendingOnSwitchAway,mergeDraft} from '../web/lib/pending-input.ts';
import type {PendingInput} from '../web/lib/pending-input.ts';

const pending=(over:Partial<PendingInput>={}):PendingInput=>({conversationId:'c1',mode:'task',text:'再查一下 D517',createdAt:'2026-10-30T02:00:00.000Z',...over});

test('T3-01 终态后自动发送：同一会话且草稿为空',()=>{
  const out=resolvePendingOnTerminal({pending:pending(),conversationId:'c1',running:false,draft:''});
  assert.deepEqual(out,{action:'send',text:'再查一下 D517'});
});

test('T3-02 草稿冲突不猜测：终态时草稿非空 → 不发送，填回草稿',()=>{
  const out=resolvePendingOnTerminal({pending:pending(),conversationId:'c1',running:false,draft:'我正在写别的事'});
  assert.deepEqual(out,{action:'refill',text:'再查一下 D517'});
});

test('T3-03 会话隔离：A 会话排的句子，切到 B 会话时不得自动发送',()=>{
  const out=resolvePendingOnTerminal({pending:pending({conversationId:'A'}),conversationId:'B',running:false,draft:''});
  assert.deepEqual(out,{action:'none',reason:'other_conversation'});
  // 当前没有选中会话（草稿态）同样不发
  assert.deepEqual(resolvePendingOnTerminal({pending:pending(),conversationId:null,running:false,draft:''}),{action:'none',reason:'other_conversation'});
});

test('T3-04 仍在运行时不消费（避免第二轮抢跑）',()=>{
  assert.deepEqual(resolvePendingOnTerminal({pending:pending(),conversationId:'c1',running:true,draft:''}),{action:'none',reason:'still_running'});
});

test('T3-05 没有待发送时无副作用',()=>{
  assert.deepEqual(resolvePendingOnTerminal({pending:null,conversationId:'c1',running:false,draft:''}),{action:'none',reason:'empty'});
  assert.deepEqual(resolvePendingOnTerminal({pending:pending({text:'   '}),conversationId:'c1',running:false,draft:''}),{action:'none',reason:'empty'});
});

test('T3-06 运行中重复 Enter：只保留最后一条，并标记被替换（UI 需明示）',()=>{
  const first=enqueuePending(null,pending({text:'第一句'}));
  assert.equal(first.replaced,false);
  assert.equal(first.pending?.text,'第一句');
  const second=enqueuePending(first.pending,pending({text:'第二句'}));
  assert.equal(second.replaced,true);
  assert.equal(second.pending?.text,'第二句','只保留最后一条');
  // 文本完全相同不算"替换"，避免无意义的提示抖动
  assert.equal(enqueuePending(second.pending,pending({text:'第二句'})).replaced,false);
});

test('T3-07 排入空文本不覆盖已有待发送；排入后取消即清空',()=>{
  const had=enqueuePending(null,pending({text:'有效句子'})).pending;
  assert.equal(enqueuePending(had,pending({text:'   '})).pending,had,'空输入不得清掉已有待发送');
  // 取消 = 直接置空，不产生任何发送副作用（决策侧由 pending=null 保证）
  assert.deepEqual(resolvePendingOnTerminal({pending:null,conversationId:'c1',running:false,draft:''}),{action:'none',reason:'empty'});
});

test('T3-08 不同会话各自排队时，不产生跨会话的替换提示',()=>{
  const a=enqueuePending(null,pending({conversationId:'A',text:'A 的句子'}));
  const b=enqueuePending(a.pending,pending({conversationId:'B',text:'B 的句子'}));
  assert.equal(b.replaced,false,'跨会话不标替换');
  assert.equal(b.pending?.conversationId,'B','单条模型下以最后一次排入为准，且只作用于该会话');
});

test('T3-09 切走会话：不回落原会话自动发送，而是折回该会话草稿',()=>{
  // 人在 B 会话，A 会话的这轮结束 —— 判定为 fold_to_draft，绝不 send
  assert.deepEqual(
    resolvePendingOnSwitchAway({pending:pending({conversationId:'A',text:'补一句'}),activeConversationId:'B'}),
    {action:'fold_to_draft',conversationId:'A',text:'补一句'}
  );
  // 仍停留在原会话时不折叠（交给终态决策）
  assert.deepEqual(resolvePendingOnSwitchAway({pending:pending({conversationId:'A'}),activeConversationId:'A'}),{action:'none'});
  assert.deepEqual(resolvePendingOnSwitchAway({pending:null,activeConversationId:'B'}),{action:'none'});
});

test('T3-10 草稿合并保留原内容，另起一行追加，不覆盖',()=>{
  assert.equal(mergeDraft('我写了一半  ','补一句'),'我写了一半\n补一句');
  assert.equal(mergeDraft('', '补一句'),'补一句');
  assert.equal(mergeDraft('原有内容','   '),'原有内容','空文本不改动草稿');
});
