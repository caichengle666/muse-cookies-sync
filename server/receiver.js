/**
 * Cookie Sync 接收端（零依赖，Node.js 原生 http）
 *
 * 用法：
 *   node receiver.js
 *   # 自定义端口 / 令牌 / 监听地址
 *   PORT=9000 TOKEN=mysecret node receiver.js            (Linux/macOS)
 *   PORT=9000 TOKEN=mysecret HOST=127.0.0.1 node receiver.js
 *
 * 环境变量：
 *   PORT                   监听端口，默认 8787
 *   HOST                   监听地址，默认 127.0.0.1；需要远程访问时使用 HTTPS 反向代理
 *   TOKEN                  必填鉴权令牌
 *   LOG_FORMAT             日志格式：text（默认）或 json
 *   DATA_DIR               数据目录，默认 <脚本目录>/data
 *   MAX_SNAPSHOTS_PER_SITE 每站点保留的快照份数，默认 20；0 = 不限
 *   RETENTION_DAYS         快照保留天数，默认 30；0 = 不按时间清理
 *   DEDUP                  相同 Cookie 内容是否跳过重复落盘，默认开；设为 0 关闭
 *
 * 接口：
 *   GET  /health           健康检查（无需令牌，仅回基础状态）
 *   GET  /api/ping         同上（兼容旧调用）
 *   GET  /api/cookies      按 site 查询最新 Cookie（需令牌）
 *   POST /api/cookies      接收油猴脚本推送的 Cookie（需带 X-Auth-Token，若设置了 TOKEN）
 *   POST /api/credentials  接收油猴脚本推送的「你本人账号」凭据（同样需令牌）
 *
 * 数据落盘：
 *   <DATA_DIR>/cookies-<host>-<时间戳>.json   每次内容变化一份快照（受保留策略约束）
 *   <DATA_DIR>/latest-<host>.json             每个站点最新一份（总是覆盖）
 *   <DATA_DIR>/cookies.jsonl                  追加式日志（内容未变则不追加）
 *   <DATA_DIR>/credentials-<host>.json        凭据（覆盖式保存）
 *
 * ⚠️ /api/credentials 会以明文保存密码，仅限你私人服务器使用，
 *    务必启用 TOKEN + HTTPS，切勿暴露到公网。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.TOKEN || '';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

if (!TOKEN.trim()) {
  process.stderr.write('TOKEN is required; refusing to start without API authentication.\n');
  process.exit(1);
}

const LOG_JSON = (process.env.LOG_FORMAT || 'text').toLowerCase() === 'json';
const MAX_SNAPSHOTS = intEnv('MAX_SNAPSHOTS_PER_SITE', 20); // 0 = 不限
const RETENTION_DAYS = intEnv('RETENTION_DAYS', 30); // 0 = 不按时间清理
const DEDUP = (process.env.DEDUP || '1') !== '0';

function intEnv(name, def) {
  const v = parseInt(process.env[name] || String(def), 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(DATA_DIR, 0o700);

function writePrivateFile(file, content, append = false) {
  if (append) fs.appendFileSync(file, content, { mode: 0o600 });
  else fs.writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

// ---------------------------------------------------------------------------
// 日志（text / json 两种格式，统一走 stdout 交给 systemd、PM2、Docker 收集）
// ---------------------------------------------------------------------------
function log(level, msg, fields) {
  const time = new Date().toISOString();
  if (LOG_JSON) {
    process.stdout.write(JSON.stringify({ time, level, msg, ...(fields || {}) }) + '\n');
    return;
  }
  const suffix = fields && Object.keys(fields).length ? '  ' + JSON.stringify(fields) : '';
  process.stdout.write(`[${new Date().toLocaleTimeString()}] ${level.padEnd(5)} ${msg}${suffix}\n`);
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeName(host) {
  return String(host || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function validSite(site) {
  return typeof site === 'string' && site.length > 0 && site.length <= 253 && !/[\\/\0]/.test(site);
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/** 记录每个站点上一次的内容指纹，用于跳过重复落盘 */
const lastFingerprint = new Map();

