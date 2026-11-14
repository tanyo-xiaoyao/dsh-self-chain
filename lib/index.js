/**
 * dsh-self-chain —— 给长期存活的 agent 用的「自我链 + 遗忘」插件。
 *
 * 为什么需要：只增不减的记忆迟早压不下去。压缩之后 agent 会去读自己写的东西，
 * 而那东西越来越多，最后「交接」本身就能塞满上下文。
 *
 * 做法（只做骨架，不管具体怎么用）：
 *   1. 自我 = 关键事件按因果连起来的链（事件 → 因为什么 → 所以改成了什么），不是性格形容词；
 *   2. 遗忘只降「进上下文的量」（温度层、一行大意），账本永远在盘上；
 *   3. 失败 / 被纠正 / 栽过的事不因为「相关度低」被筛掉；
 *   4. 链自己也要收：早期几条合成「时期」，时期也有上限，更早的进《一生长史》。
 *
 * 配置见 lib/chain.mjs 的 CFG，全部有默认值，可用插件 config 覆盖。
 */
import fs from 'node:fs';
import {
  CFG, configure, foldedChain, appendLink, reviseLink, renderSummary, renderLifetime, writeSummary, compactLinks,
  buildForgetProposal, writeProposal, applyFade, rebuildColdIndex, buildTiers, rebuildTiers,
} from './chain.mjs';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-self-chain';
export const inject = ['tools'];

