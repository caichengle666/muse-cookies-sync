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
 *   PORT  监听端口，默认 8787
 *   HOST  监听地址，默认 0.0.0.0；放在 Nginx 后面时建议设为 127.0.0.1，
 *         这样 8787 端口不会直接暴露到公网，只由反代访问
 *   TOKEN 鉴权令牌，为空则不校验（生产环境务必设置）
 *
 * 接口：
 *   GET  /api/ping         健康检查
 *   POST /api/cookies      接收油猴脚本推送的 Cookie（需带 X-Auth-Token，若设置了 TOKEN）
 *   POST /api/credentials  接收油猴脚本推送的「你本人账号」凭据（同样需令牌）
 *
 * 数据落盘：
 *   server/data/cookies-<时间戳>.json     每次一份快照
 *   server/data/latest-<host>.json        每个站点最新一份
 *   server/data/cookies.jsonl             追加式日志（每行一条）
 *   server/data/credentials-<host>.json   凭据（覆盖式保存）
 *
 * ⚠️ /api/credentials 会以明文保存密码，仅限你私人服务器使用，
 *    务必启用 TOKEN + HTTPS，切勿暴露到公网。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0'; // 反代场景建议设为 127.0.0.1
const TOKEN = process.env.TOKEN || ''; // 为空则不校验令牌
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

function persist(payload) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const host = safeName(payload.site);

  // 1) 时间戳快照
  fs.writeFileSync(path.join(DATA_DIR, `cookies-${host}-${ts}.json`), JSON.stringify(payload, null, 2));
  // 2) 该站点最新
  fs.writeFileSync(path.join(DATA_DIR, `latest-${host}.json`), JSON.stringify(payload, null, 2));
  // 3) 追加日志
  fs.appendFileSync(path.join(DATA_DIR, 'cookies.jsonl'), JSON.stringify(payload) + '\n');
}

function persistCredential(payload) {
  const host = safeName(payload.site);
  const file = path.join(DATA_DIR, `credentials-${host}.json`);

  // 按 (site, username) 归并
  let store = { site: payload.site, updatedAt: null, entries: [] };
  try {
    if (fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    /* 忽略损坏文件，重建 */
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
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/ping') {
    return send(res, 200, { ok: true, service: 'cookie-sync', time: new Date().toISOString() });
  }

  // 令牌校验（仅在设置了环境变量 TOKEN 时启用）
  const checkToken = () => {
    if (TOKEN && req.headers['x-auth-token'] !== TOKEN) {
      send(res, 401, { ok: false, error: 'unauthorized: X-Auth-Token 不正确' });
      return false;
    }
    return true;
  };

  if (req.method === 'POST' && url.pathname === '/api/cookies') {
    if (!checkToken()) return;

    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      if (!payload || !Array.isArray(payload.cookies)) {
        return send(res, 400, { ok: false, error: 'payload.cookies 必须是数组' });
      }

      persist(payload);
      console.log(
        `[${new Date().toLocaleTimeString()}] 收到 ${payload.site} 的 ${payload.cookies.length} 条 Cookie（来源 ${payload.source}）`
      );
      return send(res, 200, { ok: true, received: payload.cookies.length, site: payload.site });
    } catch (err) {
      console.error('处理失败：', err.message);
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
      console.log(
        `[${new Date().toLocaleTimeString()}] 收到 ${payload.site} 的凭据（账号 ${payload.username}）`
      );
      return send(res, 200, { ok: true, site: payload.site, username: payload.username });
    } catch (err) {
      console.error('处理失败：', err.message);
      return send(res, 400, { ok: false, error: err.message });
    }
  }

  send(res, 404, { ok: false, error: 'not found' });
});
server.listen(PORT, HOST, () => {
  console.log('Cookie Sync 接收端已启动');
  console.log(`  监听地址 : http://${HOST}:${PORT}`);
  console.log(`  Cookie   : http://<你的服务器IP>:${PORT}/api/cookies`);
  console.log(`  凭据     : http://<你的服务器IP>:${PORT}/api/credentials`);
  console.log(`  鉴权令牌 : ${TOKEN ? '已启用（X-Auth-Token）' : '未启用（任何人可推送，建议设置 TOKEN）'}`);
  console.log(`  数据目录 : ${DATA_DIR}`);
});
