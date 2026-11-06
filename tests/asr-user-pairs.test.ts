/**
 * U1 用户登记词对（第零遍精确替换）—— 契约与边界
 * ============================================================================
 *  这条链路和词典规则的性质不一样：每一对都是**说话的人亲手写的**，所以"要不要改"
 *  不由系统判断，但"能改成什么形状"仍由系统兜底。测试盯着三件事：
 *    ① 来路不明的请求体（不是数组、单字、超长、from===to、控制字符、重复）必须清干净；
 *    ② 生效范围可预测：命中处全换、长的先占位、被它占的区间后面不再二次改；
 *    ③ 叫停语义诚实：skipLexicon 只停词典自动规则，用户自己写的词对照样生效，
 *       并且与词典改动共用同一个"超上限就整段放弃"的预算。
 *
 *  运行：node --test tests/asr-user-pairs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeTermPairs,
  correctTranscript,
  type LexiconEntry,
  type UserTermPair
} from '../server/llm/asr-lexicon.ts';

const entry = (over: Partial<LexiconEntry>): LexiconEntry => ({
  canonical: '移液枪',
  norm: '移液枪',
  kind: 'term',
  ...over
});

const pair = (from: string, to: string): UserTermPair => ({ from, to });

// ---------------------------------------------------------------- 清洗
test('termPairs 只收"两边都写清楚"的词对：单字、空、相同、超长一律丢掉', () => {
  const out = sanitizeTermPairs([
    pair('一叶枪', '移液枪'),
    pair('枪', '枪头'), // 单字：同音面太宽，一次手滑能毁掉整句
    pair('移液枪', '移液枪'), // from===to：无意义且会自环
    pair('  ', '空白'), // 空 from
    pair('甲乙', '   '), // 空 to
    pair('这是一个长得超出二十四个字符上限的登记条目用来验证长度过滤', '短词'),
    pair('换行\n里混', '正常'), // 控制字符
    { from: 42, to: '数字' }, // 类型不对
    '不是对象'
  ]);
  assert.deepEqual(out, [pair('一叶枪', '移液枪')], JSON.stringify(out));
});

test('清洗会 trim、同一 from 只认第一条、最多 100 条（顺序可复现）', () => {
  const padded = sanitizeTermPairs([pair('  一叶枪  ', '移液枪'), pair('一叶枪', '枪头')]);
  assert.deepEqual(padded, [pair('一叶枪', '移液枪')], '重复 from 不该给第二条机会');

  const many: UserTermPair[] = [];
  for (let i = 0; i < 150; i += 1) many.push(pair(`词${i}`, `正${i}`));
  const capped = sanitizeTermPairs(many);
  assert.equal(capped.length, 100, `上限没生效：${capped.length}`);
  assert.equal(capped[0]!.from, '词0', '保留的必须是最前面的');

  assert.deepEqual(sanitizeTermPairs(undefined), []);
  assert.deepEqual(sanitizeTermPairs('not-an-array'), []);
  assert.deepEqual(sanitizeTermPairs({ 0: pair('甲乙', '丙丁') }), [], '类数组对象不算');
});

// ---------------------------------------------------------------- 第零遍行为
test('用户词对精确替换每一处出现，并如实标 via=user / kind=term', () => {
  const text = '一叶枪放在D五一七，另一把一叶枪在柜子里';
  const r = correctTranscript(text, [], { userPairs: [pair('一叶枪', '移液枪')] });
  assert.equal(r.text, '移液枪放在D五一七，另一把移液枪在柜子里');
  assert.equal(r.corrections.length, 2, JSON.stringify(r.corrections));
  for (const c of r.corrections) {
    assert.equal(c.via, 'user');
    assert.equal(c.kind, 'term');
    assert.equal(c.from, '一叶枪');
  }
  assert.equal(r.aborted, false);
});

test('长词先占位：同一条登记里「一叶枪」不会被「叶枪」切成两半各改一次', () => {
  const pairs = [pair('叶枪', '枪头'), pair('一叶枪', '移液枪')]; // 故意把短的排在前面
  const r = correctTranscript('把一叶枪收好', [], { userPairs: pairs });
  assert.equal(r.text, '把移液枪收好', JSON.stringify(r.corrections));
  assert.equal(r.corrections.length, 1, '一条被切碎就成了两处改动，用户看到的是一句被拆散的话');
  assert.equal(r.corrections[0]!.to, '移液枪');
});

test('用户词对占住的区间，词典规则不再二次改动（先到先得）', () => {
  const lexicon: LexiconEntry[] = [entry({ canonical: '移液器和枪头', aliases: ['一叶枪'], sy: 'yiyeqiang' })];
  // 别名替换住在第三遍里，所以必须给它一份能用的音节表，否则这条用例其实在测空转
  const syllables = new Map([['一', 'yi'], ['叶', 'ye'], ['枪', 'qiang'], ['移', 'yi'], ['液', 'ye'], ['和', 'he'], ['头', 'tou']]);

  const both = correctTranscript('检查一叶枪', lexicon, { syllables, userPairs: [] });
  assert.equal(both.corrections[0]?.to, '移液器和枪头', '前提：词典本来会把这处改掉');

  const r = correctTranscript('检查一叶枪', lexicon, { syllables, userPairs: [pair('一叶枪', '移液枪')] });
  assert.equal(r.text, '检查移液枪', JSON.stringify(r.corrections));
  assert.equal(r.corrections[0]!.via, 'user');
  assert.equal(r.corrections.length, 1, '同一处不该被别名再改一遍');
});

test('没登记词对时行为与改造前一字不差（老用例的回归护栏）', () => {
  const lexicon: LexiconEntry[] = [entry({ canonical: 'D517', kind: 'room', norm: 'd517' })];
  const withOut = correctTranscript('明天的D五一七', lexicon, {});
  const withEmpty = correctTranscript('明天的D五一七', lexicon, { userPairs: [] });
  assert.deepEqual(withEmpty, withOut);
  assert.equal(withOut.text, '明天的D517', `老规则本身要照常生效：${withOut.text}`);
});

// ---------------------------------------------------------------- 叫停语义
test('skipLexicon 只停词典自动改动：房间号不动，用户登记的写法照改', () => {
  const lexicon: LexiconEntry[] = [entry({ canonical: 'D517', kind: 'room', norm: 'd517' })];
  const r = correctTranscript('D五一七的一叶枪要修', lexicon, {
    userPairs: [pair('一叶枪', '移液枪')],
    skipLexicon: true
  });
  assert.equal(r.text, 'D五一七的移液枪要修', JSON.stringify(r.corrections));
  assert.equal(r.corrections.length, 1);
  assert.equal(r.corrections[0]!.via, 'user');

  const auto = correctTranscript('D五一七的一叶枪要修', lexicon, { userPairs: [pair('一叶枪', '移液枪')] });
  assert.equal(auto.corrections.length, 2, '不开 skipLexicon 时房间号本来会被改');
});

test('用户词对与词典共用同一个改动预算：超上限整段不改，不做改一半的不可控改写', () => {
  const text = Array.from({ length: 11 }, () => '一叶枪').join('、');
  const r = correctTranscript(text, [], { userPairs: [pair('一叶枪', '移液枪')] });
  assert.equal(r.aborted, true, `11 处命中必须整段放弃：${r.corrections.length}`);
  assert.equal(r.text, text, '放弃就是原样返回');
  assert.deepEqual(r.corrections, []);
});

test('空文本、空词典、空词对三种"没东西可改"都不抛异常', () => {
  assert.deepEqual(correctTranscript('', [], { userPairs: [pair('甲乙', '丙丁')] }), { text: '', corrections: [], aborted: false });
  assert.deepEqual(correctTranscript('正常一句话', [], {}), { text: '正常一句话', corrections: [], aborted: false });
  assert.equal(correctTranscript('正常一句话', [], { userPairs: [] }).text, '正常一句话');
});
