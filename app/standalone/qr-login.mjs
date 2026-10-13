// Passport QR login helpers. ByteDance returns numeric poll status
// (new / 1 scanned / 3 confirmed / 2|5 expired) and puts session cookies
// on the confirmed redirect_url, not on check_qrconnect itself.
import https from 'node:https';
import http from 'node:http';

export function cookieHeader(map) {
  return Object.entries(map || {})
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

export function collectCookies(setCookieHeaders, into = {}) {
  for (const raw of setCookieHeaders || []) {
    const [pair] = String(raw).split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) into[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return into;
}

export function qrScanHint(data) {
  let copy = data?.copywriting;
  if (typeof copy === 'string') {
    try { copy = JSON.parse(copy); } catch (_) { copy = null; }
  }
  const desc = String(copy?.desc || copy?.title || '')
    .replace(/\[color=red\]/gi, '')
    .replace(/\[\/]/g, '')
    .trim();
  return desc || '请用抖音 App 扫码验证';
}

export function classifyQrPoll(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : (payload || {});
  const errorCode = Number(data.error_code);
  const status = String(data.status ?? '').toLowerCase();
  const redirect = data.redirect_url || data.redirectUrl || '';
  if (status === '3' || status === 'confirmed') {
    return { status: 'confirmed', message: '已确认,正在登录', redirect };
  }
  if (status === '1' || status === 'scanned') {
    return { status: 'scanned', message: '已扫码,请在抖音上确认' };
  }
  if (status === '2' || status === '5' || status === 'expired') {
    return { status: 'expired', message: '二维码已过期,请重新生成' };
  }
  if (errorCode === 7 || status === 'new' || status === '') {
    return { status: 'waiting', message: '等待扫码' };
  }
  const fallback = payload?.message && payload.message !== 'success' ? payload.message : '等待扫码';
  return { status: 'waiting', message: fallback };
}

export function followRedirects(url, headers, cookieMap, transport) {
  const jar = cookieMap || {};
  return new Promise(resolve => {
    const visit = (target, hops) => {
      if (!target || hops > 8) { resolve(jar); return; }
      let parsed;
      try { parsed = new URL(target); } catch (_) { resolve(jar); return; }
      const client = transport || (parsed.protocol === 'http:' ? http : https);
      const req = client.get(target, {
        headers: { ...headers, cookie: cookieHeader(jar) },
      }, res => {
        collectCookies(res.headers['set-cookie'], jar);
        const loc = res.headers.location;
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          visit(new URL(loc, target).href, hops + 1);
        } else resolve(jar);
      });
      req.on('error', () => resolve(jar));
      req.setTimeout(15000, () => { try { req.destroy(); } catch (_) {} resolve(jar); });
    };
    visit(url, 0);
  });
}
