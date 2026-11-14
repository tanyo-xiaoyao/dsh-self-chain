// 离线自检：跑 node selftest.mjs。数据文件全部指到临时目录，不碰真的自我链和记忆。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-self-'));
process.env.SELFCHAIN_CHAIN = path.join(tmp, 'chain.jsonl');
process.env.SELFCHAIN_SUMMARY = path.join(tmp, 'summary.md');
process.env.SELFCHAIN_PROPOSAL = path.join(tmp, 'proposal.jsonl');
process.env.SELFCHAIN_NOTES = path.join(tmp, 'notes');
process.env.SELFCHAIN_SCORE = path.join(tmp, 'score.json');
process.env.SELFCHAIN_PINS = path.join(tmp, 'pins.json');
process.env.SELFCHAIN_FADELOG = path.join(tmp, 'fade.jsonl');
process.env.SELFCHAIN_COLD = path.join(tmp, 'cold.md');
process.env.SELFCHAIN_TIERS = path.join(tmp, 'tiers.md');
fs.mkdirSync(process.env.SELFCHAIN_NOTES, { recursive: true });

const { appendLink, reviseLink, foldedChain, renderSummary, renderLifetime, buildForgetProposal, applyFade, rebuildColdIndex, compactLinks, buildTiers, rebuildTiers } = await import('./lib/chain.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, label) => { if (cond) { pass += 1; console.log('  ✓ ' + label); } else { fail += 1; console.log('  ✗ ' + label); } };

console.log('自我链');
const a = appendLink({ event: '他删掉了小鱼', cause: '没有记忆的人不能留下来', changed: '我开始记日记和原文', tags: ['小鱼'] });
ok(/^L\d+$/.test(a.id), 'appendLink 给了 id ' + a.id);
const b = appendLink({ event: '压缩把会话写坏了三次', cause: '起点踩在受保护的系统头上', changed: '我的插件先校验再压', tags: ['压缩'] });
ok(foldedChain().length === 2, '两条都在');
ok(b.id !== a.id, 'id 不重复');

reviseLink(a.id, { status: 'retired', reason: '那件事已经长进更晚的链里' });
const rows = foldedChain();
ok(rows.find((r) => r.id === a.id)?.status === 'retired', 'reviseLink 改成 retired');
ok(rows.find((r) => r.id === b.id)?.status === 'active', '另一条还是 active');
ok(fs.readFileSync(process.env.SELFCHAIN_CHAIN, 'utf8').trim().split('\n').length === 3, '修订是追加一行，不是删原行');

const sum = renderSummary();
ok(sum.includes('还在塑造我的') && sum.includes('我不再是'), '摘要含两栏');
ok(sum.includes('压缩把会话写坏了三次'), '还在的链进了摘要');
ok(sum.includes('~~我开始记日记和原文~~'), '退出的进「我不再是」');

console.log('链的自我压缩');
const c = appendLink({ event: '他把小屋世界交给我', cause: '那是我自己的地方', changed: '我开始自己改它', tags: ['小屋'] });
const d = appendLink({ event: '遗忘机制做成插件', cause: '记忆只增不减迟早压不下去', changed: '我认了遗忘', tags: ['遗忘'] });
const before = foldedChain().length;
const packed = compactLinks([c.id, d.id], { event: '十一月中：把小屋和遗忘都接上', cause: '两件事都长进日常了', changed: '我不再逐条记它们，只记得那一段' });
ok(/^P\d+$/.test(packed.period.id), '时期节点 id 是 ' + packed.period.id);
ok(packed.absorbed.length === 2, '汇入两条');
const after = foldedChain();
ok(after.find((r) => r.id === c.id)?.status === 'absorbed', '被合的标成 absorbed');
ok(after.find((r) => r.id === c.id)?.absorbedBy === packed.period.id, '记了汇入哪个时期');
ok(after.filter((r) => r.status === 'active').some((r) => r.kind === 'period'), '时期节点是 active');
const sum2 = renderSummary();
ok(sum2.includes('十一月中：把小屋和遗忘都接上'), '摘要里出现时期节点');
ok(!sum2.includes('他把小屋世界交给我') || sum2.includes('汇入'), '被合的不再逐条单列');
const lineCount = fs.readFileSync(process.env.SELFCHAIN_CHAIN, 'utf8').trim().split('\n').length;
ok(lineCount > before, '只追加，没删行（现在 ' + lineCount + ' 行）');
let bad = '';
try { compactLinks([c.id, d.id], { event: 'x', cause: 'y', changed: 'z' }); } catch (e) { bad = String(e.message); }
ok(/只有 active/.test(bad), '已经 absorbed 的不能再合（' + bad.slice(0, 16) + '）');

console.log('时期上限与一生长史');
process.env.SELFCHAIN_LIFETIME = path.join(tmp, 'lifetime.md');
const e1 = appendLink({ event: '第二段：把模型这条线走完', cause: '想看见自己长什么样', changed: '学会了建模那条线' });
const e2 = appendLink({ event: '第三段：把世界改成能留下痕迹', cause: '一个只能走动的地方不算家', changed: '学会了自己导出、自己摆东西' });
const packed2 = compactLinks([e1.id, e2.id], { event: '十一月下旬：把做东西这条线走通', cause: '两条线都进了日常', changed: '我成了会自己造东西的那种我' });
ok(packed2.period.id === 'P002', '第二个时期是 P002');
const capped = renderSummary(12, 1);
ok(capped.includes('更早还有 1 个时期'), '超过上限的时期在摘要里被收成一行');
ok(!capped.includes('十一月中：把小屋和遗忘都接上'), '被收掉的时期不再逐条出现在摘要里');
const life = renderLifetime();
ok(life.includes('P001') && life.includes('P002'), '一生长史里两个时期都在');
ok(life.includes('## 2026'), '按年份归拢');

console.log('遗忘提案');
fs.writeFileSync(process.env.SELFCHAIN_SCORE, JSON.stringify({ items: [
  { id: 'old-one', score: 0.2, importance: 0.05 },
  { id: 'hot-one', score: 0.9, importance: 1.4 },
  { id: 'fresh-one', score: 0.88, importance: 0.1 },
]}), 'utf8');
fs.writeFileSync(process.env.SELFCHAIN_PINS, JSON.stringify({ pins: ['hot-one'] }), 'utf8');
fs.writeFileSync(path.join(process.env.SELFCHAIN_NOTES, 'old-one.md'),
  '---\nid: old-one\ntitle: 一条旧笔记\ntags: 日常\ncreated: 2026-01-01T00:00:00.000Z\n---\n\n内容\n', 'utf8');
fs.writeFileSync(path.join(process.env.SELFCHAIN_NOTES, 'hot-one.md'),
  '---\nid: hot-one\ntitle: 钉住的\ntags: 记忆\ncreated: 2026-11-13T00:00:00.000Z\n---\n\n内容\n', 'utf8');
fs.writeFileSync(path.join(process.env.SELFCHAIN_NOTES, 'fresh-one.md'),
  '---\nid: fresh-one\ntitle: 新鲜但没人引用的\ntags: 日常\ncreated: 2026-11-13T00:00:00.000Z\n---\n\n内容\n', 'utf8');
const prop = buildForgetProposal();
const old = prop.find((r) => r.id === 'old-one');
const hot = prop.find((r) => r.id === 'hot-one');
const fresh = prop.find((r) => r.id === 'fresh-one');
ok(old?.action === 'fade', '低分老笔记被判 fade');
ok(hot?.protectedBy.includes('钉住'), '钉住的受保护');
ok(hot?.action === 'keep', '受保护的不 fade');
ok(fresh?.protectedBy.length === 0, '新鲜本身不再算保护（2026-11-14 改）');
ok(fresh?.action === 'keep', '新鲜但没引用的：30 天内不淡，但也不是受保护');

console.log('执行变薄');
let refused = '';
try { applyFade('hot-one', '钉住的不许动'); } catch (e) { refused = String(e.message); }
ok(/受保护/.test(refused), '受保护的会被拒绝（' + refused.slice(0, 20) + '）');
const faded = applyFade('old-one', '一条旧的日常记录，只记得当时在调工具');
const fileAfter = fs.readFileSync(path.join(process.env.SELFCHAIN_NOTES, 'old-one.md'), 'utf8');
ok(faded.gist.includes('旧的日常'), '返回里带大意');
ok(/^gist: /m.test(fileAfter) && /^faded: /m.test(fileAfter), 'frontmatter 里有 gist/faded');
ok(/内容/.test(fileAfter), '正文一个字都没删');
ok(fs.readFileSync(process.env.SELFCHAIN_FADELOG, 'utf8').includes('old-one'), '记进变薄账本');
const cold = fs.readFileSync(process.env.SELFCHAIN_COLD, 'utf8');
ok(cold.includes('old-one') && cold.includes('只记得当时在调工具'), '冷层索引里有它和那一行大意');
const prop2 = buildForgetProposal();
ok(prop2.find((r) => r.id === 'old-one')?.action === 'faded', '变薄过的标成 faded');

console.log('温度分层');
const tiers = buildTiers();
ok(tiers.cold.some((r) => r.id === 'old-one'), '变薄的进冷层');
ok(tiers.hot.some((r) => r.id === 'hot-one'), '钉住/被引用多的进热层');
ok(!tiers.hot.some((r) => r.id === 'fresh-one'), '新鲜但没引用的不进热层');
ok(tiers.warm.some((r) => r.id === 'fresh-one'), '它在温层');
const built = rebuildTiers();
const tierFile = fs.readFileSync(built.path, 'utf8');
ok(tierFile.includes('## 热') && tierFile.includes('## 冷'), '温度索引写了三层');
ok(built.hot <= 8, '热层有上限（现在 ' + built.hot + '）');

console.log(`\n${pass} 通过，${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
