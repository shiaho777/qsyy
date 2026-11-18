import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrustedHostname,
  parseTrustedUrl,
  isSafeExternalUrl,
  isSameOrigin,
} from './net-guard.mjs';

test('isTrustedHostname accepts the domain and its subdomains only', () => {
  assert.equal(isTrustedHostname('douyinpic.com'), true);
  assert.equal(isTrustedHostname('p3-sign.douyinpic.com'), true);
  assert.equal(isTrustedHostname('P3-SIGN.DOUYINPIC.COM'), true);
  assert.equal(isTrustedHostname('evil-douyinpic.com'), false);
  assert.equal(isTrustedHostname('douyinpic.com.evil.test'), false);
  assert.equal(isTrustedHostname('notdouyinpic.com'), false);
  assert.equal(isTrustedHostname(''), false);
});

test('parseTrustedUrl only accepts credentialed-free HTTPS on default ports', () => {
  const ok = parseTrustedUrl('https://p3-sign.douyinpic.com/cover.jpg');
  assert.equal(ok?.hostname, 'p3-sign.douyinpic.com');

  assert.equal(parseTrustedUrl('http://p3-sign.douyinpic.com/cover.jpg'), null);
  assert.equal(parseTrustedUrl('https://user:pass@p3-sign.douyinpic.com/x'), null);
  assert.equal(parseTrustedUrl('https://p3-sign.douyinpic.com:8443/x'), null);
  assert.equal(parseTrustedUrl('https://evil-douyinpic.com/x'), null);
  assert.equal(parseTrustedUrl('javascript:alert(1)'), null);
  assert.equal(parseTrustedUrl('file:///etc/passwd'), null);
});

test('parseTrustedUrl can opt into HTTP and non-default ports for external links', () => {
  assert.equal(parseTrustedUrl('http://example.com', { hosts: [], protocols: ['http:'] })?.href, 'http://example.com/');
  assert.equal(parseTrustedUrl('https://example.com:8443/a', {
    hosts: [],
    protocols: ['http:', 'https:'],
    requireDefaultPort: false,
  })?.port, '8443');
});

test('isSafeExternalUrl allows only HTTP(S) and rejects credentials', () => {
  assert.equal(isSafeExternalUrl('https://github.com/shiaho777/qsyy'), true);
  assert.equal(isSafeExternalUrl('http://127.0.0.1:18790/obs.html'), true);
  assert.equal(isSafeExternalUrl('file:///Applications/Calculator.app'), false);
  assert.equal(isSafeExternalUrl('ms-settings:privacy'), false);
  assert.equal(isSafeExternalUrl('https://user:pass@example.com'), false);
  assert.equal(isSafeExternalUrl('not a url'), false);
});

test('isSameOrigin rejects prefix and port look-alikes', () => {
  const base = 'http://127.0.0.1:18790';
  assert.equal(isSameOrigin('http://127.0.0.1:18790/obs.html', base), true);
  assert.equal(isSameOrigin('http://127.0.0.1:187901/', base), false);
  assert.equal(isSameOrigin('http://127.0.0.1:18790.evil.test/', base), false);
  assert.equal(isSameOrigin('https://127.0.0.1:18790/', base), false);
  assert.equal(isSameOrigin('not a url', base), false);
});


