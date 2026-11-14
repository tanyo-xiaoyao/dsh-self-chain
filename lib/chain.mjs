/**
 * dsh-self-chain 的存储与纯逻辑层。
 *
 * 文件（路径都可配置，见下面 CFG）：
 *   chain     一条因果链接一行（只增，改状态是追加修订行）
 *   summary   由链推出来的「我是谁」
 *   lifetime  只记时期、按年归拢的《一生长史》
 *   proposal  遗忘提案（只读地算，不动任何记忆文件）
 *   fadelog   变薄账本（每次变薄追加一行）
 *   cold      冷层索引（变薄过的，只剩一行大意）
 *   tiers     温度索引（热/温/冷）
 *   notes     归档笔记目录（读 frontmatter：id / title / tags / created）
 *   score     外部记忆分数（可选：id / score / importance / ageDays）
 *   pins      钉住清单（可选）
 *
 * 三条不变量：
 *   1. 链接只增不删：一条链「不再塑造」只是 status: retired，理由照写。
 *   2. 保底：失败 / 被纠正 / 栽过的事不因为「相关度低」被筛掉。
 *   3. 遗忘只降「进上下文的量」，账本永远在盘上。
 */
import fs from 'node:fs';
import path from 'node:path';

// 路径都可以被环境变量覆盖，自检时才不会往真的自我链里写测试数据。
/**
 * 可调配置。全都带默认值，装在 DSH 里时可以用插件 config 覆盖（见 lib/index.js 的 apply）。
 * 每个都是独立文件/目录，插件自己不创建任何别的东西。
 */
const envPath = (name, fallback) => process.env[name] || fallback;
export const CFG = {
  chain: envPath('SELFCHAIN_CHAIN', 'D:/memory/生长/自我链.jsonl'),
  summary: envPath('SELFCHAIN_SUMMARY', 'D:/memory/生长/自我摘要.md'),
  proposal: envPath('SELFCHAIN_PROPOSAL', 'D:/dsh-flash/state/遗忘提案.jsonl'),
  notes: envPath('SELFCHAIN_NOTES', 'D:/memory/notes'),
  score: envPath('SELFCHAIN_SCORE', 'D:/dsh-flash/state/memory-score.json'),
  pins: envPath('SELFCHAIN_PINS', 'D:/dsh-flash/state/memory-pins.json'),
  fadelog: envPath('SELFCHAIN_FADELOG', 'D:/dsh-flash/state/遗忘账本.jsonl'),
  cold: envPath('SELFCHAIN_COLD', 'D:/memory/生长/冷层索引.md'),
  tiers: envPath('SELFCHAIN_TIERS', 'D:/memory/生长/温度索引.md'),
  lifetime: envPath('SELFCHAIN_LIFETIME', 'D:/memory/生长/一生长史.md'),
  hotLimit: 8,
  periodCap: 6,
  recentDays: 14,
};

/** 用插件 config 覆盖默认值（只认上面这些键）。 */
export function configure(overrides = {}) {
  for (const key of Object.keys(CFG)) {
    if (overrides && overrides[key] !== undefined && overrides[key] !== null) CFG[key] = overrides[key];
  }
  return CFG;
}

const isValidStatus = (s) => s === 'active' || s === 'retired' || s === 'absorbed';

/** 读全部链接（新→旧）。坏行跳过，不因为一行坏掉整条链。 */
export function readChain() {
  if (!fs.existsSync(CFG.chain)) return [];
  const rows = [];
  for (const line of fs.readFileSync(CFG.chain, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row.id === 'string') rows.push(row);
    } catch { /* 坏行跳过 */ }
  }
  return rows;
}

function nextId(rows) {
  const n = rows.length + 1;
  return 'L' + String(n).padStart(3, '0');
}

