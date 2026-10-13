import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifyQrPoll, collectCookies, cookieHeader, followRedirects, nextQrPollView,
  qrPollShouldWait, qrScanHint, qrPollDetail, shouldFallbackToGet, checkQrconnectGetUrl,
  serializeQrPending, restoreQrPending, parseCookieHeader, pickWebSessionCookies,
  QR_PENDING_TTL_MS, aBogusFromUrl, isSignedPassportUrl, cookieMapFromBrowserCookies,
  shouldCommitQrSession, mergeCookiePayload, A_BOGUS_LENGTH,
} from './qr-login.mjs';

test('classifyQrPoll maps numeric passport statuses', () => {
  assert.equal(classifyQrPoll({ data: { status: 'new', error_code: 0 } }).status, 'waiting');
  assert.equal(classifyQrPoll({ data: { status: '1' } }).status, 'scanned');
  assert.equal(classifyQrPoll({ data: { status: 1 } }).status, 'scanned');
  assert.equal(classifyQrPoll({ data: { status: '1' } }).message, '已扫码,请在汽水音乐上确认');
  assert.deepEqual(classifyQrPoll({ data: { status: '3', redirect_url: 'https://x' } }), {
    status: 'confirmed', message: '已确认,正在登录', redirect: 'https://x',
  });
  assert.equal(classifyQrPoll({ data: { status: '5' } }).status, 'expired');
  assert.equal(classifyQrPoll({ data: { status: 'confirmed' } }).status, 'confirmed');
});

test('classifyQrPoll treats error_code 7 as rate limit, not waiting', () => {
  const limited = classifyQrPoll({ data: { error_code: 7, description: '访问太频繁' } });
  assert.equal(limited.status, 'rate_limited');
  assert.match(limited.message, /频繁|稍后再试/);
});

test('classifyQrPoll prefers scanned/confirmed over a rate-limit code', () => {
  assert.equal(classifyQrPoll({ data: { status: '1', error_code: 7 } }).status, 'scanned');
  assert.equal(classifyQrPoll({ data: { status: '3', error_code: 7, redirect_url: 'https://x' } }).status, 'confirmed');
});

test('classifyQrPoll surfaces second-verify instead of waiting', () => {
  assert.equal(classifyQrPoll({ data: { error_code: 2046 } }).status, 'need_verify');
});

test('qrScanHint always asks for 汽水 and ignores Douyin copywriting', () => {
  const hint = qrScanHint({
    copywriting: '{"title":"请使用已登录账号的设备扫码","desc":"请使用[color=red]「抖音 APP」[/]扫码验证"}',
  });
  assert.equal(hint, '请用汽水音乐 App 扫这个码，并在手机上确认');
  assert.equal(qrScanHint({}), '请用汽水音乐 App 扫这个码，并在手机上确认');
});

test('collectCookies and cookieHeader round-trip names', () => {
  const jar = collectCookies([
    'passport_csrf_token=abc; Path=/; HttpOnly',
    'sessionid=sid1; Domain=.qishui.com',
  ]);
  assert.equal(jar.passport_csrf_token, 'abc');
  assert.equal(jar.sessionid, 'sid1');
  assert.equal(cookieHeader(jar), 'passport_csrf_token=abc; sessionid=sid1');
});

test('followRedirects keeps cookies across hops', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/one') {
      res.writeHead(302, { location: '/two', 'set-cookie': 'a=1; Path=/' });
      res.end();
      return;
    }
    if (req.url === '/two') {
      assert.match(req.headers.cookie || '', /a=1/);
      res.writeHead(302, { location: '/done', 'set-cookie': ['sessionid=ok; Path=/', 'sid_tt=tt; Path=/'] });
      res.end();
      return;
    }
    res.writeHead(200, { 'set-cookie': 'n_mh=x; Path=/' });
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const jar = await followRedirects(`http://127.0.0.1:${port}/one`, { 'user-agent': 'qsyy-test' }, {});
  server.close();
  assert.equal(jar.a, '1');
  assert.equal(jar.sessionid, 'ok');
  assert.equal(jar.sid_tt, 'tt');
  assert.equal(jar.n_mh, 'x');
});

test('nextQrPollView keeps the last real status when rate-limited', () => {
  const limited = classifyQrPoll({ data: { error_code: 7 } });
  const waiting = nextQrPollView(limited, { status: 'waiting', message: '等待扫码' });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.limited, true);
  assert.match(waiting.message, /限流|确认/);
  const scanned = nextQrPollView(limited, { status: 'scanned', message: '已扫码,请在汽水音乐上确认' });
  assert.equal(scanned.status, 'scanned');
  assert.match(scanned.message, /限流|确认/);
  assert.equal(nextQrPollView(limited, null).status, 'waiting');
  assert.equal(nextQrPollView(limited, null).limited, true);
});

test('qrPollShouldWait enforces min interval and rate-limit cooldown', () => {
  assert.equal(qrPollShouldWait(1000, 0, 0), false);
  assert.equal(qrPollShouldWait(3499, 1000, 0), true);
  assert.equal(qrPollShouldWait(3500, 1000, 0), false);
  assert.equal(qrPollShouldWait(2000, 1000, 0), true);
  assert.equal(qrPollShouldWait(4000, 1000, 5000), true);
  assert.equal(qrPollShouldWait(5000, 1000, 5000), false);
});

test('qrPollDetail exposes raw passport fields', () => {
  const classified = classifyQrPoll({ data: { status: 'new', error_code: 0 } });
  assert.deepEqual(qrPollDetail(classified, { data: { status: 'new', error_code: 0 } }, 200), {
    errorCode: 0,
    passportStatus: 'new',
    httpStatus: 200,
    classified: 'waiting',
  });
});

