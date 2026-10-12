// Tanaw TV server: serves the web app and a streaming proxy.
// The proxy lets the browser play streams that would otherwise fail because of
// CORS, mixed content (http streams on an https page) or required headers
// (User-Agent / Referer). HLS playlists are rewritten so every segment, key and
// sub-playlist also flows through the proxy.

import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 1111;
// Render sets RENDER=true; its router can only reach apps listening on all interfaces.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const HEADER_TIMEOUT_MS = 15000;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
  res.end(text);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

// ---------- Password protection (enabled when ACCESS_PASSWORD is set) ----------
// The session cookie is an HMAC of the password, so changing the password signs everyone out.

const AUTH_COOKIE = 'tanaw_auth';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login', '/api/health', '/favicon.svg']);
const sessionToken = ACCESS_PASSWORD
  ? createHmac('sha256', ACCESS_PASSWORD).update('tanaw-session-v1').digest('base64url')
  : '';
const failedLogins = new Map(); // ip -> { count, resetAt }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function getCookie(req, name) {
  const pair = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
}

function isAuthed(req) {
  return !ACCESS_PASSWORD || safeEqual(getCookie(req, AUTH_COOKIE), sessionToken);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function readBody(req, limit = 4096) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Body too large');
  }
  return body;
}

function loginPage(message = '') {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tanaw TV · Sign in</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    background: #0b0f17; color: #e8ecf4; font: 15px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { width: min(360px, 100%); background: #121826; border: 1px solid #243049; border-radius: 16px; padding: 28px;
    display: flex; flex-direction: column; gap: 14px; }
  h1 { margin: 0; font-size: 22px; } h1 b { color: #fcd116; }
  p { margin: 0; color: #8b97ad; font-size: 13.5px; }
  input { background: #0b0f17; border: 1px solid #243049; border-radius: 10px; padding: 11px 12px; color: inherit; font: inherit; }
  input:focus { outline: 2px solid #fcd116; outline-offset: -1px; }
  button { height: 42px; border: 0; border-radius: 10px; background: #fcd116; color: #1a1400; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: #ff9b9e; }
</style></head>
<body><form method="post" action="/login">
  <h1>Tanaw<b>TV</b></h1>
  <p>Enter the access password to start watching.</p>
  ${message ? `<p class="error">${message}</p>` : ''}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form></body></html>`;
}

async function handleLogin(req, res, reqUrl) {
  if (!ACCESS_PASSWORD) return redirect(res, '/');
  const sendPage = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginPage(message));
  };
  if (req.method !== 'POST') {
    return sendPage(200, reqUrl.searchParams.has('expired') ? 'Please sign in again.' : '');
  }

  const ip = clientIp(req);
  const now = Date.now();
  let entry = failedLogins.get(ip);
  if (!entry || entry.resetAt < now) entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (entry.count >= LOGIN_MAX_FAILS) return sendPage(429, 'Too many attempts. Try again in a few minutes.');

  let password = '';
  try {
    password = new URLSearchParams(await readBody(req)).get('password') || '';
  } catch {
    return sendPage(413, 'Request too large.');
  }

  if (safeEqual(password, ACCESS_PASSWORD)) {
    failedLogins.delete(ip);
    return redirect(res, '/', { 'Set-Cookie': sessionCookie(req, sessionToken, SESSION_MAX_AGE) });
  }
  entry.count++;
  failedLogins.set(ip, entry);
  if (failedLogins.size > 10000) failedLogins.clear(); // keep memory bounded
  await new Promise((r) => setTimeout(r, 600)); // slow down guessing
  return sendPage(401, 'Wrong password.');
}

// ---------- Proxy ----------

// Build the query-string suffix carrying custom headers to child requests.
function headerParams(ua, referer) {
  let s = '';
  if (ua) s += '&ua=' + encodeURIComponent(ua);
  if (referer) s += '&ref=' + encodeURIComponent(referer);
  return s;
}

function proxify(uri, base, extra) {
  let abs;
  try {
    abs = new URL(uri, base);
  } catch {
    return uri;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return uri;
  return '/proxy?url=' + encodeURIComponent(abs.href) + extra;
}

function rewritePlaylist(text, base, extra) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(uri, base, extra)}"`);
      }
      return proxify(t, base, extra);
    })
    .join('\n');
}

