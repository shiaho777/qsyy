import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  androidSodaDataCandidates, probeAndroidSoda, androidImportedCookiesPath, pickAndroidCookiesPath,
} from './platform.mjs';

test('android soda candidates sit under Android/data/com.luna.music', () => {
  const found = androidSodaDataCandidates(['/storage/emulated/0', '/sdcard']);
  assert.deepEqual(found, [
    path.join('/storage/emulated/0', 'Android', 'data', 'com.luna.music'),
    path.join('/sdcard', 'Android', 'data', 'com.luna.music'),
  ]);
});

test('probeAndroidSoda reports a readable data dir when readdir works', () => {
  const base = '/storage/emulated/0/Android/data/com.luna.music';
  const fake = {
    existsSync(p) { return p === base; },
    readdirSync(p) { if (p !== base) throw new Error('blocked'); return ['cache', 'files']; },
  };
  const hit = probeAndroidSoda(fake, ['/storage/emulated/0']);
  assert.equal(hit.found, true);
  assert.equal(hit.readable, true);
  assert.equal(hit.path, base);
});

test('probeAndroidSoda distinguishes exists-but-unlistable sandbox dirs', () => {
  const base = '/storage/emulated/0/Android/data/com.luna.music';
  const fake = {
    existsSync(p) { return p === base; },
    readdirSync() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
  };
  const hit = probeAndroidSoda(fake, ['/storage/emulated/0']);
  assert.equal(hit.found, true);
  assert.equal(hit.readable, false);
  assert.equal(hit.path, base);
});

test('probeAndroidSoda is empty when soda data is not on shared storage', () => {
  const fake = { existsSync() { return false; }, readdirSync() { return []; } };
  const hit = probeAndroidSoda(fake, ['/storage/emulated/0']);
  assert.equal(hit.found, false);
  assert.equal(hit.readable, false);
});

test('androidImportedCookiesPath sits under the qsyy home soda-import folder', () => {
  assert.equal(
    androidImportedCookiesPath('/data/user/0/com.shiaho777.qsyy/files'),
    path.join('/data/user/0/com.shiaho777.qsyy/files', 'soda-import', 'Cookies'),
  );
});

test('pickAndroidCookiesPath prefers a copied Cookies file over an unlistable sandbox', () => {
  assert.equal(
    pickAndroidCookiesPath({ imported: '/data/qsyy/soda-import/Cookies', probedCookies: '' }),
    '/data/qsyy/soda-import/Cookies',
  );
  assert.equal(
    pickAndroidCookiesPath({ imported: '', probedCookies: '/sdcard/Android/data/com.luna.music/Cookies' }),
    '/sdcard/Android/data/com.luna.music/Cookies',
  );
  assert.equal(pickAndroidCookiesPath({ imported: '', probedCookies: '' }), '');
});