test('shouldFallbackToGet only when POST did not yield a body', () => {
  assert.equal(shouldFallbackToGet(null), true);
  assert.equal(shouldFallbackToGet({ status: 0, json: null }), true);
  assert.equal(shouldFallbackToGet({ status: 200, json: null }), true);
  assert.equal(shouldFallbackToGet({ status: 200, json: { data: { error_code: 7 } } }), false);
});

test('checkQrconnectGetUrl puts token on the query string', () => {
  const url = checkQrconnectGetUrl('https://api.qishui.com', 'aid=386088&device_id=1', 'tok_1');
  assert.match(url, /^https:\/\/api\.qishui\.com\/passport\/web\/check_qrconnect\//);
  assert.match(url, /[?&]token=tok_1(&|$)/);
  assert.match(url, /[?&]aid=386088(&|$)/);
});

test('serializeQrPending drops expired tokens and restoreQrPending rehydrates the rest', () => {
  const now = 1_000_000;
  const map = new Map([
    ['fresh', {
      cookies: { passport_csrf_token: 'a' },
      device_id: '1', install_id: '2',
      lastResult: { status: 'scanned', message: '已扫码' },
      createdAt: now - 1000,
    }],
    ['stale', {
      cookies: {},
      device_id: '3', install_id: '4',
      createdAt: now - QR_PENDING_TTL_MS - 1,
    }],
  ]);
  const dumped = serializeQrPending(map, now);
  assert.ok(dumped.fresh);
  assert.equal(dumped.stale, undefined);
  const restored = restoreQrPending(dumped, now);
  assert.equal(restored.get('fresh').cookies.passport_csrf_token, 'a');
  assert.equal(restored.get('fresh').lastResult.status, 'scanned');
  assert.equal(restored.get('fresh').lastCheck, 0);
  assert.equal(restored.has('stale'), false);
});

test('parseCookieHeader and pickWebSessionCookies accept sessionid_ss', () => {
  const parsed = parseCookieHeader('sessionid_ss=abc; uid_tt=1; other=skip');
  assert.equal(parsed.sessionid_ss, 'abc');
  assert.equal(parsed.uid_tt, '1');
  const picked = pickWebSessionCookies(parsed);
  assert.equal(picked.sessionid, 'abc');
  assert.equal(picked.sessionid_ss, 'abc');
  assert.equal(pickWebSessionCookies({ ttwid: 'x' }), null);
});

test('isSignedPassportUrl requires a_bogus of 44 characters', () => {
  const bogus = 'A'.repeat(A_BOGUS_LENGTH);
  const signed = `https://api.qishui.com/passport/web/check_qrconnect/?token=1&a_bogus=${bogus}`;
  assert.equal(aBogusFromUrl(signed).length, 44);
  assert.equal(isSignedPassportUrl(signed), true);
  assert.equal(isSignedPassportUrl('https://api.qishui.com/passport/web/check_qrconnect/?token=1'), false);
  assert.equal(isSignedPassportUrl(`https://api.qishui.com/x?a_bogus=${'B'.repeat(10)}`), false);
});

test('cookieMapFromBrowserCookies reads Playwright lists and CookieManager strings', () => {
  assert.equal(cookieMapFromBrowserCookies([
    { name: 'sessionid_ss', value: 'sid' },
    { name: 'uid_tt_ss', value: 'u1' },
  ]).sessionid_ss, 'sid');
  assert.equal(cookieMapFromBrowserCookies('sessionid=abc; uid_tt=1').sessionid, 'abc');
  assert.equal(cookieMapFromBrowserCookies({ sid_tt: 't' }).sid_tt, 't');
});

test('shouldCommitQrSession only after confirmed plus a session cookie', () => {
  const cookies = { sessionid_ss: 'sid', uid_tt_ss: 'u' };
  assert.equal(shouldCommitQrSession({ status: 'waiting' }, cookies), false);
  assert.equal(shouldCommitQrSession({ status: 'scanned' }, cookies), false);
  assert.equal(shouldCommitQrSession({ status: 'confirmed' }, { ttwid: 'x' }), false);
  assert.equal(shouldCommitQrSession({ status: 'confirmed' }, cookies), true);
  assert.equal(shouldCommitQrSession({ status: 'success' }, { sessionid: 'sid' }), true);
});

test('nextQrPollView does not drop scanned back to waiting', () => {
  const waiting = classifyQrPoll({ data: { status: 'new', error_code: 0 } });
  const view = nextQrPollView(waiting, { status: 'scanned', message: '已扫码,请在汽水音乐上确认' });
  assert.equal(view.status, 'scanned');
});

test('mergeCookiePayload keeps browser-harvested session cookies', () => {
  const jar = mergeCookiePayload(
    { passport_csrf_token: 'csrf' },
    { cookie: 'sessionid_ss=sid; uid_tt_ss=u1', browserCookies: [{ name: 'sid_tt', value: 'tt' }] },
  );
  assert.equal(jar.passport_csrf_token, 'csrf');
  assert.equal(jar.sessionid_ss, 'sid');
  assert.equal(jar.sid_tt, 'tt');
});

test('qr-signer.html loads glue, waits for bdms, and requires 44-char a_bogus', () => {
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'qr-signer.html'),
    'utf8',
  );
  assert.match(html, /sdk-glue\.js/);
  assert.match(html, /qsyyWhenReady/);
  assert.match(html, /qsyyPassportPoll/);
  assert.match(html, /window\.bdms/);
  assert.match(html, /aBogus\.length !== 44/);
  const glue = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'security', 'sdk-glue.js'),
    'utf8',
  );
  assert.match(glue, /_SdkGlueInit/);
  assert.match(glue, /bdms\.js/);
});
