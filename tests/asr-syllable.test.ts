/**
 * Tier B 同音纠错（B3）—— 安全性优先于召回率
 * ============================================================================
 *  这一层把纠错长度门槛从 4 字降到 2 字，收益和风险同时变大。
 *  所以用例的主体不是"能不能改对"，而是**四种必须不改的情况是否真的没改**：
 *    ① 同音歧义键（一个读音对应多个标准词）→ 整键跳过
 *    ② 保护词（与术语同音的高频常用词，如 保修/教室/要是）→ 永不替换
 *    ③ 窗口里有字表外的字 → 无法确认同音 → 不改
 *    ④ 同音串只是另一个词的开头（「门进入」）→ blockAfter 挡住
 *  跑：node --test tests/asr-syllable.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correctTranscript,
  lexiconFromDataset,
  type LexiconEntry
} from '../server/llm/asr-lexicon.ts';
import {
  loadGlossaryData,
  glossaryToLexicon,
  charSyllableTable,
  ambiguousSyllables
} from '../server/llm/asr-glossary.ts';

const entry = (canonical: string, sy: string, aliases: string[] = [], blockAfter: string[] = []): LexiconEntry => ({
  canonical,
  norm: canonical.toLowerCase(),
  kind: 'term',
  sy,
  aliases,
  blockAfter
});

// ---------------------------------------------------------------- ① 同音歧义
test('一个音节串对应多个标准词时整键跳过：谁都不改', () => {
  const lex = [entry('应用', 'yingyong'), entry('映用', 'yingyong')];
  const table = new Map([['应', 'ying'], ['用', 'yong'], ['映', 'ying'], ['硬', 'ying'], ['永', 'yong']]);
  const r = correctTranscript('这个硬永怎么设', lex, { syllables: table, ambiguous: new Set(['yingyong']) });
  assert.equal(r.text, '这个硬永怎么设', '歧义键下绝不允许猜一个');
  assert.deepEqual(r.corrections, []);
});

test('歧义键由 ambiguousSyllables 派生，且真实术语表当前为 0（0 不代表以后也 0）', () => {
  const terms = loadGlossaryData().terms;
  assert.equal(ambiguousSyllables(terms).size, 0, '新增词条引入了同音歧义，必须显式处理而不是悄悄改错');
  const clash = glossaryToLexicon([
    { canonical: '甲', syll: ['jia'], sy: 'jia', aliases: [], weight: 3, domain: 'equipment', blockAfter: [] },
    { canonical: '价', syll: ['jia'], sy: 'jia', aliases: [], weight: 3, domain: 'equipment', blockAfter: [] }
  ]);
  assert.equal(clash.length, 2);
});

// ---------------------------------------------------------------- ② 保护词
test('保护词永不被替换：保修/教室/要是 这类同音常用词是最大误改源', () => {
  const lex = [entry('报修', 'baoxiu'), entry('教师', 'jiaoshi'), entry('钥匙', 'yaoshi')];
  const table = new Map([
    ['保', 'bao'], ['修', 'xiu'], ['报', 'bao'], ['教', 'jiao'], ['室', 'shi'], ['师', 'shi'],
    ['要', 'yao'], ['是', 'shi'], ['钥', 'yao'], ['匙', 'shi']
  ]);
  const protect = new Set(['保修', '教室', '要是']);

  for (const text of ['这台设备还在保修期内', '教室今天没人', '要是明天没课呢']) {
    const r = correctTranscript(text, lex, { syllables: table, protect });
    assert.equal(r.text, text, `${text} 被误改了：${JSON.stringify(r.corrections)}`);
  }

  // 同一批词条在非同音串上仍然正常工作
  assert.equal(correctTranscript('这台设备我要报休', [entry('报修', 'baoxiu')], { syllables: new Map([['这', 'zhe'], ['报', 'bao'], ['休', 'xiu']]) }).text
    .includes('报修'), true);
});

// ---------------------------------------------------------------- ③ 未知字
test('窗口里有一个字不在音节表里 → 无法确认同音 → 不改（宁可漏改）', () => {
  const lex = [entry('移液枪', 'yiyeqiang')];
  const table = new Map([['移', 'yi'], ['液', 'ye'], ['枪', 'qiang'], ['一', 'yi'], ['叶', 'ye']]);
  // 「一业枪」里的「业」不在表里 → 整窗放弃
  assert.equal(correctTranscript('一业枪在哪', lex, { syllables: table }).text, '一业枪在哪');
  // 「一叶枪」每个字都在表里且完全同音 → 改
  assert.equal(correctTranscript('帮我看看一叶枪明天有没有人借走', lex, { syllables: table }).text, '帮我看看移液枪明天有没有人借走');
});

test('单字词一律不参与：一个音节对应的候选字太多，没有区分度', () => {
  const lex = [entry('枪', 'qiang')];
  const table = new Map([['枪', 'qiang'], ['墙', 'qiang']]);
  assert.equal(correctTranscript('墙呢', lex, { syllables: table }).text, '墙呢');
});

// ---------------------------------------------------------------- ④ 邻接阻断
test('同音串只是另一个词的开头时不改：「门进入」不是「门禁」', () => {
  const lex = [entry('门禁', 'menjin', [], ['入', '出', '来', '去'])];
  const table = new Map([['门', 'men'], ['禁', 'jin'], ['进', 'jin'], ['金', 'jin'], ['入', 'ru'], ['房', 'fang']]);
  assert.equal(correctTranscript('他从门进入机房', lex, { syllables: table }).text, '他从门进入机房');
  assert.equal(correctTranscript('门进刷不开', lex, { syllables: table }).text, '门禁刷不开', '没有阻断字跟在后面时应当照改');
});

// ---------------------------------------------------------------- 别名路径
test('别名做表层精确替换，且命中的区间不再被音节路径二次改动', () => {
  const lex = [entry('服务器', 'fuwuqi', ['复物器'])];
  const table = new Map([['服', 'fu'], ['务', 'wu'], ['器', 'qi'], ['复', 'fu'], ['物', 'wu'], ['那', 'na'], ['台', 'tai']]);
  const r = correctTranscript('那台复物器又挂了', lex, { syllables: table });
  assert.equal(r.text, '那台服务器又挂了');
  assert.equal(r.corrections.length, 1, '同一处只该改一次');
  assert.equal(r.corrections[0]?.via, 'alias');
});

test('已经写对的词绝不"再改一次"：window 等于 canonical 时直接跳过', () => {
  const lex = [entry('服务器', 'fuwuqi', ['复物器'])];
  const table = new Map([['服', 'fu'], ['务', 'wu'], ['器', 'qi']]);
  const r = correctTranscript('服务器要重启一下', lex, { syllables: table });
  assert.equal(r.text, '服务器要重启一下');
  assert.deepEqual(r.corrections, []);
});

// ---------------------------------------------------------------- 护栏沿用
test('超出改动上限仍整段放弃，不做改一半的不可控改写', () => {
  const lex = Array.from({ length: 12 }, (_, i) => entry(`甲${i}乙`, `jia${i}yi`, [`假${i}以`]));
  const table = new Map([['假', 'jia'], ['以', 'yi']]);
  const text = Array.from({ length: 12 }, (_, i) => `假${i}以`).join('和');
  const r = correctTranscript(text, lex, { syllables: table });
  assert.equal(r.aborted, true);
  assert.equal(r.text, text, '放弃时必须原样返回');
  assert.deepEqual(r.corrections, []);
});

test('不传 opts 时行为与升级前完全一致（Tier A 老规则一字未动）', () => {
  const lex = lexiconFromDataset({
    labs: [{ name: 'E310' }],
    openLabs: [],
    timetable: [{ courseName: '计算机组成原理', classNames: ['计本2501'] }]
  });
  assert.equal(correctTranscript('e三一零今天有课吗', lex).text, 'E310今天有课吗');
  assert.equal(correctTranscript('帮我看看一叶枪', lex).text, '帮我看看一叶枪', '没有 Tier B 数据时短词不该被动');
  assert.equal(correctTranscript('310今天有课吗', lex).text, '310今天有课吗', '裸数字照旧永不猜');
});

// ---------------------------------------------------------------- 真实词表回归
test('★ 真表跑完所有对照样本：逐字不改（误改率硬门槛的用例化）', () => {
  const data = loadGlossaryData();
  const tierA = lexiconFromDataset({
    labs: [{ name: 'E310' }, { name: 'D517' }],
    openLabs: [],
    timetable: [{ courseName: '计算机组成原理', classNames: ['计本2501'] }]
  });
  const bundle = {
    entries: [...tierA, ...glossaryToLexicon(data.terms)],
    opts: { syllables: charSyllableTable(data.terms), protect: new Set(data.protect), ambiguous: ambiguousSyllables(data.terms) }
  };
  const controls = [
    '服务器要重启一下',
    '鼠标和键盘都换了新的',
    '投影仪连接正常',
    '今天签到率是百分之九十八',
    '电源与设备检查完成',
    '门窗与清场已经做完',
    '钥匙交接给下一个志愿者',
    '上午第二大节D517有课',
    '晚上AB节谁值班',
    '文渊E区的实验室都开放',
    '报修单已经验收了',
    '配电箱的门关好了',
    '空调温度调到二十六度',
    '实验台台面没有破损',
    '未完成事项有两条',
    '这个实验比较复杂',
    '实验报告还没交',
    '通知老师一声',
    '检查设备是否全部完成',
    '我要查一下明天的课程安排',
    '万用表和示波器都在实验台上',
    '门禁刷不开就报修'
  ];
  for (const text of controls) {
    const r = correctTranscript(text, bundle.entries, bundle.opts);
    assert.equal(r.text, text, `${text} → ${r.text}（改动：${JSON.stringify(r.corrections)}）`);
  }
});

test('真表能纠正若干典型同音器材/操作词，并如实标注 via 与位置', () => {
  const data = loadGlossaryData();
  const entries = glossaryToLexicon(data.terms);
  const opts = { syllables: charSyllableTable(data.terms), protect: new Set(data.protect), ambiguous: ambiguousSyllables(data.terms) };

  const r = correctTranscript('那台复物器又挂了', entries, opts);
  assert.equal(r.text, '那台服务器又挂了');
  assert.equal(r.corrections[0]?.to, '服务器');
  assert.equal(r.corrections[0]?.at, 2, '位置必须落在原文下标上');

  const multi = correctTranscript('查作松了要报休', entries, opts);
  assert.equal(multi.text, '插座松了要报修');
  assert.equal(multi.corrections.length, 2);

  const phrase = correctTranscript('电源与蛇备都查了吗', entries, opts);
  assert.equal(phrase.text, '电源与设备都查了吗', '固定短语必须整块替换');
});

test('检查标准 不被"检查表"吞掉（blockAfter 在真表上的回归）', () => {
  const data = loadGlossaryData();
  const entries = glossaryToLexicon(data.terms);
  const opts = { syllables: charSyllableTable(data.terms), protect: new Set(data.protect), ambiguous: ambiguousSyllables(data.terms) };
  assert.equal(correctTranscript('检查标准是什么', entries, opts).text, '检查标准是什么');
});
