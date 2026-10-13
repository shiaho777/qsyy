import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findSqlite3Bin, readClientCookies } from './cookies.mjs';

function pairs(text) {
  return Object.fromEntries(text.split('; ').filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return [p.slice(0, i), p.slice(i + 1)];
  }));
}

test('JS reader matches sqlite3 CLI on a fixture', () => {
  const bin = findSqlite3Bin();
  assert.ok(bin, 'need sqlite3 to build the fixture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsyy-cktest-'));
  const db = path.join(dir, 'Cookies');
  execFileSync(bin, [db, `
    CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL
    );
    INSERT INTO cookies VALUES
      (1,'.qishui.com','sessionid','abc123',x'','/'),
      (2,'.qishui.com','sid_tt','tok',x'','/'),
      (3,'.qishui.com','empty','',x'','/'),
      (4,'.example.com','sessionid','nope',x'','/'),
      (5,'.bytedance.com','ttwid','tw',x'','/');
  `]);
  const viaCli = readClientCookies(db);
  const viaJs = readClientCookies(db, { jsOnly: true });
  assert.deepEqual(pairs(viaJs), { sessionid: 'abc123', sid_tt: 'tok', ttwid: 'tw' });
  assert.deepEqual(pairs(viaCli), pairs(viaJs));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JS reader understands the live soda Cookies db', () => {
  const live = path.join(os.homedir(), 'Library', 'Application Support', 'SodaMusic', 'Cookies');
  if (!fs.existsSync(live)) return;
  const viaCli = readClientCookies(live);
  const viaJs = readClientCookies(live, { jsOnly: true });
  assert.match(viaCli, /sessionid=/);
  assert.deepEqual(pairs(viaJs), pairs(viaCli));
});
