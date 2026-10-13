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

export const QR_SCAN_HINT = '请用汽水音乐 App 扫这个码，并在手机上确认';
export const QR_POLL_MIN_INTERVAL_MS = 2500;
export const QR_RATE_LIMIT_COOLDOWN_MS = 5000;
export const QR_PENDING_TTL_MS = 10 * 60 * 1000;
export const WEB_SESSION_COOKIE_NAMES = [
  'sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss',
  'ssid_ucp_v1', 'sid_ucp_v1', 'passport_csrf_token', 'ttwid', 'odin_tt', 'n_mh',
  'passport_assist_user', 'session_tlb_tag', 'uid',
];
export const QR_RATE_LIMIT_WAIT_MESSAGE = '查询被限流。若已扫码，请在汽水里点确认，并稍等几秒';
export const QR_RATE_LIMIT_SCANNED_MESSAGE = '已扫码,请在汽水音乐上确认（查询被限流，稍候再问）';
export const A_BOGUS_LENGTH = 44;
const QR_VIEW_RANK = {
  waiting: 0,
  rate_limited: 0,
  scanned: 1,
  need_verify: 1,
  confirmed: 2,
  success: 3,
};

export function qrScanHint(_data) {
  return QR_SCAN_HINT;
}

export function classifyQrPoll(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : (payload || {});
  const errorCode = Number(data.error_code);
  const status = String(data.status ?? '').toLowerCase();
  const redirect = data.redirect_url || data.redirectUrl || '';
  if (status === '3' || status === 'confirmed' || status === 'success') {
    return { status: 'confirmed', message: '已确认,正在登录', redirect };
  }
  if (status === '1' || status === 'scanned') {
    return { status: 'scanned', message: '已扫码,请在汽水音乐上确认' };
  }
  if (status === '2' || status === '5' || status === 'expired') {
    return { status: 'expired', message: '二维码已过期,请重新生成' };
  }
  if (errorCode === 2046) {
    return { status: 'need_verify', message: '汽水里还要再确认一次验证' };
  }
  if (errorCode === 7) {
    return { status: 'rate_limited', message: '访问较频繁,稍后再试' };
  }
  if (status === 'new' || status === '') {
    return { status: 'waiting', message: '等待扫码' };
  }
  const fallback = payload?.message && payload.message !== 'success' ? payload.message : '等待扫码';
  return { status: 'waiting', message: fallback };
}

export function nextQrPollView(classified, previous) {
  if (classified?.status === 'rate_limited') {
    if (previous?.status === 'scanned' || previous?.status === 'confirmed' || previous?.status === 'need_verify') {
      return { status: previous.status, message: QR_RATE_LIMIT_SCANNED_MESSAGE, limited: true };
    }
    return { status: 'waiting', message: QR_RATE_LIMIT_WAIT_MESSAGE, limited: true };
  }
  if (classified?.status === 'expired') {
    return { status: 'expired', message: classified.message };
  }
  const next = {
    status: classified.status,
    message: classified.message,
    ...(classified.redirect ? { redirect: classified.redirect } : {}),
  };
  const nextRank = QR_VIEW_RANK[next.status] ?? 0;
  const prevRank = QR_VIEW_RANK[previous?.status] ?? 0;
  if (previous && nextRank < prevRank) return { ...previous };
  return next;
}

export function aBogusFromUrl(url) {
  try {
    return new URL(String(url || ''), 'https://api.qishui.com').searchParams.get('a_bogus') || '';
  } catch (_) {
    return '';
  }
}

export function isSignedPassportUrl(url) {
  return aBogusFromUrl(url).length === A_BOGUS_LENGTH;
}

export function cookieMapFromBrowserCookies(input) {
  if (!input) return {};
  if (typeof input === 'string') return parseCookieHeader(input);
  if (Array.isArray(input)) {
    const into = {};
    for (const item of input) {
      if (item && item.name && item.value != null && item.value !== '') {
        into[item.name] = String(item.value);
      }
    }
    return into;
  }
  if (typeof input === 'object') return { ...input };
  return {};
}