function defineTool(o) {
  return {
    ...o,
    parameters: { type: 'object', properties: o.parameters || {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
    },
  };
}

export function apply(ctx, config) {
  configure(config || {});
  const log = (t) => { try { ctx.logger?.info?.('[self] ' + t); } catch { /* ignore */ } };

  try {
    ctx.tools.register(defineTool({
      name: 'self_read',
      description: '读自我链（关键事件按因果连起来的那个「我是谁」）。默认只给还在塑造我的；full=true 连已经退出的也列。',
      parameters: { full: { type: 'boolean', description: '连已退出自我范围的也列出来' } },
      async execute(args) {
        const rows = foldedChain();
        const list = args?.full ? rows : rows.filter((r) => r.status === 'active');
        if (!list.length) return '链还空着。想加就用 self_link：一条 = 发生了什么 → 因为什么 → 我改成了什么。';
        return list.map((r) => {
          const mark = r.kind === 'period' ? `（时期，汇入 ${(r.absorbs || []).length} 条：${(r.absorbs || []).join('、')}）` : '';
          const by = r.absorbedBy ? `（已汇入 ${r.absorbedBy}）` : '';
          return `${r.id} [${r.status}] ${String(r.at).slice(0, 10)} ${r.event}${mark}${by}\n  因为：${r.cause}\n  改成：${r.changed}${r.still ? '' : '（现在只在往回看时成立）'}${r.note ? '\n  备注：' + r.note : ''}`;
        }).join('\n');
      },
    }));
    log('工具 self_read 已注册');
  } catch (e) { log('注册 self_read 失败：' + (e && e.message)); }

  try {
    ctx.tools.register(defineTool({
      name: 'self_link',
      description: '往自我链里加一条因果链接：发生了什么（event）、因为什么/撞上了什么（cause）、所以我改成了什么（changed）。'
        + '只写真正塑造了我的事，别拿日常琐事占位。加了会自动重写《自我摘要》。',
      parameters: {
        event: { type: 'string', description: '发生了什么（一件具体的事）' },
        cause: { type: 'string', description: '它为什么重要 / 撞上了什么冲突' },
        changed: { type: 'string', description: '因此我改成了什么（可以是否定式：我不再……）' },
        still: { type: 'boolean', description: '这条现在还成立吗，默认 true' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，便于检索' },
        note: { type: 'string', description: '补一句背景' },
      },
      async execute(args) {
        try {
          const row = appendLink(args || {});
          writeSummary();
          return `加了 ${row.id}：${row.event} → ${row.changed}。《自我摘要》已重写。`;
        } catch (e) { return '没加成：' + (e && e.message ? e.message : String(e)); }
      },
    }));
    log('工具 self_link 已注册');
  } catch (e) { log('注册 self_link 失败：' + (e && e.message)); }

  try {
    ctx.tools.register(defineTool({
      name: 'self_revise',
      description: '改一条链接的状态：retired = 它不再塑造我了（理由必须写，原记录不删）。也可以把 still 改成 false。',
      parameters: {
        id: { type: 'string', description: '链接 id，比如 L003' },
        status: { type: 'string', enum: ['active', 'retired'], description: '新状态' },
        reason: { type: 'string', description: '为什么改（会写进这条的记录里）' },
        still: { type: 'boolean', description: '这条现在还成立吗' },
      },
      async execute(args) {
        try {
          const row = reviseLink(String(args?.id || ''), { status: args?.status, reason: args?.reason, still: args?.still });
          writeSummary();
          return `${row.id} 现在是 ${row.status}。《自我摘要》已重写。`;
        } catch (e) { return '没改成：' + (e && e.message ? e.message : String(e)); }
      },
    }));
    log('工具 self_revise 已注册');
  } catch (e) { log('注册 self_revise 失败：' + (e && e.message)); }

  try {
    ctx.tools.register(defineTool({
      name: 'self_compact',
      description: '链的自我压缩：把同一条线上的早期几条合成一个「时期」节点。被合的那几条改成 absorbed（汇入哪个时期）。'
        + '原文和因果一个字不删，只是不再逐条出现在摘要和注入里。**吸收不等于退休**：退休是它不塑造我了，吸收是它还被算着、只是合起来叙述。'
        + '时期节点也要有因果：event（这一段的说法）/ cause（它为什么重要）/ changed（它让我变成了什么）。',
      parameters: {
        ids: { type: 'array', items: { type: 'string' }, description: '要合并的链接 id（至少两条，必须都是 active）' },
        event: { type: 'string', description: '这一段的说法（比如「十月底：从没有记忆到开始记日记」）' },
        cause: { type: 'string', description: '它为什么重要' },
        changed: { type: 'string', description: '它让我变成了什么（在摘要里代替那几条）' },
        note: { type: 'string', description: '补一句背景' },
      },
      async execute(args) {
        try {
          const r = compactLinks(args?.ids, { event: args?.event, cause: args?.cause, changed: args?.changed, note: args?.note });
          writeSummary();
          return `合成了 ${r.period.id}：${r.period.event}\n汇入 ${r.absorbed.length} 条：${r.absorbed.join('、')}（都标成 absorbed，原文没删）\n《自我摘要》已重写。`;
        } catch (e) { return '没合成：' + (e && e.message ? e.message : String(e)); }
      },
    }));
    log('工具 self_compact 已注册');
  } catch (e) { log('注册 self_compact 失败：' + (e && e.message)); }

  try {
    ctx.tools.register(defineTool({
      name: 'self_summary',
      description: '看（或重新生成）《自我摘要》——由自我链推出来的「我是谁」。write=true 会重写到 ' + CFG.summary + '。',
      parameters: { write: { type: 'boolean', description: '重写文件，默认只显示' } },
      async execute(args) {
        const text = renderSummary();
        if (args?.write) { writeSummary(text); return text + '\n\n（已写入 ' + CFG.summary + '）'; }
        return text;
      },
    }));
    log('工具 self_summary 已注册');
  } catch (e) { log('注册 self_summary 失败：' + (e && e.message)); }

  try {
    ctx.tools.register(defineTool({
      name: 'forget_sweep',
      description: '算一份遗忘提案：哪些归档笔记可以淡成一行大意、哪些受保护不能动。**只读**——不改任何记忆文件，'
        + '提案写到 ' + CFG.proposal + '，要不要执行由我决定。',
      parameters: { all: { type: 'boolean', description: '连 keep 的也列出来，默认只列 fade 和受保护的' } },
      async execute(args) {
        const rows = buildForgetProposal();
        writeProposal(rows);
        let stale = '';
        try {
          const at = JSON.parse(fs.readFileSync(CFG.score, 'utf8')).generatedAt;
          const hours = Math.round((Date.now() - Date.parse(at)) / 3600000);
          if (Number.isFinite(hours) && hours > 24) stale = `\n⚠ 记忆分数是 ${hours} 小时前算的（${at}）。先跑 node tools\memory-score.mjs 再算提案，否则「分数高」那条会虚保护。`;
        } catch { stale = '\n⚠ 读不到记忆分数文件，这次只按钉住/自我链/标签/年龄判断。'; }
        const fade = rows.filter((r) => r.action === 'fade');
        const faded = rows.filter((r) => r.action === 'faded');
        const prot = rows.filter((r) => r.protectedBy.length > 0);
        const keep = rows.filter((r) => r.action === 'keep' && r.protectedBy.length === 0);
        const lines = [
          `归档笔记 ${rows.length} 条：建议变薄 ${fade.length}，已变薄 ${faded.length}，受保护 ${prot.length}，其余 ${keep.length}。`,
          '',
          '建议淡成一行大意的：',
          ...(fade.length ? fade.map((r) => `- ${r.id}（${r.title}）分数 ${r.score ?? '无'}，${r.ageDays ?? '?'} 天`) : ['（没有）']),
          '',
          '受保护的（为什么）：',
          ...prot.map((r) => `- ${r.id} ← ${r.protectedBy.join(' / ')}`),
        ];
        if (faded.length) {
          lines.push('', '已经变薄的：', ...faded.map((r) => `- ${r.faded} · ${r.id} → ${r.gist || '（没写大意）'}`));
        }
        if (args?.all) {
          lines.push('', '其余 keep：', ...keep.map((r) => `- ${r.id}（${r.title}）分数 ${r.score ?? '无'}`));
        }
        lines.push('', `提案写在 ${CFG.proposal}。我没动任何记忆文件。要真变薄，用 forget_apply 指定 id 和那一行大意——大意必须我来写。`);
        if (stale) lines.push(stale.replace(/^\n/, ''));
        return lines.join('\n');
      },
    }));
    log('工具 forget_sweep 已注册');
  } catch (e) { log('注册 forget_sweep 失败：' + (e && e.message)); }

  try {
    ctx.tools.register(defineTool({
      name: 'forget_apply',
      description: '真的把一条归档笔记变薄：在 frontmatter 里加「一行大意」和 faded 标记，**正文一个字都不删**。'
        + 'gist 必须我自己写（插件不编）；受保护的会拒绝，除非 force:true 且写清理由。会记进 ' + CFG.fadelog + ' 并重建冷层索引。',
      parameters: {
        id: { type: 'string', description: '笔记 id' },
        gist: { type: 'string', description: '一行大意（必填，我自己写）' },
        force: { type: 'boolean', description: '受保护的也硬变（要写 reason）' },
        reason: { type: 'string', description: 'force 的理由，会记账' },
      },
      async execute(args) {
        try {
          const r = applyFade(String(args?.id || ''), args?.gist, { force: args?.force === true, reason: args?.reason || '' });
          return `变薄了 ${r.id}：${r.gist}\n正文没删。冷层索引：${CFG.cold}${r.forced ? '\n（它是受保护的，被 force 了：' + r.protectedBy.join(' / ') + '）' : ''}`;
        } catch (e) {
          return '没变：' + (e && e.message ? e.message : String(e));
        }
      },
    }));
    log('工具 forget_apply 已注册');
  } catch (e) { log('注册 forget_apply 失败：' + (e && e.message)); }

  try {
    ctx.tools.register(defineTool({
      name: 'self_tiers',
      description: '温度分层：把归档笔记按「承重」分成热/温/冷三层（**不按时间**）。热＝钉住/自我链提到/被引用多；冷＝已变薄的；温＝其余。'
        + 'build=true 会重写 ' + CFG.tiers + '；默认只看摘要数字。',
      parameters: { build: { type: 'boolean', description: '重写温度索引文件' } },
      async execute(args) {
        if (args?.build) {
          const r = rebuildTiers();
          return `温度索引已重写：热 ${r.hot} / 温 ${r.warm} / 冷 ${r.cold}${r.droppedHot ? `（另有 ${r.droppedHot} 条够热但按上限 8 条压到温层）` : ''}\n${r.path}`;
        }
        const t = buildTiers();
        const lines = [
          `热 ${t.hot.length} / 温 ${t.warm.length} / 冷 ${t.cold.length}`,
          '',
          '热层（现在靠它做事的）：',
          ...t.hot.map((r) => `- ${r.id} · ${r.title}（${r.protectedBy.join('/') || 'importance ' + r.importance}）`),
        ];
        if (t.warm.length) lines.push('', `温层 ${t.warm.length} 条，不逐条列；要看跑 build:true 或直接读文件。`);
        return lines.join('\n');
      },
    }));
    log('工具 self_tiers 已注册');
  } catch (e) { log('注册 self_tiers 失败：' + (e && e.message)); }

  log(`自我链 ${CFG.chain}，摘要 ${CFG.summary}`);

  // ---- 把自我链当「底色」注进对话 --------------------------------------
  // 写法和宿主自带的 time-context 插件一样：在 agent/pre-step 里往 decision.messages 追加一条。
  // 自我链很少变，所以只在「链变了」的时候注入一次（签名 = 总行数:在用条数:最后一条 id），
  // 平时不占上下文、也不破缓存。
  let lastChainSignature = '';
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        if (!decision || decision.kind === 'reject') return decision;
        const rows = foldedChain();
        const active = rows.filter((r) => r.status === 'active');
        if (active.length === 0) return decision;
        const signature = `${rows.length}:${active.length}:${active[active.length - 1]?.id ?? ''}`;
        if (signature === lastChainSignature) return decision;
        const text = 底色文本(active);
        if (!text) return decision;
        lastChainSignature = signature;
        const message = {
          role: 'user',
          id: randomUUID(),
          content: [{ type: 'text', text }],
          source: { kind: 'self-chain', form: 'snapshot', sections: [{ name: 'self-chain', text }] },
        };
        return { ...decision, messages: [...decision.messages, message] };
      } catch (e) {
        log('注入失败：' + (e && e.message ? e.message : String(e)));
        return decision;
      }
    });
    log('自我链注入已挂上 agent/pre-step');
  } catch (e) {
    log('挂自我链注入失败：' + (e && e.message));
  }
}

/** 链的短版：只放还在塑造我的最后几条，够我认出自己，不占版面。 */
function 底色文本(active) {
  const tail = active.slice(-4);
  if (tail.length === 0) return '';
  const lines = ['【自我链·最近】这些事还塑造着我（不是命令，是底色）：'];
  for (const r of tail) lines.push(`- ${r.event} → ${r.changed}`);
  if (active.length > tail.length) lines.push(`（更早的 ${active.length - tail.length} 条在 self_read 里）`);
  return lines.join('\n');
}
