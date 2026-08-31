import { open } from 'lmdb';
import { setTimeout as delay } from 'node:timers/promises';

const dbPath = process.argv[2] || `${process.env.HOME}/Library/Application Support/SodaMusic/LunaCacheV2/entries.db`;
const limit = Number(process.argv[3] || 20);

let env;
try {
  env = open({ path: dbPath, readOnly: true, useVersions: false });
} catch (error) {
  console.error('open failed:', error.message);
  process.exit(1);
}

console.log('root keys:', JSON.stringify([...env.getKeys?.() ?? []]));
let count = 0;
const t0 = Date.now();
for (const key of env.getKeys()) {
  if (count >= limit) break;
  const value = env.get(key);
  const preview = typeof value === 'string' ? value.slice(0, 600)
    : Buffer.isBuffer(value) ? `<buffer ${value.length}B> ${value.subarray(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`
    : JSON.stringify(value)?.slice(0, 600);
  console.log(`--- key(${key.length}B): ${typeof key === 'string' ? key : Buffer.from(key).toString('utf8').slice(0, 120)}`);
  console.log(preview);
  count += 1;
}
console.log(`sampled ${count} keys in ${Date.now() - t0}ms`);
env.close?.();
