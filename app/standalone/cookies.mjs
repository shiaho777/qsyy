// Read the soda client's Chromium Cookies SQLite without depending on a
// sqlite3 binary. macOS ships /usr/bin/sqlite3 so the CLI path works there;
// Windows and the Docker image usually have no sqlite3 on PATH, which made
// a logged-in client look like "未登录".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOSTS = new Set(['.qishui.com', '.bytedance.com']);

let cachedSqlite3 = undefined;
export function findSqlite3Bin() {
  if (cachedSqlite3 !== undefined) return cachedSqlite3;
  const names = process.platform === 'win32'
    ? ['sqlite3.exe', 'sqlite3']
    : ['sqlite3'];
  const dirs = [
    '',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin'),
    'C:\\Program Files\\Git\\usr\\bin',
  ].filter(v => v !== undefined);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? path.join(dir, name) : name;
      try {
        execFileSync(candidate, ['-version'], { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        cachedSqlite3 = candidate;
        return candidate;
      } catch (_) {}
    }
  }
  cachedSqlite3 = '';
  return '';
}

function snapshotDb(dbPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsyy-ck-'));
  const dest = path.join(dir, 'Cookies');
  fs.copyFileSync(dbPath, dest);
  for (const extra of ['-journal', '-wal', '-shm']) {
    const src = dbPath + extra;
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, dest + extra); } catch (_) {}
    }
  }
  return { dir, dest };
}

function formatPairs(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const host = String(row.host_key || '');
    const name = String(row.name || '');
    const value = String(row.value || '');
    if (!HOSTS.has(host) || !name || !value) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(`${name}=${value}`);
  }
  return out.join('; ');
}

function readViaCli(dbPath, bin) {
  const sql = "SELECT host_key, name, value FROM cookies WHERE host_key IN ('.qishui.com','.bytedance.com');";
  const stdout = execFileSync(bin, ['-separator', '\t', dbPath, sql], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [host_key, name, ...rest] = line.split('\t');
    return { host_key, name, value: rest.join('\t') };
  });
  return formatPairs(rows);
}

function readU16(buf, i) { return buf.readUInt16BE(i); }
function readU32(buf, i) { return buf.readUInt32BE(i); }

function readVarint(buf, offset) {
  let n = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset + i >= buf.length) return { value: 0, size: 0 };
    const b = buf[offset + i];
    if (i === 8) {
      n = (n << 8n) | BigInt(b);
      return { value: Number(n), size: 9 };
    }
    n = (n << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) return { value: Number(n), size: i + 1 };
  }
  return { value: 0, size: 0 };
}

function serialSize(type) {
  if (type === 0 || type === 8 || type === 9) return 0;
  if (type === 1) return 1;
  if (type === 2) return 2;
  if (type === 3) return 3;
  if (type === 4) return 4;
  if (type === 5) return 5;
  if (type === 6 || type === 7) return 8;
  if (type >= 12 && type % 2 === 0) return (type - 12) / 2;
  if (type >= 13 && type % 2 === 1) return (type - 13) / 2;
  return 0;
}

function decodeField(buf, offset, type) {
  const size = serialSize(type);
  const slice = buf.subarray(offset, offset + size);
  if (type === 0) return null;
  if (type === 8) return 0;
  if (type === 9) return 1;
  if (type === 1) return slice.readInt8(0);
  if (type === 2) return slice.readInt16BE(0);
  if (type === 3) return (slice[0] << 16) | (slice[1] << 8) | slice[2];
  if (type === 4) return slice.readInt32BE(0);
  if (type === 7) return slice.readDoubleBE(0);
  if (type >= 13 && type % 2 === 1) return slice.toString('utf8');
  if (type >= 12 && type % 2 === 0) return slice;
  return slice;
}

function parseRecord(payload) {
  const header = readVarint(payload, 0);
  if (!header.size) return [];
  const headerEnd = header.value;
  const types = [];
  let i = header.size;
  while (i < headerEnd) {
    const v = readVarint(payload, i);
    if (!v.size) break;
    types.push(v.value);
    i += v.size;
  }
  const fields = [];
  let body = headerEnd;
  for (const type of types) {
    const size = serialSize(type);
    fields.push(decodeField(payload, body, type));
    body += size;
  }
  return fields;
}

function page(buf, pageSize, pageNo) {
  const start = (pageNo - 1) * pageSize;
  return buf.subarray(start, start + pageSize);
}

function localPayloadBytes(usable, payloadSize) {
  const x = usable - 35;
  if (payloadSize <= x) return payloadSize;
  const m = Math.floor(((usable - 12) * 32) / 255) - 23;
  const k = m + ((payloadSize - m) % (usable - 4));
  return k <= x ? k : m;
}

