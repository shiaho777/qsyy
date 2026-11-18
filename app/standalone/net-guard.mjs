// Small URL guards shared by the server and the desktop shell.
//
// The previous cover proxy matched CDN hostnames with substring regexes
// (`/douyinpic\.com|.../.test(host)`), which also accepts attacker-controlled
// hosts such as `evil-douyinpic.com`. Wildcard matching is done on label
// boundaries here: a host is trusted only when it is the domain itself or a
// subdomain of it.

export const QISHUI_MEDIA_HOSTS = Object.freeze([
  '365yg.com',
  'bytecdn.cn',
  'bytefcdn.com',
  'byteicdn.com',
  'byteimg.com',
  'bytedance.com',
  'bytedanceapi.com',
  'bytetos.com',
  'douyin.com',
  'douyinpic.com',
  'douyinscdn.com',
  'douyinstatic.com',
  'douyinvod.com',
  'ibytedtos.com',
  'pstatp.com',
  'qishui.com',
  'snssdk.com',
  'volccdn.com',
  'volces.com',
  'volcengineapi.com',
  'volcvideo.com',
  'zijieapi.com',
  'zjcdn.com',
]);

export function isTrustedHostname(hostname, domains = QISHUI_MEDIA_HOSTS) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || !Array.isArray(domains)) return false;
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

// Parse a URL only when it is a plain HTTPS (or HTTP, when explicitly allowed)
// URL with no embedded credentials and a sane port. Returns a URL object or
// null; callers can use `url.href` for outbound requests.
export function parseTrustedUrl(raw, options = {}) {
  const {
    hosts = QISHUI_MEDIA_HOSTS,
    protocols = ['https:'],
    requireDefaultPort = true,
  } = options;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try { url = new URL(raw.trim()); } catch (_) { return null; }
  if (!protocols.includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (requireDefaultPort) {
    const defaultPort = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
    if (url.port && url.port !== defaultPort) return null;
  }
  if (hosts && hosts.length && !isTrustedHostname(url.hostname, hosts)) return null;
  return url;
}

// Links handed to shell.openExternal: HTTP(S) only, no file:// or custom
// protocol handlers, no credentials. A local port is allowed.
export function isSafeExternalUrl(raw) {
  return Boolean(parseTrustedUrl(raw, {
    hosts: [],
    protocols: ['http:', 'https:'],
    requireDefaultPort: false,
  }));
}

export function isSameOrigin(raw, base) {
  try { return new URL(raw).origin === new URL(base).origin; } catch (_) { return false; }
}