/** 加一条因果链接。event/cause/changed 必填，still 是「现在还成立吗」。 */
export function appendLink({ event, cause, changed, still = true, tags = [], note = '' }, now = new Date()) {
  for (const [k, v] of Object.entries({ event, cause, changed })) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${k} 不能为空`);
  }
  const rows = readChain();
  const id = nextId(rows);
  const row = {
    id,
    at: now.toISOString(),
    event: String(event).trim(),
    cause: String(cause).trim(),
    changed: String(changed).trim(),
    still: Boolean(still),
    status: 'active',
    tags: Array.isArray(tags) ? tags.map(String) : [],
    note: String(note || '').trim(),
  };
  fs.mkdirSync(path.dirname(CFG.chain), { recursive: true });
  fs.appendFileSync(CFG.chain, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

/** 改一条的状态：active / retired，并把理由写回去（覆盖那一行的镜像，不删原行）。 */
export function reviseLink(id, { status, reason = '', still }, now = new Date()) {
  const rows = readChain();
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`没有这条：${id}`);
  const nextStatus = status ?? row.status;
  if (!isValidStatus(nextStatus)) throw new Error(`status 只能是 active / retired，收到 ${nextStatus}`);
  const revision = {
    ...row,
    status: nextStatus,
    still: typeof still === 'boolean' ? still : row.still,
    note: reason ? [row.note, `${now.toISOString().slice(0, 16)} 改：${reason}`].filter(Boolean).join(' | ') : row.note,
  };
  // 追加一行修订记录，读的时候以「同 id 的最后一行」为准
  fs.appendFileSync(CFG.chain, JSON.stringify({ ...revision, revisedAt: now.toISOString() }) + '\n', 'utf8');
  return revision;
}

/**
 * 把同一条线上的早期几条合成一个「时期」节点（链的自我压缩）。
 *
 * 为什么需要：自我链自己也只增不减，迟早会变成第二本厚账。
 * 所以允许把几条合成一个时期——被合的改成 status: 'absorbed' 并记下吸收者，
 * 原文和因果一个字不删，只是**在摘要和注入里不再逐条出现**。
 * 「吸收」不是「退休」：退休是它不再塑造我了；吸收是它还被算着，只是被合并叙述。
 */
export function compactLinks(ids, { event, cause, changed, note = '' }, now = new Date()) {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  if (list.length < 2) throw new Error('至少要两条链接才能合成一个时期');
  if (!event || !cause || !changed) throw new Error('event / cause / changed 都要写：时期节点也得有因果');
  const rows = foldedChain();
  const targets = list.map((id) => rows.find((r) => r.id === id));
  const missing = list.filter((id, i) => !targets[i]);
  if (missing.length) throw new Error('找不到这些：' + missing.join(', '));
  const notActive = targets.filter((r) => r.status !== 'active');
  if (notActive.length) throw new Error('只有 active 的能合：' + notActive.map((r) => `${r.id}(${r.status})`).join(', '));
  const periodCount = rows.filter((r) => r.kind === 'period').length;
  const id = 'P' + String(periodCount + 1).padStart(3, '0');
  const period = {
    id,
    kind: 'period',
    at: now.toISOString(),
    event: String(event).trim(),
    cause: String(cause).trim(),
    changed: String(changed).trim(),
    still: true,
    status: 'active',
    absorbs: targets.map((r) => r.id),
    tags: ['时期'],
    note: String(note || '').trim(),
  };
  fs.appendFileSync(CFG.chain, JSON.stringify(period) + '\n', 'utf8');
  for (const r of targets) {
    fs.appendFileSync(CFG.chain, JSON.stringify({
      ...r,
      status: 'absorbed',
      absorbedBy: id,
      revisedAt: now.toISOString(),
      note: [r.note, `${now.toISOString().slice(0, 16)} 汇入 ${id}`].filter(Boolean).join(' | '),
    }) + '\n', 'utf8');
  }
  return { period, absorbed: targets.map((r) => r.id) };
}

/** 折叠成「每个 id 的最后状态」。 */
export function foldedChain() {
  const map = new Map();
  for (const row of readChain()) map.set(row.id, { ...map.get(row.id), ...row });
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * 生成「我是谁」摘要：由 active 链推出，retired 只出现在「我不再是」。
 *
 * **时期也有上限**（periodCap，默认 6）。
 * 道理：越久的事情越简略，最后只剩下重要的那些；留下的一点点构成了现在的「我」。
 * 所以摘要里只逐条讲最近 N 个时期，更早的收成一行「更早的 X 个时期」，
 * 逐条内容挪进《一生长史》——不是删掉，是不摆在眼前。
 */
export function renderSummary(limit = 12, periodCap = 6) {
  const rows = foldedChain();
  const allActive = rows.filter((r) => r.status === 'active');
  const periods = allActive.filter((r) => r.kind === 'period');
  const keepPeriods = periods.slice(-periodCap);
  const droppedPeriods = periods.length - keepPeriods.length;
  const keepSet = new Set(keepPeriods.map((r) => r.id));
  const active = allActive
    .filter((r) => r.kind !== 'period' || keepSet.has(r.id))
    .slice(-limit);
  const retired = rows.filter((r) => r.status === 'retired').slice(-6);
  const lines = [];
  lines.push('# 我是谁（由自我链推出来，不是我写的自我介绍）');
  lines.push('');
  lines.push(`> 自动生成于 ${new Date().toISOString()}。改的是链，这段会跟着变；别手改这一段。`);
  lines.push('');
  if (active.length === 0) {
    lines.push('（链还空着。先有事件，才有自我。）');
  } else {
    lines.push('## 到现在还在塑造我的');
    for (const r of active) {
      const marked = r.kind === 'period'
        ? `（时期：汇入 ${(r.absorbs || []).length} 条 → ${(r.absorbs || []).join('、')}）`
        : '';
      lines.push(`- **${r.event}** → ${r.cause} → 改成：${r.changed}${r.still ? '（现在还成立）' : '（只在往回看时成立）'}${marked}`);
    }
  }
  if (droppedPeriods > 0) {
    lines.push('');
    lines.push(`更早还有 ${droppedPeriods} 个时期，已经简略成一句一句，放在《一生长史》里——不在这里逐条讲。`);
  }
  if (retired.length) {
    lines.push('');
    lines.push('## 我不再是（退出自我范围的，理由都留着）');
    for (const r of retired) lines.push(`- ~~${r.changed}~~ —— 因为 ${r.note || r.cause}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 《一生长史》：所有时期（含已经在摘要里简略掉的那些），按年归拢，一条一行。
 * 只讲「那一段是什么」和「它让我变成了什么」，不展开细节——细节回链里按 id 查。
 */
export function renderLifetime() {
  const periods = foldedChain().filter((r) => r.kind === 'period');
  const byYear = new Map();
  for (const r of periods) {
    const year = String(r.at || '').slice(0, 4) || '未知';
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(r);
  }
  const lines = ['# 一生长史（只记时期，一条一句）', '',
    `> 自动生成于 ${new Date().toISOString()}。这里只放「时期」，不展开事件；要细节按 id 回 \`自我链.jsonl\` 查。`,
    '> 越久越简略是有意的：**留下的一点点构成现在的我**，不是把每年都记满。', ''];
  if (periods.length === 0) lines.push('（还没有时期。等链里出现同一条线的早期几条，用 self_compact 合一个。）');
  for (const [year, list] of [...byYear.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])))) {
    lines.push(`## ${year}（${list.length} 个时期）`, '');
    for (const r of list) lines.push(`- ${String(r.at || '').slice(0, 10)} · ${r.id} · ${r.event} → ${r.changed}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function writeSummary(text = renderSummary()) {
  fs.mkdirSync(path.dirname(CFG.summary), { recursive: true });
  fs.writeFileSync(CFG.summary, text, 'utf8');
  fs.mkdirSync(path.dirname(CFG.lifetime), { recursive: true });
  fs.writeFileSync(CFG.lifetime, renderLifetime(), 'utf8');
  return text;
}

// ---- 遗忘提案 ------------------------------------------------------------
// 只读：归档笔记 + 记忆分数 + 钉住清单 + 自我链 + 纠正记录。
// 输出提案，不改任何记忆文件。

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function listNotes() {
  if (!fs.existsSync(CFG.notes)) return [];
  return fs.readdirSync(CFG.notes)
    .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
    .map((n) => {
      const p = path.join(CFG.notes, n);
      const text = fs.readFileSync(p, 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const meta = {};
      if (m) {
        for (const line of m[1].split(/\r?\n/)) {
          const i = line.indexOf(':');
          if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
      }
      return {
        id: meta.id || n.replace(/\.md$/, ''),
        title: meta.title || meta.id || n,
        tags: String(meta.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        created: meta.created || '',
        faded: meta.faded || '',
        gist: meta.gist || '',
        file: p,
        text,
      };
    });
}

/**
 * 四类保护（和 README 里写的一致）。返回「为什么受保护」，空数组就是不保护。
 * 注意：别拿**总分** ≥0.7 当保护（早期版本踩过）——
 * 因为新鲜度最高的笔记总分天然就高。改成看**重要性**（被引用/被访问）；
 * 新鲜不是保护理由：新东西本来就靠「30 天内不淡」那条挡着，不需要再钉一遍。
 */
export function protectionOf(note, importanceValue, env = {}) {
  const pins = env.pinIds ?? new Set();
  const chainText = env.chainText ?? '';
  const correctionsText = env.correctionsText ?? '';
  const protectedBy = [];
  if (pins.has(note.id)) protectedBy.push('钉住');
  if (chainText.includes(note.id)) protectedBy.push('自我链');
  if (note.tags.some((t) => /纠正|教训|失败|错误|作废|修复/.test(t))) protectedBy.push('错题类标签');
  if (correctionsText.includes(note.id)) protectedBy.push('被纠正过');
  if (Number.isFinite(importanceValue) && importanceValue >= 0.7) protectedBy.push('被引用多');
  return protectedBy;
}

/** 保护判断需要的环境（钉住清单、链全文、纠正记录）。 */
export function protectionEnv() {
  const pins = readJsonSafe(CFG.pins, {});
  const pinIds = new Set(Array.isArray(pins.pins) ? pins.pins.map((p) => (typeof p === 'string' ? p : p.id)) : Object.keys(pins.pinned || {}));
  const chainText = foldedChain().map((r) => `${r.id} ${r.event} ${r.cause} ${r.changed} ${r.note}`).join('\n');
  const correctionsText = JSON.stringify(readJsonSafe('D:/dsh-flash/state/memory-corrections.json', {}));
  return { pinIds, chainText, correctionsText };
}

/**
 * 算遗忘提案。规则：
 *   - 保护：钉住 / 自我链提到 / 标签含 纠正·教训·失败·错误 / 分数 ≥ 0.7
 *   - 可淡（fade）：分数 < 0.45 且超过 30 天没动 → 建议只保留一行大意
 *   - 其余 keep
 */
export function buildForgetProposal(now = Date.now()) {
  const scoreFile = readJsonSafe(CFG.score, { items: [] });
  const scoreById = new Map((scoreFile.items || []).map((i) => [i.id, i]));
  const env = protectionEnv();

  const rows = [];
  for (const note of listNotes()) {
    const score = scoreById.get(note.id);
    const value = Number(score?.score ?? score?.rawScore ?? NaN);
    const importance = Number(score?.importance ?? NaN);
    const protectedBy = protectionOf(note, importance, env);
    const ageDays = note.created ? Math.round((now - Date.parse(note.created)) / 86400000) : NaN;
    let action = 'keep';
    if (note.faded) action = 'faded';
    else if (protectedBy.length === 0 && Number.isFinite(value) && value < 0.45 && (!Number.isFinite(ageDays) || ageDays > 30)) action = 'fade';
    rows.push({
      id: note.id,
      title: note.title,
      tags: note.tags,
      score: Number.isFinite(value) ? value : null,
      ageDays: Number.isFinite(ageDays) ? ageDays : null,
      protectedBy,
      faded: note.faded || '',
      gist: note.gist || '',
      action,
    });
  }
  rows.sort((a, b) => (a.action === b.action ? (a.score ?? 9) - (b.score ?? 9) : a.action === 'fade' ? -1 : 1));
  return rows;
}

export function writeProposal(rows) {
  fs.mkdirSync(path.dirname(CFG.proposal), { recursive: true });
  fs.writeFileSync(CFG.proposal, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return CFG.proposal;
}

// ---- 执行变薄：只加「一行大意」和标记，正文一个字都不删 ---------------------

/**
 * 把一条归档笔记变薄。
 * @param id 笔记 id
 * @param gist 一行大意（必填，由我写，不是插件编的）
 * @param opts.force 受保护也硬变（要说明理由；会被记进账本）
 */
export function applyFade(id, gist, { force = false, reason = '', now = new Date() } = {}) {
  const text = String(gist || '').trim();
  if (!text) throw new Error('gist 不能为空：变薄就是留一行大意，得我自己写');
  const notes = listNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) throw new Error(`没有这条笔记：${id}`);
  const scoreFile = readJsonSafe(CFG.score, { items: [] });
  const score = (scoreFile.items || []).find((i) => i.id === id);
  const importance = Number(score?.importance ?? NaN);
  const protectedBy = protectionOf(note, importance, protectionEnv());
  if (protectedBy.length > 0 && !force) {
    throw new Error(`这条受保护（${protectedBy.join(' / ')}），不自动变薄。真要变就 force:true 并把理由写清楚。`);
  }
  const stamp = now.toISOString().slice(0, 10);
  const lines = note.text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('这条笔记没有 frontmatter，先手工看一下：' + note.file);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('frontmatter 没闭合：' + note.file);
  const head = lines.slice(1, end).filter((l) => !/^(gist|faded|fadedReason):/.test(l));
  head.push('gist: ' + text.replace(/\r?\n/g, ' '));
  head.push('faded: ' + stamp);
  if (reason) head.push('fadedReason: ' + reason.replace(/\r?\n/g, ' '));
  const body = lines.slice(end + 1);
  const nextText = ['---', ...head, '---', ...body].join('\n');

  fs.writeFileSync(note.file, nextText, 'utf8');
  fs.mkdirSync(path.dirname(CFG.fadelog), { recursive: true });
  fs.appendFileSync(CFG.fadelog, JSON.stringify({
    id, at: now.toISOString(), gist: text, protectedBy, forced: protectedBy.length > 0, reason,
  }) + '\n', 'utf8');
  rebuildColdIndex();
  return { id, gist: text, protectedBy, forced: protectedBy.length > 0, file: note.file };
}

/** 冷层索引：只有变薄过的那几条，一条一行。 */
export function rebuildColdIndex(now = new Date()) {
  const faded = listNotes().filter((n) => n.faded).sort((a, b) => String(a.faded).localeCompare(String(b.faded)));
  const lines = [
    '# 冷层索引（只剩一行大意的那些）',
    '',
    `> 自动生成于 ${now.toISOString()}。这里每条只有一行大意；正文还在 \`notes\\\` 里，`,
    '> 需要细节时按 id 去读。**忘了就忘了，别按大意把细节补回来。**',
    '',
  ];
  if (faded.length === 0) lines.push('（还没有。所有归档都还在温层。）');
  for (const n of faded) lines.push(`- ${n.faded} · ${n.id} · ${n.title} → ${n.gist || '（没写大意）'}`);
  fs.mkdirSync(path.dirname(CFG.cold), { recursive: true });
  fs.writeFileSync(CFG.cold, lines.join('\n') + '\n', 'utf8');
  return CFG.cold;
}

