// Network-facing guards for the web remote. Shared verbatim with the
// companion kat500 web remote - keep the two copies in sync.
//
// What this protects against:
//  - DNS rebinding: a malicious web page re-points its own domain at this
//    machine's IP so the browser treats our API as same-origin. Blocked by
//    only accepting Host headers that are an IP literal, localhost, this
//    machine's own name, or something listed in config.allowedHosts - a
//    rebinding attack always arrives with the attacker's domain as Host.
//  - Cross-site WebSocket hijacking / cross-site requests: a page on some
//    other site opening ws://<this-machine>:<port>/ws (which, on the KPA500,
//    opens the serial port and can wake the amp via DTR). Blocked by
//    rejecting browser requests whose Origin isn't loopback, a private-LAN
//    address, or one of this machine's own names.
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

function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT range - Tailscale uses it
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower); // ULA, link-local
  }
  return false;
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
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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
  const warned = new Set();

  function warnOnce(key, msg) {
    if (warned.has(key)) return;
    warned.add(key);
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

  function isAllowedOrigin(origin) {
    if (!origin) return true; // non-browser client (curl, scripts)
    let url;
    try {
      url = new URL(origin);
    } catch (e) {
      return false; // includes the literal "null" origin
    }
    const host = bareHost(url.hostname);
    if (net.isIP(host)) return isPrivateIp(host);
    return ownNames(getConfig().allowedHosts).has(host);
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

    const token = new URL(req.url, 'http://x').searchParams.get('token');
    if (token !== null && safeEqual(token, auth.password)) return { ok: true, setCookie: true, fromQuery: true };

    return { ok: false };
  }

  function sessionCookie() {
    const auth = authConfig();
    return `${cookieName}=${sessionValue(auth)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`;
  }

  function httpMiddleware(req, res, next) {
    if (!isAllowedHost(req.headers.host)) {
      warnOnce(`host:${req.headers.host}`, `Rejected request with unrecognized Host header "${req.headers.host}" - add it to "allowedHosts" in config.json if it's legitimate`);
      return res.status(403).type('text').send('Forbidden: unrecognized host');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(req.headers.origin)) {
      warnOnce(`origin:${req.headers.origin}`, `Rejected cross-site request from Origin "${req.headers.origin}"`);
      return res.status(403).type('text').send('Forbidden: cross-site request');
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
  function verifyWsClient(info, done) {
    const req = info.req;
    if (!isAllowedHost(req.headers.host)) return done(false, 403, 'Forbidden: unrecognized host');
    if (!isAllowedOrigin(req.headers.origin)) {
      warnOnce(`ws-origin:${req.headers.origin}`, `Rejected cross-site WebSocket from Origin "${req.headers.origin}"`);
      return done(false, 403, 'Forbidden: cross-site WebSocket');
    }
    if (!checkAuth(req).ok) return done(false, 401, 'Unauthorized');
    done(true);
  }

  return { httpMiddleware, verifyWsClient };
}

module.exports = { createGuards, bareHost, isPrivateIp };
