// Network-facing guards for the web remote. Shared verbatim with the
// companion kat500 web remote - keep the two copies in sync.
//
// What this protects against:
//  - DNS rebinding: a malicious web page re-points its own domain at this
//    machine's IP so the browser treats our API as same-origin. Blocked by
//    only accepting Host headers that are an IP literal, localhost, this
//    machine's own name, or something listed in config.allowedHosts - a
//    rebinding attack always arrives with the attacker's domain as Host.
//  - Cross-site WebSocket hijacking: a page on some other site opening
//    ws://<this-machine>:<port>/ws (which, on the KPA500, opens the serial
//    port and can wake the amp via DTR). Blocked by requiring the browser's
//    Origin to match the request's own host:port (or config.allowedOrigins).
//  - Cross-site API requests: only JSON POSTs are accepted (needs a CORS
//    preflight this server never grants), plus Sec-Fetch-Site checks.
//  - Anyone on the network operating the device: optional password
//    (config.auth.password). Accepted as HTTP Basic auth (what TCI Remote
//    Compactor's Username/Password fields send), as ?token=<password> on
//    the URL, or via the session cookie set after either succeeds.

const net = require('net');
const os = require('os');
const crypto = require('crypto');

function bareHost(hostHeader) {
  if (!hostHeader) return '';
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(1, end);
  }
  // Only strip a :port if it's host:port, not a bare IPv6 literal.
  const firstColon = h.indexOf(':');
  if (firstColon !== -1 && firstColon === h.lastIndexOf(':')) h = h.slice(0, firstColon);
  return h.replace(/\.$/, '');
}

function ownNames(extra) {
  const names = new Set(['localhost']);
  const host = os.hostname().toLowerCase();
  if (host) {
    names.add(host);
    const short = host.replace(/\.local$/, '');
    names.add(short);
    names.add(`${short}.local`);
  }
  (extra || []).forEach((n) => names.add(bareHost(n)));
  return names;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i <= 0) return;
      const raw = part.slice(i + 1).trim();
      let value = raw;
      try {
        value = decodeURIComponent(raw);
      } catch (e) {
        /* malformed %-escape: keep raw, it just won't match */
      }
      out[part.slice(0, i).trim()] = value;
    });
  return out;
}

/**
 * @param {object} opts
 * @param {() => object} opts.getConfig  returns the live config object
 * @param {string} opts.appName          e.g. 'KPA500' (auth realm, cookie name)
 */
