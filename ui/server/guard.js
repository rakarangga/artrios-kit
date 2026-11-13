// Request guard (PRD AIOS-61 v2.0 §17, AC 2 and 35): Host and Origin must name this server. Used by HTTP and by
// WebSocket upgrades alike. Who is signed in is auth.js's job; this only stops DNS rebinding and cross-site calls.
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const WILDCARD = new Set(['0.0.0.0', '::']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

// Allowed Host headers: loopback always, the configured LAN address (config.host), and config.allowedHosts
// (a name such as "artrios-pc" or "artrios-pc:4317"; without a port the server port is meant). IPv4 and names only.
export function allowedHosts({ port, host, extra = [] }) {
  const out = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const add = (h) => {
    const v = String(h).trim().toLowerCase();
    if (!v || WILDCARD.has(v)) return;
    out.add(/:\d+$/.test(v) ? v : `${v}:${port}`);
  };
  if (host && !LOOPBACK.has(String(host).toLowerCase())) add(host);
  for (const h of extra) add(h);
  return out;
}

export function createGuard({ port, host = null, extraHosts = [] }) {
  const hosts = allowedHosts({ port, host, extra: extraHosts });
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  // Returns null when the request is allowed, else a short reason (the caller answers 403 or closes the socket).
  function check(req) {
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return 'bad host';
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return 'bad origin';
    return null;
  }
  return { check, hosts: [...hosts] };
}