/** 内容指纹：只取「站点 + Cookie 集合」，忽略 exportedAt 之类每次都变的字段 */
function fingerprint(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ site: payload.site || '', cookies: payload.cookies || [] }))
    .digest('hex')
    .slice(0, 16);
}

function unlinkQuietly(file) {
  try {
    fs.unlinkSync(file);
    log('info', 'pruned', { file: path.basename(file) });
  } catch (e) {
    /* 已被别处删掉等情况，忽略 */
  }
}

/** 保留策略：每站点份数上限 + 总体按天清理 */
function prune() {
  if (MAX_SNAPSHOTS === 0 && RETENTION_DAYS === 0) return;
  let files;
  try {
    files = fs.readdirSync(DATA_DIR);
  } catch (e) {
    return;
  }

  // a) 每站点快照份数上限（文件名里带 ISO 时间戳，字典序即时间序）
  if (MAX_SNAPSHOTS > 0) {
    const bySite = new Map();
    for (const f of files) {
      const m = /^cookies-(.+?)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.exec(f);
      if (!m) continue;
      if (!bySite.has(m[1])) bySite.set(m[1], []);
      bySite.get(m[1]).push(f);
    }
    for (const list of bySite.values()) {
      list.sort();
      for (const f of list.slice(0, Math.max(0, list.length - MAX_SNAPSHOTS))) {
        unlinkQuietly(path.join(DATA_DIR, f));
      }
    }
  }

  // b) 按 mtime 清理过期快照
  if (RETENTION_DAYS > 0) {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const f of files) {
      if (!f.startsWith('cookies-') || !f.endsWith('.json')) continue;
      const full = path.join(DATA_DIR, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) unlinkQuietly(full);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
}

function persist(payload) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const host = safeName(payload.site);
  const fp = fingerprint(payload);

  // 内容与上次一致 → 不重复写快照与 jsonl，只刷新 latest
  const duplicate = DEDUP && lastFingerprint.get(payload.site) === fp;
  lastFingerprint.set(payload.site, fp);

  if (!duplicate) {
    writePrivateFile(path.join(DATA_DIR, `cookies-${host}-${ts}.json`), JSON.stringify(payload, null, 2));
    writePrivateFile(path.join(DATA_DIR, 'cookies.jsonl'), JSON.stringify(payload) + '\n', true);
  }
  writePrivateFile(path.join(DATA_DIR, `latest-${host}.json`), JSON.stringify(payload, null, 2));

  prune();
  return { duplicate };
}