function looksLikeHlsPlaylist(contentType, finalUrl) {
  if (/mpegurl/i.test(contentType)) return true;
  try {
    return /\.m3u8?$/i.test(new URL(finalUrl).pathname);
  } catch {
    return false;
  }
}

async function handleProxy(req, res, reqUrl) {
  const target = reqUrl.searchParams.get('url');
  const ua = reqUrl.searchParams.get('ua');
  const referer = reqUrl.searchParams.get('ref');
  const raw = reqUrl.searchParams.has('raw');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return sendText(res, 400, 'Invalid url parameter');
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return sendText(res, 400, 'Only http(s) URLs are allowed');
  }

  const headers = { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*' };
  if (referer) {
    headers.Referer = referer;
    try {
      headers.Origin = new URL(referer).origin;
    } catch {}
  }
  if (req.headers.range) headers.Range = req.headers.range;

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  const timer = setTimeout(() => ac.abort(), HEADER_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(targetUrl, { headers, redirect: 'follow', signal: ac.signal });
  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) sendText(res, 502, 'Upstream fetch failed: ' + (err.cause?.code || err.message));
    return;
  }
  clearTimeout(timer);

  const contentType = upstream.headers.get('content-type') || '';
  const finalUrl = upstream.url || targetUrl.href;

  if (!raw && upstream.ok && looksLikeHlsPlaylist(contentType, finalUrl)) {
    const text = await upstream.text();
    if (text.trimStart().startsWith('#EXTM3U')) {
      const body = rewritePlaylist(text, finalUrl, headerParams(ua, referer));
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      });
      return res.end(body);
    }
    res.writeHead(upstream.status, { ...CORS, 'Content-Type': contentType || 'text/plain' });
    return res.end(text);
  }

  const out = { ...CORS, 'Cache-Control': 'no-cache' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    // Client disconnected or upstream dropped; nothing more to do.
  }
}

async function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Forbidden');
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = reqUrl;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    if (pathname === '/login') return await handleLogin(req, res, reqUrl);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    if (pathname === '/logout') {
      return redirect(res, ACCESS_PASSWORD ? '/login' : '/', { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (!PUBLIC_PATHS.has(pathname) && !isAuthed(req)) {
      if (pathname === '/' || pathname.endsWith('.html')) return redirect(res, '/login');
      return sendText(res, 401, 'Sign in required');
    }
    if (pathname === '/proxy') return await handleProxy(req, res, reqUrl);
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
      return res.end(JSON.stringify({ ok: true, proxy: true, auth: Boolean(ACCESS_PASSWORD) }));
    }
    return await serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, 'Internal error');
    else res.destroy();
  }
});

// Node's fetch only honors HTTP(S)_PROXY (e.g. on office networks) when
// NODE_USE_ENV_PROXY is set at startup, so relaunch with it when a proxy is configured.
const envProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => process.env[k]);
if (envProxy && !process.env.NODE_USE_ENV_PROXY) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.on('SIGINT', () => {}); // the child receives Ctrl+C too and exits on its own
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Tanaw TV running at http://${shown}:${PORT}`);
    if (envProxy) console.log('Using the network proxy from HTTP(S)_PROXY for outgoing requests.');
    console.log(ACCESS_PASSWORD ? 'Password protection is on.' : 'Password protection is off (set ACCESS_PASSWORD to enable).');
    if (HOST === '127.0.0.1') {
      console.log('Only this computer can connect. Set HOST=0.0.0.0 to allow other devices on your network.');
    } else if (!ACCESS_PASSWORD) {
      console.warn('WARNING: the app is reachable from other machines without a password. Set ACCESS_PASSWORD.');
    }
  });
}