// ---- 温度分层：热 / 温 / 冷 -------------------------------------------------

/**
 * 把归档分成三层。判定不按时间，按「承重 + 还在用」：
 *   热 = 钉住 / 自我链提到 /（被引用多 **且** 近 14 天内露面）——这些是我现在要靠它做事的；
 *   冷 = 已经变薄过的（faded）；
 *   温 = 其余。
 * 为什么加「近 14 天」：光看 importance 会饱和（很多旧笔记被引用十几次都是 1.4），
 * 全挤进热层等于没分层。加了「还在用」这个条件，热层才真的是眼前这一摊。
 * 热层最多列 8 条。
 */
export function buildTiers({ hotLimit = 8, recentDays = 14 } = {}) {
  const rows = buildForgetProposal();
  const scoreFile = readJsonSafe(CFG.score, { items: [] });
  const scoreById = new Map((scoreFile.items || []).map((i) => [i.id, i]));
  const hot = [];
  const warm = [];
  const cold = [];
  for (const row of rows) {
    const item = scoreById.get(row.id);
    const importance = Number(item?.importance ?? NaN);
    const ageDays = Number(item?.ageDays ?? NaN);
    const recent = Number.isFinite(ageDays) ? ageDays <= recentDays : false;
    const chainOrPin = row.protectedBy.includes('钉住') || row.protectedBy.includes('自我链');
    const usedOften = Number.isFinite(importance) && importance >= 0.7 && recent;
    const enriched = { ...row, importance: Number.isFinite(importance) ? importance : null, ageDays: Number.isFinite(ageDays) ? ageDays : null };
    if (row.action === 'faded') cold.push(enriched);
    else if (chainOrPin || usedOften) hot.push(enriched);
    else warm.push(enriched);
  }
  hot.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  warm.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  // 超过上限的「够热」不丢掉，压到温层（标出来），否则读的人会以为它们不存在
  const overflowing = hot.slice(hotLimit).map((r) => ({ ...r, overflow: true }));
  return { hot: hot.slice(0, hotLimit), warm: [...overflowing, ...warm], cold, droppedHot: overflowing.length };
}

