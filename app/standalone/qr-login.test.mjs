import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { classifyQrPoll, collectCookies, cookieHeader, followRedirects, qrScanHint } from './qr-login.mjs';

test('classifyQrPoll maps numeric passport statuses', () => {
  assert.equal(classifyQrPoll({ data: { status: 'new', error_code: 0 } }).status, 'waiting');
  assert.equal(classifyQrPoll({ data: { error_code: 7 } }).message, '等待扫码');
  assert.equal(classifyQrPoll({ data: { status: '1' } }).status, 'scanned');
  assert.equal(classifyQrPoll({ data: { status: 1 } }).status, 'scanned');
  assert.deepEqual(classifyQrPoll({ data: { status: '3', redirect_url: 'https://x' } }), {
    status: 'confirmed', message: '已确认,正在登录', redirect: 'https://x',
  });
  assert.equal(classifyQrPoll({ data: { status: '5' } }).status, 'expired');
  assert.equal(classifyQrPoll({ data: { status: 'confirmed' } }).status, 'confirmed');
});

test('qrScanHint strips copywriting markup', () => {
  const hint = qrScanHint({
    copywriting: '{"title":"请使用已登录账号的设备扫码","desc":"请使用[color=red]「抖音 APP」[/]扫码验证"}',
  });
  assert.equal(hint, '请使用「抖音 APP」扫码验证');
  assert.equal(qrScanHint({}), '请用抖音 App 扫码验证');
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
