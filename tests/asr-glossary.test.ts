/**
 * 实验室术语表（Tier B）自测 —— B1 验收项
 * ============================================================================
 *  为什么这些用例必须进 CI 而不是"看一眼就行"：
 *  音节键写错**不会报错，只会让那个词永远不被纠正**。这是静默失效，
 *  靠人读 JSON 读不出来，只能靠不变量断言兜住。
 *  运行：node --test tests/asr-glossary.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadGlossary,
  validateGlossary,
  syllableIndex,
  ambiguousSyllables,
  charSyllableTable,
  glossaryFingerprint,
  hotwordVocabulary,
  buildContextText,
  type AsrDomain,
  type GlossaryTerm
} from '../server/llm/asr-glossary.ts';

const term = (canonical: string, syll: string[], aliases: string[] = [], weight = 3, domain: AsrDomain = 'equipment', blockAfter: string[] = []): GlossaryTerm => ({
  canonical,
  syll,
  sy: syll.join(''),
  aliases,
  weight,
  domain,
  blockAfter
});

// ---------------------------------------------------------------- 真表自检
test('线上术语表通过全部不变量（字数==音节数、音节合法、权重合法、无重复、别名不撞标准词）', () => {
  const terms = loadGlossary();
  const problems = validateGlossary(terms);
  assert.deepEqual(problems, [], '术语表存在会静默失效的问题：\n' + problems.join('\n'));
});

test('线上术语表逐条满足「音节数 == 码点数」，且音节只含小写字母', () => {
  for (const t of loadGlossary()) {
    assert.equal(Array.from(t.canonical).length, t.syll.length, `${t.canonical}: ${Array.from(t.canonical).length} 字 vs ${t.syll.length} 音节`);
    for (const s of t.syll) assert.match(s, /^[a-z]+$/, `${t.canonical}: 非法音节 ${s}`);
  }
});

test('装载即派生 sy，且 sy 是 syll 的连写（匹配层依赖这个一致性）', () => {
  for (const t of loadGlossary()) assert.equal(t.sy, t.syll.join(''), t.canonical);
});

test('术语表规模与域覆盖：不少于 120 条，六个域都有，2–3 字词确有覆盖', () => {
  const terms = loadGlossary();
  assert.ok(terms.length >= 120, `术语表只有 ${terms.length} 条`);
  const domains: Set<string> = new Set(terms.map((t) => t.domain));
  for (const d of ['equipment', 'check', 'place', 'operation', 'period', 'document']) assert.ok(domains.has(d), `缺域 ${d}`);
  const short = terms.filter((t) => Array.from(t.canonical).length <= 3);
  assert.ok(short.length >= 40, `2–3 字短词只有 ${short.length} 条，不足以支撑 B3 的降门槛`);
  // 「晚上AB节」这类含拉丁字母的条目必须在表里，否则音节对齐的边界没人管
  assert.ok(terms.some((t) => /[A-Za-z]/.test(t.canonical)), '缺含拉丁字母的节次条目');
});

test('域口径不许漂回通用实验室：本中心是计算机/电子类机房，化学玻璃仪器与生物器材一律不收', () => {
  const chemistry = /液枪|液器|烧杯|量筒|滴定|酒精灯|石棉|三角烧|容量瓶|锥形瓶|离心机|培养箱|灭菌|超净|通风橱|水浴|摇床|酶标|分光|移液/;
  for (const t of loadGlossary()) {
    assert.ok(!chemistry.test(t.canonical), `${t.canonical} 不属于本实验中心的设备域`);
  }
  // 一手依据里确实存在的词必须在表里
  const have = new Set(loadGlossary().map((t) => t.canonical));
  for (const word of ['服务器', '投影仪', '门禁', '电源', '鼠标', '键盘', '主机', '显示器', '电源与设备', '门窗与清场', '钥匙交接', '文渊']) {
    assert.ok(have.has(word), `缺一手依据词 ${word}`);
  }
});

test('hotwordVocabulary：权重夹在 1～5、按权重降序取前 N，同样输入永远同样输出', () => {
  const mixed = [
    term('甲词', ['jia', 'ci'], [], 3, 'operation'),
    term('乙词', ['yi', 'ci'], [], 9, 'operation'), // 越界权重
    term('丙词', ['bing', 'ci'], [], 5, 'operation'),
    term('丁词', ['ding', 'ci'], [], 0, 'operation') // 越界权重
  ];
  const all = hotwordVocabulary(mixed, 99);
  // 排序按**原始**权重，输出时才夹到 1～5：所以越界的 9 仍排在 5 前面
  assert.deepEqual(Object.entries(all), [['乙词', 5], ['丙词', 5], ['甲词', 3], ['丁词', 1]], JSON.stringify(all));
  assert.equal(all['丁词'], 1, '权重 0 应被夹到下限 1，而不是原样发给上游');
  assert.deepEqual(Object.keys(hotwordVocabulary(mixed, 2)).length, 2);
  assert.deepEqual(hotwordVocabulary(mixed, 0), {});

  // 真实表：不超过 500，且每条都是表里的标准写法
  const real = hotwordVocabulary(loadGlossary(), 500);
  const names = new Set(loadGlossary().map((t) => t.canonical));
  assert.equal(Object.keys(real).length, 148, `线上术语表 148 条，热词表应全量收下：${Object.keys(real).length}`);
  for (const [word, weight] of Object.entries(real)) {
    assert.ok(names.has(word), `热词不是表里的标准写法：${word}`);
    assert.ok(weight >= 1 && weight <= 5, `${word} 权重越界 ${weight}`);
  }
});

// ---------------------------------------------------------------- 装载器的失败模式
test('术语表文件缺失 / JSON 坏 / 缺 terms / domain 非法 → 一律抛，不静默返回空表', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-glossary-'));
  try {
    assert.throws(() => loadGlossary(path.join(dir, 'nope.json')), /缺少术语表文件/);

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ not json', 'utf8');
    assert.throws(() => loadGlossary(broken), /解析失败/);

    const noTerms = path.join(dir, 'noterms.json');
    fs.writeFileSync(noTerms, JSON.stringify({ version: 1 }), 'utf8');
    assert.throws(() => loadGlossary(noTerms), /terms/);

    const badDomain = path.join(dir, 'baddomain.json');
    fs.writeFileSync(badDomain, JSON.stringify({ version: 1, terms: [{ canonical: '移液枪', syll: ['yi', 'ye', 'qiang'], aliases: [], weight: 4 }] }), 'utf8');
    assert.throws(() => loadGlossary(badDomain), /domain 非法/);

    // 坏表不许"降级为空表继续跑"——那等于术语表消失了而没人知道
    const mismatch = path.join(dir, 'mismatch.json');
    fs.writeFileSync(mismatch, JSON.stringify({ version: 1, terms: [{ canonical: '移液枪', syll: ['yi', 'ye'], aliases: [], weight: 4, domain: 'equipment' }] }), 'utf8');
    assert.throws(() => loadGlossary(mismatch), /校验未通过/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 校验器逐类问题
test('校验器能分别抓出：字数与音节不符、非法音节、权重越界、重复词条、别名撞标准词、别名自环', () => {
  const bad = [
    term('移液枪', ['yi', 'ye']), // 少一个音节
    term('离心机', ['li', 'xin', 'JI']), // 大写不是合法音节
    term('天平', ['tian', 'ping'], [], 9), // 权重越界
    term('烧杯', ['shao', 'bei']),
    term('烧杯', ['shao', 'bei']), // 重复
    term('量筒', ['liang', 'tong'], ['烧杯']), // 别名撞上另一个标准词
    term('插座', ['cha', 'zuo'], ['插座']) // 别名自环
  ];
  const problems = validateGlossary(bad);
  const joined = problems.join('\n');
  assert.match(joined, /移液枪: 字数 3 与音节数 2 不等/);
  assert.match(joined, /离心机: 含非小写字母音节/);
  assert.match(joined, /天平: weight=9 不在 1–5/);
  assert.match(joined, /烧杯: 重复出现 2 次/);
  assert.match(joined, /量筒: 别名「烧杯」本身是另一个标准词/);
  assert.match(joined, /插座: 别名与标准词相同/);
});

test('干净表返回空问题清单（校验器不能只会报错，也要能判"没毛病"）', () => {
  const clean = [term('移液枪', ['yi', 'ye', 'qiang'], ['一业枪'], 4), term('天平', ['tian', 'ping'], ['天瓶'], 5)];
  assert.deepEqual(validateGlossary(clean), []);
});

// ---------------------------------------------------------------- 歧义音节键
test('不冲突的表里没有歧义键（空是好事，但"空"不代表以后也空）', () => {
  const clean = [term('置顶', ['zhi', 'ding'], [], 3, 'operation'), term('制瓶', ['zhi', 'bing'], [], 3)];
  assert.deepEqual([...ambiguousSyllables(clean)], []);
});

test('同音节不同词必须被列进歧义键 —— B3 的短词纠错要据此整键跳过，这是防误改的闸门', () => {
  const ambiguous = [term('应用', ['ying', 'yong'], [], 3, 'operation'), term('应变', ['ying', 'bian'], [], 3), term('映用', ['ying', 'yong'], [], 3)];
  const keys = ambiguousSyllables(ambiguous);
  assert.equal(keys.size, 1, [...keys].join(','));
  assert.ok(keys.has('yingyong'));
  const index = syllableIndex(ambiguous);
  assert.equal(index.get('yingyong')?.length, 2);
  assert.deepEqual(index.get('yingbian')?.map((t) => t.canonical), ['应变']);
});

// ---------------------------------------------------------------- 字表派生
test('汉字音节表：同字多音的冲突字整字丢弃（未知字不参与短词纠错，宁可漏改不可错改）', () => {
  const table = charSyllableTable(loadGlossary());
  assert.ok(table.size > 150, `字表只有 ${table.size} 字，覆盖不足`);
  assert.equal(table.get('移'), 'yi');
  assert.equal(table.get('枪'), 'qiang');
  assert.equal(table.has('A'), false, '拉丁字母不应进字表（匹配时按字面比）');

  const conflicting = [term('银行', ['yin', 'hang'], [], 3, 'operation'), term('行走', ['xing', 'zou'], [], 3)];
  const dropped = charSyllableTable(conflicting);
  assert.equal(dropped.has('行'), false, '「行」被判成两个音节，必须整字丢弃');
});

test('指纹稳定且随内容变化（进缓存键与报告，防止"改了词表但没生效"）', () => {
  const a = glossaryFingerprint(loadGlossary());
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, glossaryFingerprint(loadGlossary()));
  const tweaked = loadGlossary();
  tweaked[0] = { ...tweaked[0], aliases: [...tweaked[0].aliases, '新误写'] };
  assert.notEqual(a, glossaryFingerprint(tweaked));
});

// ---------------------------------------------------------------- 上下文文本
test('上下文文本：只放词不放指令，且不超过字符预算（官方明确不支持传统系统提示词）', () => {
  const terms = loadGlossary();
  const full = buildContextText(terms, { maxChars: 100_000 });
  assert.ok(full.text.startsWith('实验室管理领域参考词'), full.text.slice(0, 40));
  for (const forbiddenWord of ['请', '必须', '你要', '你是', '注意', '应该', 'prompt']) {
    assert.ok(!full.text.includes(forbiddenWord), `上下文里混进了指令式措辞：${forbiddenWord}`);
  }
  assert.equal(full.omitted, 0);
  assert.equal(full.termCount, terms.length);
});

test('上下文预算：超出即丢词并计入 omitted，绝不悄悄超预算', () => {
  const terms = loadGlossary();
  const tight = buildContextText(terms, { maxChars: 120 });
  assert.ok(tight.chars <= 120, `号称预算 120，实际 ${tight.chars}`);
  assert.ok(tight.omitted > 0, '这么小的预算不可能全放下，omitted 必须可见');
  assert.equal(tight.termCount + tight.omitted, terms.length);
  const zero = buildContextText(terms, { maxChars: 0 });
  assert.equal(zero.termCount, 0);
  assert.equal(zero.omitted, terms.length);
});

test('上下文优先级：节次整块先保（最长最该留住），preferredDomains 影响次序', () => {
  const terms = loadGlossary();
  const tight = buildContextText(terms, { maxChars: 200 });
  assert.ok(tight.text.includes('上午第二大节'), '节次应优先保住：\n' + tight.text);
  const withPreferred = buildContextText(terms, { maxChars: 300, preferredDomains: ['document'] });
  assert.ok(withPreferred.text.includes('报修单'), withPreferred.text);
});

test('extraTerms（Tier A 的房间/班级/课程）进上下文时去重、去空', () => {
  const out = buildContextText(loadGlossary(), { maxChars: 100_000, extraTerms: ['E310', 'E310', '', '  D517  '] });
  assert.equal([...out.text.matchAll(/E310/g)].length, 1);
  assert.ok(out.text.includes('D517'));
});

test('紧预算下房间号要争到位置：它们最容易被听错，排在最后等于白留预算', () => {
  const terms = [
    term('投影仪', ['tou', 'ying', 'yi'], [], 5, 'equipment'),
    term('服务器', ['fu', 'wu', 'qi'], [], 5, 'equipment'),
    term('万用表', ['wan', 'yong', 'biao'], [], 5, 'equipment')
  ];
  // 预算刚好只放得下 header + 一个块
  const out = buildContextText(terms, { maxChars: 40, extraTerms: ['E310', 'D517'] });
  assert.ok(out.text.includes('E310'), `房间号被挤掉了：\n${out.text}`);
  assert.ok(out.omitted > 0, '被丢弃的词必须计数，否则"词表被截了"是隐形的');
});
