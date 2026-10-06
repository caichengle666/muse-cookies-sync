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
});

test('GET /api/cookies reports a missing site snapshot', async () => {
  const res = await fetch(`${BASE_URL}/api/cookies?site=missing.example`, {
    headers: { 'X-Auth-Token': TOKEN },
  });
  assert.equal(res.status, 404);
});