export function mergeCookiePayload(pendingCookies, payload) {
  const jar = { ...(pendingCookies || {}) };
  Object.assign(jar, cookieMapFromBrowserCookies(payload?.cookies));
  Object.assign(jar, cookieMapFromBrowserCookies(payload?.browserCookies));
  if (typeof payload?.cookie === 'string') Object.assign(jar, parseCookieHeader(payload.cookie));
  if (typeof payload?.documentCookie === 'string') Object.assign(jar, parseCookieHeader(payload.documentCookie));
  if (Array.isArray(payload?.setCookie)) collectCookies(payload.setCookie, jar);
  else if (typeof payload?.setCookie === 'string' && payload.setCookie) collectCookies([payload.setCookie], jar);
  return jar;
}

export function shouldCommitQrSession(classified, cookieMap) {
  const status = classified?.status;
  if (status !== 'confirmed' && status !== 'success') return false;
  return Boolean(pickWebSessionCookies(cookieMap));
}

export function qrPollDetail(classified, raw, httpStatus = 0) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : (raw || {});
  const errorCode = Number(data.error_code);
  return {
    errorCode: Number.isFinite(errorCode) ? errorCode : null,
    passportStatus: data.status == null ? '' : String(data.status),
    httpStatus: httpStatus || 0,
    classified: classified?.status || '',
  };
}

export function shouldFallbackToGet(postResult) {
  if (!postResult) return true;
  if (postResult.status === 0) return true;
  if (!postResult.json) return true;
  return false;
}

export function checkQrconnectGetUrl(apiBase, search, token) {
  const extra = new URLSearchParams({
    token,
    need_logo: 'false',
    need_short_url: 'false',
    is_frontier: 'false',
    is_new_login: '1',
    next: 'https://api.qishui.com',
  });
  return `${apiBase}/passport/web/check_qrconnect/?${search}&${extra}`;
}

export function serializeQrPending(entries, now = Date.now(), ttl = QR_PENDING_TTL_MS) {
  const out = {};
  for (const [token, value] of entries) {
    if (!token || !value) continue;
    const createdAt = value.createdAt || now;
    if (now - createdAt > ttl) continue;
    out[token] = {
      cookies: value.cookies || {},
      device_id: value.device_id,
      install_id: value.install_id,
      did: value.did || value.device_id,
      iid: value.iid || value.install_id,
      lastResult: value.lastResult || { status: 'waiting', message: '等待扫码' },
      createdAt,
    };
  }
  return out;
}

export function restoreQrPending(obj, now = Date.now(), ttl = QR_PENDING_TTL_MS) {
  const map = new Map();
  for (const [token, value] of Object.entries(obj || {})) {
    if (!token || !value) continue;
    const createdAt = value.createdAt || 0;
    if (createdAt && now - createdAt > ttl) continue;
    map.set(token, {
      cookies: value.cookies || {},
      device_id: value.device_id,
      install_id: value.install_id,
      did: value.did || value.device_id,
      iid: value.iid || value.install_id,
      lastCheck: 0,
      cooldownUntil: 0,
      lastResult: value.lastResult || { status: 'waiting', message: '等待扫码' },
      createdAt: createdAt || now,
    });
  }
  return map;
}

export function parseCookieHeader(header) {
  const into = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) into[name] = value;
  }
  return into;
}

export function pickWebSessionCookies(cookieMap) {
  const filtered = {};
  for (const name of WEB_SESSION_COOKIE_NAMES) {
    if (cookieMap?.[name]) filtered[name] = cookieMap[name];
  }
  if (!filtered.sessionid && filtered.sessionid_ss) filtered.sessionid = filtered.sessionid_ss;
  return filtered.sessionid ? filtered : null;
}

export function qrPollShouldWait(now, lastCheck = 0, cooldownUntil = 0, minInterval = QR_POLL_MIN_INTERVAL_MS) {
  if (cooldownUntil && now < cooldownUntil) return true;
  if (lastCheck && now - lastCheck < minInterval) return true;
  return false;
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