function readOverflow(buf, pageSize, pageNo, need) {
  const chunks = [];
  let left = need;
  let current = pageNo;
  while (current && left > 0) {
    const p = page(buf, pageSize, current);
    if (p.length < 5) break;
    current = readU32(p, 0);
    const take = Math.min(left, p.length - 4);
    chunks.push(p.subarray(4, 4 + take));
    left -= take;
  }
  return chunks;
}

function cellPayload(buf, pageSize, usable, pageBuf, cellAt) {
  const payloadInfo = readVarint(pageBuf, cellAt);
  const rowidInfo = readVarint(pageBuf, cellAt + payloadInfo.size);
  const total = payloadInfo.value;
  const local = localPayloadBytes(usable, total);
  const start = cellAt + payloadInfo.size + rowidInfo.size;
  const head = pageBuf.subarray(start, start + local);
  if (local >= total) return Buffer.from(head);
  const overflowPage = readU32(pageBuf, start + local);
  const rest = readOverflow(buf, pageSize, overflowPage, total - local);
  return Buffer.concat([head, ...rest]);
}

function walkTablePage(buf, pageSize, pageNo, usable, onPayload) {
  const p = page(buf, pageSize, pageNo);
  // Page 1 stores the 100-byte file header; the btree header starts at 100.
  const base = pageNo === 1 ? 100 : 0;
  if (p.length < base + 8) return;
  const type = p[base];
  const cellCount = readU16(p, base + 3);
  const headerSize = base + (type === 5 ? 12 : 8);
  if (type === 5) {
    for (let i = 0; i < cellCount; i += 1) {
      const cellAt = readU16(p, headerSize + i * 2);
      const child = readU32(p, cellAt);
      walkTablePage(buf, pageSize, child, usable, onPayload);
    }
    walkTablePage(buf, pageSize, readU32(p, base + 8), usable, onPayload);
    return;
  }
  if (type !== 13) return;
  for (let i = 0; i < cellCount; i += 1) {
    const cellAt = readU16(p, headerSize + i * 2);
    if (cellAt + 2 > p.length) continue;
    try { onPayload(cellPayload(buf, pageSize, usable, p, cellAt)); }
    catch (_) {}
  }
}

function columnNamesFromSql(sql) {
  const m = String(sql || '').match(/\(([\s\S]*)\)/);
  if (!m) return [];
  return m[1].split(',').map(part => {
    const name = part.trim().split(/\s+/)[0] || '';
    return name.replace(/["`[\]]/g, '');
  }).filter(Boolean);
}

function readViaJs(dbPath) {
  const buf = fs.readFileSync(dbPath);
  if (buf.length < 100 || buf.subarray(0, 16).toString() !== 'SQLite format 3\0') return '';
  let pageSize = readU16(buf, 16);
  if (pageSize === 1) pageSize = 65536;
  const reserved = buf[20];
  const usable = pageSize - reserved;
  let cookiesSql = '';
  let cookiesRoot = 0;
  walkTablePage(buf, pageSize, 1, usable, payload => {
    const fields = parseRecord(payload);
    // sqlite_master: type, name, tbl_name, rootpage, sql
    if (String(fields[0]) === 'table' && String(fields[1]) === 'cookies') {
      cookiesRoot = Number(fields[3]) || 0;
      cookiesSql = String(fields[4] || '');
    }
  });
  if (!cookiesRoot) return '';
  const cols = columnNamesFromSql(cookiesSql);
  const hostIdx = cols.indexOf('host_key');
  const nameIdx = cols.indexOf('name');
  const valueIdx = cols.indexOf('value');
  if (hostIdx < 0 || nameIdx < 0 || valueIdx < 0) return '';
  const rows = [];
  walkTablePage(buf, pageSize, cookiesRoot, usable, payload => {
    const fields = parseRecord(payload);
    rows.push({
      host_key: fields[hostIdx],
      name: fields[nameIdx],
      value: fields[valueIdx],
    });
  });
  return formatPairs(rows);
}

export function readClientCookies(dbPath, opts = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return '';
  let snap;
  try { snap = snapshotDb(dbPath); }
  catch (_) { return ''; }
  try {
    if (!opts.jsOnly) {
      const bin = findSqlite3Bin();
      if (bin) {
        try {
          const text = readViaCli(snap.dest, bin);
          if (text) return text;
        } catch (_) {}
      }
    }
    return readViaJs(snap.dest);
  } finally {
    try { fs.rmSync(snap.dir, { recursive: true, force: true }); } catch (_) {}
  }
}