function persistCredential(payload) {
  const host = safeName(payload.site);
  const file = path.join(DATA_DIR, `credentials-${host}.json`);

  // 按 (site, username) 归并
  let store = { site: payload.site, updatedAt: null, entries: [] };
  try {
    if (fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('warn', 'credentials file unreadable, rebuilt', { file });
  }
  if (!Array.isArray(store.entries)) store.entries = [];

  const idx = store.entries.findIndex((e) => e.username === payload.username);
  const entry = {
    username: payload.username,
    password: payload.password,
    note: payload.note || '',
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) store.entries[idx] = entry;
  else store.entries.push(entry);

  store.updatedAt = entry.updatedAt;
  writePrivateFile(file, JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const startedAt = Date.now();

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/admin') {
    const html = fs.readFileSync(path.join(__dirname, 'admin.html'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
    return;
  }

  // 健康检查：不校验令牌，只回基础状态（不含任何数据）
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/ping')) {
    return send(res, 200, {
      ok: true,
      service: 'cookie-sync',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      tokenRequired: Boolean(TOKEN),
      time: new Date().toISOString(),
    });
  }

  // 令牌校验
  const checkToken = () => {
    if (req.headers['x-auth-token'] !== TOKEN) {
      log('warn', 'rejected', { reason: 'bad token', path: url.pathname, ip: req.socket.remoteAddress });
      send(res, 401, { ok: false, error: 'unauthorized: X-Auth-Token 不正确' });
      return false;
    }
    return true;
  };

  if (req.method === 'GET' && url.pathname === '/api/sites') {
    if (!checkToken()) return;

    const sites = [];
    try {
      for (const name of fs.readdirSync(DATA_DIR)) {
        if (!/^latest-.+\.json$/.test(name)) continue;
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
          if (!validSite(payload.site) || !Array.isArray(payload.cookies)) continue;
          sites.push({
            site: payload.site,
            exportedAt: payload.exportedAt || null,
            cookieCount: payload.cookies.length,
          });
        } catch (err) {
          log('warn', 'site snapshot skipped', { file: name, msg: err.message });
        }
      }
      sites.sort((a, b) => a.site.localeCompare(b.site));
      return send(res, 200, { ok: true, sites });
    } catch (err) {
      log('error', 'site list failed', { msg: err.message });
      return send(res, 500, { ok: false, error: '读取站点列表失败' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/cookies') {
    if (!checkToken()) return;

    const site = url.searchParams.get('site');
    if (!validSite(site)) {
      return send(res, 400, { ok: false, error: 'site 参数无效' });
    }

    const file = path.join(DATA_DIR, `latest-${safeName(site)}.json`);
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (payload.site !== site || !Array.isArray(payload.cookies)) {
        return send(res, 409, { ok: false, error: '最新快照内容无效或站点不匹配' });
      }
      return send(res, 200, { ok: true, payload });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return send(res, 404, { ok: false, error: `没有 ${site} 的 Cookie 快照` });
      }
      log('error', 'cookies read failed', { site, msg: err.message });
      return send(res, 500, { ok: false, error: '读取 Cookie 快照失败' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/cookies') {
    if (!checkToken()) return;

    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      if (!payload || !validSite(payload.site) || !Array.isArray(payload.cookies)) {
        return send(res, 400, { ok: false, error: 'payload.site 无效或 payload.cookies 不是数组' });
      }

      const { duplicate } = persist(payload);
      log('info', 'cookies received', {
        site: payload.site,
        count: payload.cookies.length,
        source: payload.source,
        duplicate,
      });
      return send(res, 200, {
        ok: true,
        received: payload.cookies.length,
        site: payload.site,
        duplicate,
      });
    } catch (err) {
      log('error', 'cookies failed', { msg: err.message });
      return send(res, 400, { ok: false, error: err.message });
    }
  }

  // 凭据：仅用于保存「你本人账号」的密码，切勿暴露到公网
  if (req.method === 'POST' && url.pathname === '/api/credentials') {
    if (!checkToken()) return;

    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      if (!payload || !payload.site || !payload.username || !payload.password) {
        return send(res, 400, { ok: false, error: 'site / username / password 均为必填' });
      }

      persistCredential(payload);
      log('info', 'credential received', { site: payload.site, username: payload.username });
      return send(res, 200, { ok: true, site: payload.site, username: payload.username });
    } catch (err) {
      log('error', 'credential failed', { msg: err.message });
      return send(res, 400, { ok: false, error: err.message });
    }
  }

  send(res, 404, { ok: false, error: 'not found' });
});

// ---------------------------------------------------------------------------
// 启动与退出
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  log('info', 'started', {
    listen: `${HOST}:${PORT}`,
    tokenRequired: Boolean(TOKEN),
    logFormat: LOG_JSON ? 'json' : 'text',
    dataDir: DATA_DIR,
    maxSnapshotsPerSite: MAX_SNAPSHOTS,
    retentionDays: RETENTION_DAYS,
    dedup: DEDUP,
  });
  prune(); // 启动先按保留策略清一遍
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  server.close(() => {
    log('info', 'closed');
    process.exit(0);
  });
  // 兜底：5 秒内没关干净就强退（避免 systemd 等到超时再 SIGKILL）
  setTimeout(() => {
    log('warn', 'force exit');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { msg: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { msg: String(reason) });
});