function createGuards({ getConfig, appName }) {
  // Cookies are scoped per host, not per port, so the KAT500 and KPA500
  // remotes on the same machine need distinct cookie names.
  const cookieName = `${appName.toLowerCase()}_session`;
  // Bounded, so a flood of distinct junk headers can't grow memory.
  const warned = new Set();
  const MAX_WARNED = 100;

  function clip(v) {
    const s = String(v);
    return s.length > 100 ? `${s.slice(0, 100)}…` : s;
  }

  function warnOnce(key, msg) {
    const k = clip(key);
    if (warned.has(k) || warned.size >= MAX_WARNED) return;
    warned.add(k);
    console.warn(msg);
  }

  function authConfig() {
    const auth = getConfig().auth || {};
    return auth.password ? { username: auth.username || '', password: String(auth.password) } : null;
  }

  // The cookie holds a derived value, not the password itself.
  function sessionValue(auth) {
    return crypto
      .createHmac('sha256', auth.password)
      .update(`${appName}-session:${auth.username}`)
      .digest('hex');
  }

  function isAllowedHost(hostHeader) {
    const host = bareHost(hostHeader);
    if (!host) return false;
    if (net.isIP(host)) return true;
    return ownNames(getConfig().allowedHosts).has(host);
  }

  /** host:port as the browser would put it in an Origin (default port dropped). */
  function normalizeAuthority(scheme, authority) {
    try {
      return new URL(`${scheme}://${authority}`).host.toLowerCase();
    } catch (e) {
      return null;
    }
  }

  // Same-origin only: the page must have been loaded from the exact
  // host:port this request is addressed to. Not "any private IP" - that
  // would trust other LAN devices, other Tailscale nodes, and any other
  // localhost port. Extra origins (e.g. a proxy that rewrites Host) go in
  // config.allowedOrigins.
  function isAllowedOrigin(origin, hostHeader) {
    if (!origin) return true; // non-browser client (curl, scripts)
    let url;
    try {
      url = new URL(origin);
    } catch (e) {
      return false; // includes the literal "null" origin
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const extra = (getConfig().allowedOrigins || []).map((o) => String(o).toLowerCase().replace(/\/$/, ''));
    if (extra.includes(url.origin.toLowerCase())) return true;
    const scheme = url.protocol.slice(0, -1);
    const reqHost = hostHeader ? normalizeAuthority(scheme, hostHeader) : null;
    return reqHost !== null && url.host.toLowerCase() === reqHost;
  }

  /** 'ok' | 'denied'; also reports whether a session cookie should be set. */
  function checkAuth(req) {
    const auth = authConfig();
    if (!auth) return { ok: true };

    const cookies = parseCookies(req.headers.cookie);
    if (safeEqual(cookies[cookieName], sessionValue(auth))) return { ok: true };

    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const user = i === -1 ? decoded : decoded.slice(0, i);
      const pass = i === -1 ? '' : decoded.slice(i + 1);
      const userOk = !auth.username || safeEqual(user, auth.username);
      if (userOk && safeEqual(pass, auth.password)) return { ok: true, setCookie: true };
    }
    if (header.startsWith('Bearer ') && safeEqual(header.slice(7), auth.password)) return { ok: true };

    let token = null;
    try {
      token = new URL(req.url, 'http://x').searchParams.get('token');
    } catch (e) {
      /* unparseable URL: no token */
    }
    if (token !== null && safeEqual(token, auth.password)) return { ok: true, setCookie: true, fromQuery: true };

    return { ok: false };
  }

  function sessionCookie() {
    const auth = authConfig();
    return `${cookieName}=${sessionValue(auth)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`;
  }

  function httpMiddleware(req, res, next) {
    if (!isAllowedHost(req.headers.host)) {
      warnOnce(`host:${req.headers.host}`, `Rejected request with unrecognized Host header "${clip(req.headers.host)}" - add it to "allowedHosts" in config.json if it's legitimate`);
      return res.status(403).type('text').send('Forbidden: unrecognized host');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Cross-site protection for API calls. An exact Origin match can't be
      // used here: TCI Remote Compactor's tunnel serves the page from a
      // random *.trycloudflare.com origin while forwarding with Host set to
      // the LAN address, so legitimate requests never match. Instead:
      //  - only accept JSON bodies: a page on another site can't send one
      //    without a CORS preflight, which this server never approves;
      //  - also reject anything the browser itself labels cross-site.
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (req.headers['sec-fetch-site'] === 'cross-site' || !ctype.startsWith('application/json')) {
        warnOnce(`csrf:${req.headers.origin}`, `Rejected cross-site/non-JSON ${req.method} ${clip(req.path)} from Origin "${clip(req.headers.origin)}"`);
        return res.status(403).type('text').send('Forbidden: cross-site request');
      }
    }
    const result = checkAuth(req);
    if (!result.ok) {
      res.set('WWW-Authenticate', `Basic realm="${appName} remote", charset="UTF-8"`);
      return res
        .status(401)
        .type('text')
        .send(`${appName} remote: password required. Sign in, or open this page with ?token=<password> on the URL.`);
    }
    if (result.setCookie) res.append('Set-Cookie', sessionCookie());
    if (result.fromQuery && req.method === 'GET') {
      // Drop the password from the address bar / history once the cookie is set.
      const url = new URL(req.url, 'http://x');
      url.searchParams.delete('token');
      return res.redirect(302, url.pathname + url.search);
    }
    next();
  }

  /** For ws's WebSocketServer `verifyClient` option. */
  // Runs from the HTTP server's 'upgrade' event, outside Express's error
  // handling - anything thrown here would crash the process, so fail closed.
  function verifyWsClient(info, done) {
    try {
      const req = info.req;
      if (!isAllowedHost(req.headers.host)) return done(false, 403, 'Forbidden: unrecognized host');
      if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
        warnOnce(`ws-origin:${req.headers.origin}`, `Rejected cross-site WebSocket from Origin "${clip(req.headers.origin)}" - add it to "allowedOrigins" in config.json if it's legitimate`);
        return done(false, 403, 'Forbidden: cross-site WebSocket');
      }
      if (!checkAuth(req).ok) return done(false, 401, 'Unauthorized');
      return done(true);
    } catch (err) {
      return done(false, 400, 'Bad request');
    }
  }

  return { httpMiddleware, verifyWsClient };
}

module.exports = { createGuards, bareHost };
