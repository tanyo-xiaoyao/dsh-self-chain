import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfchain-smoke-'));
const env = {
  SELFCHAIN_CHAIN: path.join(tmp, 'chain.jsonl'),
  SELFCHAIN_SUMMARY: path.join(tmp, 'summary.md'),
  SELFCHAIN_LIFETIME: path.join(tmp, 'lifetime.md'),
  SELFCHAIN_PROPOSAL: path.join(tmp, 'proposal.jsonl'),
  SELFCHAIN_FADELOG: path.join(tmp, 'fade.jsonl'),
  SELFCHAIN_COLD: path.join(tmp, 'cold.md'),
  SELFCHAIN_TIERS: path.join(tmp, 'tiers.md'),
  SELFCHAIN_NOTES: path.join(tmp, 'notes'),
  SELFCHAIN_SCORE: path.join(tmp, 'score.json'),
  SELFCHAIN_PINS: path.join(tmp, 'pins.json'),
};
for (const [k, v] of Object.entries(env)) process.env[k] = v;
fs.mkdirSync(env.SELFCHAIN_NOTES, { recursive: true });

const mod = await import(new URL('../lib/index.js', import.meta.url).href);
const tools = {};
const hooks = {};
const ctx = {
  tools: { register: (t) => { tools[t.name] = t; } },
  logger: { info() {} },
  on: (ev, h) => { hooks[ev] = h; },
};

// 用 config 覆盖，验证 configure 真的生效（指向另一个目录）
const alt = path.join(tmp, 'alt');
mod.apply(ctx, { chain: path.join(alt, 'chain.jsonl'), summary: path.join(alt, 'summary.md'), lifetime: path.join(alt, 'lifetime.md') });
console.log('注册的工具:', Object.keys(tools).join(','));

const link = await tools.self_link.execute({ event: '装着它试一下', cause: '要确认 plugin config 生效', changed: '我会把数据写到配置的路径' }, { agent: {} });
console.log('self_link:', link);
console.log('写到配置路径了吗:', fs.existsSync(path.join(alt, 'chain.jsonl')), '| 没写默认路径:', !fs.existsSync(env.SELFCHAIN_CHAIN));

const read = await tools.self_read.execute({}, { agent: {} });
console.log('self_read 第一行:', read.split('\n')[0]);

const sum = await tools.self_summary.execute({ write: true }, { agent: {} });
console.log('摘要写了:', fs.existsSync(path.join(alt, 'summary.md')), '| 生平:', fs.existsSync(path.join(alt, 'lifetime.md')));

const sweep = await tools.forget_sweep.execute({}, { agent: {} });
console.log('forget_sweep 第一行:', sweep.split('\n')[0]);

// 注入钩子：链变了才注入
const handler = hooks['agent/pre-step'];
if (!handler) throw new Error('没挂上 agent/pre-step');
const next = async () => ({ kind: 'continue', messages: [] });
const a = await handler({ agent: {} }, next);
const b = await handler({ agent: {} }, next);
console.log('注入：第一次', a.messages.length, '条，第二次', b.messages.length, '条（应只第一次）');
fs.rmSync(tmp, { recursive: true, force: true });
