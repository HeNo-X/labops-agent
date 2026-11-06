/**
 * U3 语音词汇体检 —— 每一条结论都要有出处
 * ============================================================================
 *  体检端点唯一的价值是"说的比用户猜的准"。所以测试盯三件事：
 *    ① 主结论跟着**服务端配置**走（偏置关着就不能说"已发送"）；
 *    ② 预算结论用两次真实构造对比出来，不靠估；
 *    ③ 合并候选只在读音能从内置表已确认读音推出来时才给 syll，推不出来就标缺拼音 ——
 *       绝不猜一个读音填进去（错的音节会让"完全同音"变成"我们以为同音"）。
 *
 *  运行：node --test tests/asr-lexicon-report.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLexiconReport } from '../server/api/asr-lexicon-report.ts';
import { deriveSyllables, loadGlossaryData, type GlossaryTerm } from '../server/llm/asr-glossary.ts';

const term = (over: Partial<GlossaryTerm>): GlossaryTerm => ({
  canonical: '投影仪',
  syll: ['tou', 'ying', 'yi'],
  sy: 'touyingyi',
  aliases: ['投映仪'],
  weight: 4,
  domain: 'equipment',
  blockAfter: [],
  ...over
});
// 表里刻意备齐"门禁/甲板/电源"这些字，让候选词的读音推导有真实依据可查
const TABLE: GlossaryTerm[] = [
  term({}),
  term({ canonical: '移液枪', syll: ['yi', 'ye', 'qiang'], sy: 'yiyeqiang', aliases: ['一叶枪'], domain: 'equipment' }),
  term({ canonical: '电源', syll: ['dian', 'yuan'], sy: 'dianyuan', aliases: [], domain: 'equipment' }),
  term({ canonical: '门禁', syll: ['men', 'jin'], sy: 'menjin', aliases: [], domain: 'operation' }),
  term({ canonical: '甲板', syll: ['jia', 'ban'], sy: 'jiaban', aliases: [], domain: 'place' })
];
const PROTECT = ['保修'];

const withEnv = (values: Record<string, string | undefined>, run: () => void): void => {
  const keys = Object.keys(values);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  try {
    run();
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

// ---------------------------------------------------------------- 常用词结论
test('偏置关着时不许报"已进入上下文"：每条都给 bias-off 与原因', () => {
  withEnv({ ASR_CONTEXT_ENABLED: undefined }, () => {
    const r = buildLexiconReport(TABLE, PROTECT, { keywords: ['门禁'], pairs: [], datasetTerms: [] });
    assert.equal(r.effective.contextEnabled, false, '默认就该是关');
    assert.equal(r.keywords[0]!.verdict, 'bias-off');
    assert.match(r.keywords[0]!.why, /ASR_CONTEXT_ENABLED/);
  });
});

test('偏置打开：新词报已进入上下文，内置表本来就有的报"重复登记不额外起作用"', () => {
  withEnv({ ASR_CONTEXT_ENABLED: '1', ASR_CONTEXT_MAX_CHARS: '1200' }, () => {
    const r = buildLexiconReport(TABLE, PROTECT, { keywords: ['键盘', '投影仪'], pairs: [], datasetTerms: [] });
    assert.equal(r.keywords[0]!.verdict, 'in-context', '表里没有的新词该报"已进入上下文"');
    assert.equal(r.keywords[0]!.hotwordFits, true);
    assert.equal(r.keywords[1]!.verdict, 'already-in-builtin', '投影仪在内置表里');
  });
});

test('预算用满时报"被挤掉"并给出可上调的变量名（不是"可能没生效"这种废话）', () => {
  withEnv({ ASR_CONTEXT_ENABLED: '1', ASR_CONTEXT_MAX_CHARS: '24' }, () => {
    const r = buildLexiconReport(TABLE, PROTECT, { keywords: ['门禁电源开关'], pairs: [], datasetTerms: ['E310'] });
    assert.equal(r.keywords[0]!.verdict, 'dropped-by-budget', JSON.stringify(r.keywords[0]));
    assert.match(r.keywords[0]!.why, /ASR_CONTEXT_MAX_CHARS/);
  });
});

test('热词长度是次要事实：超长词照样能进上下文，但附带说明它进不了即时热词表', () => {
  const longWord = '这是一条长度超过十五个字符的热词候选词用来验证附带说明';
  withEnv({ ASR_CONTEXT_ENABLED: '1', ASR_CONTEXT_MAX_CHARS: '4000' }, () => {
    const r = buildLexiconReport(TABLE, PROTECT, { keywords: [longWord], pairs: [], datasetTerms: [] });
    assert.equal(r.keywords[0]!.hotwordFits, false);
    assert.equal(r.keywords[0]!.verdict, 'in-context', '主结论不该被次要事实顶掉');
    assert.match(r.keywords[0]!.why, /即时热词/);
  });
});

// ---------------------------------------------------------------- 词对结论
test('词对结论分得开：生效 / 撞保护词 / 改内置正确写法 / 覆盖内置别名 / 与内置重复', () => {
  withEnv({ ASR_CONTEXT_ENABLED: '1' }, () => {
    const r = buildLexiconReport(TABLE, PROTECT, {
      keywords: [],
      pairs: [
        { from: '门金', to: '门禁' },
        { from: '保修', to: '报修' }, // 撞 protect 常用词
        { from: '投影仪', to: '投印仪' }, // from 本身是内置正确写法
        { from: '投映仪', to: '电视' }, // 内置把 投映仪→投影仪，用户改成别的
        { from: '一叶枪', to: '移液枪' } // 与内置别名完全一致
      ],
      datasetTerms: []
    });
    const verdicts = Object.fromEntries(r.pairs.map((p) => [p.from, p.verdict]));
    assert.equal(verdicts['门金'], 'active');
    assert.equal(verdicts['保修'], 'collides-with-protect');
    assert.equal(verdicts['投影仪'], 'rewrites-a-builtin-term');
    assert.equal(verdicts['投映仪'], 'overrides-builtin-alias');
    assert.equal(verdicts['一叶枪'], 'redundant-with-builtin');
    assert.match(r.pairs.find((p) => p.from === '投映仪')!.why, /第零遍先占位/, '要说清谁赢');
  });
});

// ---------------------------------------------------------------- 合并候选
test('候选条目：拼音只用内置表已确认的读音推导，已有词不重复给，来源一律标 user', () => {
  withEnv({ ASR_CONTEXT_ENABLED: '1' }, () => {
    const r = buildLexiconReport(TABLE, PROTECT, {
      keywords: ['门禁电源', '电源'],
      pairs: [{ from: '门金电源', to: '电源板' }],
      datasetTerms: []
    });
    const byWord = Object.fromEntries(r.merge.candidates.map((c) => [c.canonical, c]));
    assert.deepEqual(byWord['门禁电源']?.syll, ['men', 'jin', 'dian', 'yuan'], JSON.stringify(byWord['门禁电源']));
    assert.deepEqual(byWord['电源板']?.syll, ['dian', 'yuan', 'ban'], '板 的依据来自表内「甲板」，不是猜的');
    assert.deepEqual(byWord['电源板']?.aliases, ['门金电源'], '词对里的误写要作为别名带过去');
    assert.equal(byWord['电源'], undefined, '内置表已有的词不该再出现在候选里');
    assert.ok(r.merge.candidates.length === 2, JSON.stringify(Object.keys(byWord)));
    assert.ok(r.merge.candidates.every((c) => c.domain === 'user'), '自定义来源要标出来，别混进人工审过的域');
  });
});

test('多音字推不出来：进 needPinyin，不猜读音', () => {
  // 长 在同一张表里读 chang 也读 zhang → charSyllableTable 整字丢弃，推导必须失败
  const table: GlossaryTerm[] = [
    term({ canonical: '电源', syll: ['dian', 'yuan'], sy: 'dianyuan', aliases: [] }),
    term({ canonical: '长跑', syll: ['chang', 'pao'], sy: 'changpao', aliases: [] }),
    term({ canonical: '长大', syll: ['zhang', 'da'], sy: 'zhangda', aliases: [] })
  ];
  assert.deepEqual(deriveSyllables('电源跑', table), ['dian', 'yuan', 'pao'], '不含多音字的词应当能推导');
  assert.equal(deriveSyllables('电源长', table), null, '含多音字必须返回 null');
  assert.equal(deriveSyllables('灯', table), null, '单字不给（内置表也不收单字条目）');
  const r = buildLexiconReport(table, [], { keywords: ['电源长'], pairs: [], datasetTerms: [] });
  assert.deepEqual(r.merge.candidates, []);
  assert.deepEqual(r.merge.needPinyin, ['电源长']);
});

test('报告里的内置概况跟着真表走（指纹/条数不是硬编码出来的）', () => {
  const real = loadGlossaryData();
  withEnv({ ASR_CONTEXT_ENABLED: '0' }, () => {
    const r = buildLexiconReport(real.terms, real.protect, { keywords: [], pairs: [], datasetTerms: [] });
    assert.equal(r.builtIn.terms, 148);
    assert.equal(r.builtIn.protect, 9);
    assert.equal(r.builtIn.ambiguousKeys, 0, '当前真表没有同音互撞，出现就该报警');
    assert.match(r.builtIn.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(r.builtIn.byDomain.equipment, 78);
  });
});