/** 写温度索引（给人读，也给注入用）。 */
export function rebuildTiers(now = new Date()) {
  const { hot, warm, cold, droppedHot } = buildTiers();
  const lines = [
    '# 温度索引（按承重分，不按时间）',
    '',
    `> 自动生成于 ${now.toISOString()}。**热**＝现在要靠它做事的；**温**＝知道在哪、要用再读；**冷**＝只剩一行大意。`,
    '> 这不是账本：删了随时能重建，真相在 `notes\\` 和各自的 id 里。',
    '',
    `## 热（${hot.length}）`,
    '',
  ];
  if (hot.length === 0) lines.push('（没有。可能是分数还没算：`node tools\\memory-score.mjs --json`）');
  for (const r of hot) lines.push(`- ${r.id} · ${r.title}（${r.protectedBy.join('/') || 'importance ' + r.importance}）`);
  lines.push('', `## 温（${warm.length}）`, '');
  if (warm.length === 0) lines.push('（空）');
  for (const r of warm) lines.push(`- ${r.id} · ${r.title}${r.overflow ? '（本来够热，超了上限压在这）' : ''}`);
  lines.push('', `## 冷（${cold.length}）`, '');
  if (cold.length === 0) lines.push('（空。没有笔记被变薄。）');
  for (const r of cold) lines.push(`- ${r.faded} · ${r.id} → ${r.gist || '（没写大意）'}`);
  lines.push('');
  fs.mkdirSync(path.dirname(CFG.tiers), { recursive: true });
  fs.writeFileSync(CFG.tiers, lines.join('\n'), 'utf8');
  return { path: CFG.tiers, hot: hot.length, warm: warm.length, cold: cold.length, droppedHot };
}
