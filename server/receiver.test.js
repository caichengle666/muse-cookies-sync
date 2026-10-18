'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const PORT = 18788;
const TOKEN = 'test-token';
const BASE_URL = `http://127.0.0.1:${PORT}`;

let dataDir;
let child;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch (e) {
      /* server is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('测试服务启动超时');
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-sync-test-'));
  child = spawn(process.execPath, ['receiver.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      TOKEN,
      DATA_DIR: dataDir,
      LOG_FORMAT: 'json',
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/cookies requires authentication', async () => {
  const res = await fetch(`${BASE_URL}/api/cookies?site=example.com`);
  assert.equal(res.status, 401);
});

test('GET /api/sites requires the shared API token', async () => {
  const res = await fetch(`${BASE_URL}/api/sites`);
  assert.equal(res.status, 401);
});

test('GET /admin serves the read-only management page', async () => {
  const res = await fetch(`${BASE_URL}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /X-Auth-Token/);
});

test('uploaded cookies can be fetched by site', async () => {
  const payload = {
    site: 'example.com',
    exportedAt: '2026-10-06T00:00:00.000Z',
    cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }],
  };

  const upload = await fetch(`${BASE_URL}/api/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
    body: JSON.stringify(payload),
  });
  assert.equal(upload.status, 200);

  const download = await fetch(`${BASE_URL}/api/cookies?site=example.com`, {
    headers: { 'X-Auth-Token': TOKEN },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(await download.json(), { ok: true, payload });

  const sites = await fetch(`${BASE_URL}/api/sites`, {
    headers: { 'X-Auth-Token': TOKEN },
  });
  assert.equal(sites.status, 200);
  assert.deepEqual(await sites.json(), {
    ok: true,
    sites: [{ site: 'example.com', exportedAt: payload.exportedAt, cookieCount: 1 }],
  });
});

test('GET /api/cookies reports a missing site snapshot', async () => {
  const res = await fetch(`${BASE_URL}/api/cookies?site=missing.example`, {
    headers: { 'X-Auth-Token': TOKEN },
  });
  assert.equal(res.status, 404);
});


test('OPTIONS preflight is rejected with 405 and no CORS headers', async () => {
  for (const p of ['/api/cookies', '/api/sites', '/api/credentials', '/health']) {
    const res = await fetch(`${BASE_URL}${p}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-auth-token',
      },
    });
    assert.equal(res.status, 405, p);
    for (const [k] of res.headers) assert.ok(!k.startsWith('access-control-'), `${p} 不应返回 ${k}`);
    await res.arrayBuffer();
  }
});

test('API responses carry no Access-Control-* headers', async () => {
  const reqs = [
    fetch(`${BASE_URL}/health`, { headers: { Origin: 'https://evil.example' } }),
    fetch(`${BASE_URL}/api/sites`, { headers: { Origin: 'https://evil.example', 'X-Auth-Token': TOKEN } }),
    fetch(`${BASE_URL}/api/cookies?site=example.com`, { headers: { Origin: 'https://evil.example' } }),
    fetch(`${BASE_URL}/admin`, { headers: { Origin: 'https://evil.example' } }),
    fetch(`${BASE_URL}/api/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN, Origin: 'https://evil.example' },
      body: JSON.stringify({ site: 'cors.example', cookies: [] }),
    }),
  ];
  for (const res of await Promise.all(reqs)) {
    for (const [k] of res.headers) assert.ok(!k.startsWith('access-control-'), `${res.url} 不应返回 ${k}`);
    await res.arrayBuffer();
  }
});
