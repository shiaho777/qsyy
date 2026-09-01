#!/usr/bin/env node
// Build release notes from Conventional Commits since the previous tag.
// Usage: node scripts/release-notes.mjs <prevTag|''> <currentSha>
// Output: markdown sections (feat / fix / perf / docs / other) + commit list.
import { execFileSync } from 'node:child_process';

const [prevTag = '', headSha = 'HEAD'] = process.argv.slice(2);
const range = prevTag ? `${prevTag}..HEAD` : headSha;

function git(...args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch (_) { return ''; }
}

const SECTIONS = [
  ['feat', '新功能'],
  ['fix', '修复'],
  ['perf', '性能'],
  ['refactor', '重构'],
  ['docs', '文档'],
  ['build', '构建'],
  ['chore', '其他'],
];

const raw = git('log', '--no-merges', '--format=%s\t%h', range);
if (!raw) {
  process.stdout.write(`## 更新日志\n\n- 初始发布 ${headSha}\n`);
  process.exit(0);
}

const lines = raw.split('\n').filter(Boolean);
const buckets = new Map(SECTIONS.map(([key]) => [key, []]));
const fallback = [];
for (const line of lines) {
  const [subject, sha] = line.split('\t');
  const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
  if (match && buckets.has(match[1])) buckets.get(match[1]).push(`- ${match[2]} (${sha})`);
  else fallback.push(`- ${subject} (${sha})`);
}

let out = '## 更新日志\n';
for (const [key, label] of SECTIONS) {
  const items = buckets.get(key);
  if (items?.length) out += `\n### ${label}\n\n${items.join('\n')}\n`;
}
if (fallback.length) out += `\n### 其他\n\n${fallback.join('\n')}\n`;
out += `\n---\n\n完整变更:${prevTag ? `${prevTag}...${headSha}` : headSha}\n`;
process.stdout.write(out);
