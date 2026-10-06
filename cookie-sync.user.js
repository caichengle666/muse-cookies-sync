// ==UserScript==
// @name         Cookie Sync · Cookie 同步 & 个人凭据保险箱
// @name:zh-CN   Cookie 同步 / 个人凭据保险箱
// @namespace    local.cookie.sync
// @version      1.3.0
// @description  个人工具：导出当前站点 Cookie；维护「你自己账号」的登录凭据并可一键填入登录表单，可选同步到你的鉴权服务器；支持隐藏页面浮漂
// @author       you
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_cookie
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/**
 * Cookie Sync —— 个人用工具（Cookie 导出 + 凭据保险箱）
 *
 * 两个功能：
 *   [Cookie 同步]  读取「当前网站」Cookie（可含 HttpOnly）→ POST 到你自己带令牌的服务器。
 *   [我的凭据]     存入「你自己账号」的登录凭据（本地保存；可选上传到你自己的服务器），
 *                  需要时一键填入当前页面的登录表单。
 *
 * 设计约束（重要）：
 *   - 本脚本只在**你自己的浏览器**上、为你**自己的账号**工作；
 *   - 所有动作都必须**由你显式点击**触发，不做任何后台静默采集；
 *   - 面板是脚本自己的界面，**不模仿、不替换**任何目标网站的登录框；
 *   - 请勿将本脚本分发给他人，或用于收集他人的账号密码。
 *
 * 调试：打开 F12 控制台，过滤 `[Cookie Sync]` 可看到运行日志。
 */

(function () {
  'use strict';

  const TAG = '[Cookie Sync]';
  const dbg = (...a) => {
    try {
      console.log(TAG, ...a);
    } catch (e) {
      /* ignore */
    }
  };

  // ---------------------------------------------------------------------------
  // 存储键
  // ---------------------------------------------------------------------------
  const K = {
    serverUrl: 'cs_server_url',
    authToken: 'cs_auth_token',
    autoExport: 'cs_auto_export',
    lastResult: 'cs_last_result',
    vault: 'cs_vault',
    pos: 'cs_pos', // 浮漂位置
    showFloat: 'cs_show_float', // 是否显示页面浮漂
  };

  const getCfg = () => ({
    serverUrl: GM_getValue(K.serverUrl, ''),
    authToken: GM_getValue(K.authToken, ''),
    autoExport: GM_getValue(K.autoExport, false),
  });

  const b64enc = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(String(s))));
  const b64dec = (s) => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0)));
    } catch (e) {
      return '';
    }
  };

  // ---------------------------------------------------------------------------
  // Cookie 采集
  // ---------------------------------------------------------------------------
  function parseDocumentCookie() {
    if (!document.cookie) return [];
    return document.cookie.split(';').map((pair) => {
      const idx = pair.indexOf('=');
      const name = (idx > -1 ? pair.slice(0, idx) : pair).trim();
      const value = idx > -1 ? pair.slice(idx + 1).trim() : '';
      return {
        name,
        value,
        domain: location.hostname,
        path: '/',
        secure: location.protocol === 'https:',
        hostOnly: false,
        session: true,
        httpOnly: false,
      };
    });
  }

  function gmCookieList(details) {
    return new Promise((resolve) => {
      try {
        if (typeof GM_cookie !== 'undefined' && typeof GM_cookie.list === 'function') {
          GM_cookie.list(details, (cookies, error) => {
            if (error) {
              dbg('GM_cookie.list 错误：', error);
              return resolve(null);
            }
            resolve(Array.isArray(cookies) ? cookies : null);
          });
          return;
        }
      } catch (e) {
        dbg('GM_cookie 调用异常：', e);
      }

      try {
        if (typeof GM !== 'undefined' && GM.cookie && typeof GM.cookie.list === 'function') {
          Promise.resolve(GM.cookie.list(details))
            .then((cookies) => resolve(Array.isArray(cookies) ? cookies : null))
            .catch((e) => {
              dbg('GM.cookie.list 错误：', e);
              resolve(null);
            });
          return;
        }
      } catch (e) {
        dbg('GM.cookie 调用异常：', e);
      }

      resolve(null);
    });
  }

  async function collectCookies() {
    let cookies = await gmCookieList({ url: location.href });
    let source = 'GM_cookie(url)';

    if (!cookies) {
      cookies = await gmCookieList({ domain: location.hostname });
      source = 'GM_cookie(domain)';
    }
    if (!cookies) {
      cookies = parseDocumentCookie();
      source = 'document.cookie';
    }
    dbg(`采集 Cookie：来源=${source}，数量=${(cookies || []).length}`);
    return { source, cookies: cookies || [] };
  }

  // ---------------------------------------------------------------------------
  // 通用发送
  // ---------------------------------------------------------------------------
  function postJson(url, payload) {
    return new Promise((resolve) => {
      const { authToken } = getCfg();
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['X-Auth-Token'] = authToken;

      dbg('POST', url, payload);

      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers,
        data: JSON.stringify(payload),
        timeout: 15000,
        onload: (res) => {
          const ok = res.status >= 200 && res.status < 300;
          dbg('响应', res.status, String(res.responseText).slice(0, 200));
          resolve({
            ok,
            status: res.status,
            message: ok ? null : `服务器返回 ${res.status}：${String(res.responseText).slice(0, 200)}`,
          });
        },
        onerror: (e) => {
          dbg('请求错误', e);
          resolve({ ok: false, message: '网络错误，无法连接服务器' });
        },
        ontimeout: () => resolve({ ok: false, message: '请求超时' }),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 页面级提示浮层（toast） —— 保证任何操作都有可见反馈
  // ---------------------------------------------------------------------------
  let toastRoot = null;
  let toastHostEl = null;

  function ensureToastRoot() {
    if (toastRoot && toastHostEl && document.body.contains(toastHostEl)) return toastRoot;
    const h = document.createElement('div');
    h.id = 'cookie-sync-toast-host';
    h.style.cssText =
      'position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);pointer-events:none;';
    document.body.appendChild(h);
    const root = h.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { display: flex; flex-direction: column; gap: 8px; align-items: center; }
        .t {
          max-width: 80vw; padding: 10px 16px; border-radius: 10px; font-size: 13px; line-height: 1.5;
          font-family: system-ui, "Microsoft YaHei", sans-serif; color: #f1f5f9;
          background: #1e293b; border: 1px solid #334155; border-left: 4px solid #64748b;
          box-shadow: 0 8px 24px rgba(0,0,0,.45);
          transition: opacity .25s ease, transform .25s ease;
        }
        .t.ok { border-left-color: #22c55e; }
        .t.err { border-left-color: #ef4444; }
        .t.info { border-left-color: #3b82f6; }
      </style>
      <div class="wrap"></div>
    `;
    // 注意：ShadowRoot.host 是只读属性，不能赋值，必须另存元素引用
    toastHostEl = h;
    toastRoot = root;
    return root;
  }

  function toast(msg, type = 'info', timeout = 3800) {
    try {
      const root = ensureToastRoot();
      const wrap = root.querySelector('.wrap');
      const el = document.createElement('div');
      el.className = 't ' + type;
      el.textContent = msg;
      wrap.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(-8px)';
        setTimeout(() => el.remove(), 260);
      }, timeout);
      dbg('toast:', type, msg);
    } catch (e) {
      dbg('toast 渲染失败：', e);
    }
  }

  // ---------------------------------------------------------------------------
  // 功能一：Cookie 导出
  // ---------------------------------------------------------------------------
  function buildCookiePayload(source, cookies) {
    return {
      site: location.hostname,
      url: location.href,
      title: document.title,
      source,
      ua: navigator.userAgent,
      exportedAt: new Date().toISOString(),
      count: cookies.length,
      cookies,
    };
  }

  async function runExport({ silent = false } = {}) {
    try {
      const { serverUrl } = getCfg();
      if (!serverUrl) {
        const msg = '未配置服务器地址：请点 🍪 → 「Cookie 同步」→ 填写地址并点「保存配置」';
        log(msg, false);
        toast(msg, 'err');
        return { ok: false, message: msg };
      }

      toast('正在导出当前站点 Cookie…', 'info', 1500);
      const { source, cookies } = await collectCookies();
      const payload = buildCookiePayload(source, cookies);
      const res = await postJson(serverUrl, payload);

      const message = res.ok ? `已上传 ${payload.count} 条 Cookie（${source}）` : res.message;
      const result = { ok: res.ok, message };

      GM_setValue(K.lastResult, JSON.stringify({ at: payload.exportedAt, ...result }));
      log(silent ? `[自动] ${message}` : message, result.ok);
      if (!silent) toast(message, result.ok ? 'ok' : 'err');

      return result;
    } catch (err) {
      dbg('导出异常：', err);
      const msg = '导出出错：' + (err && err.message ? err.message : String(err));
      log(msg, false);
      toast(msg, 'err');
      return { ok: false, message: msg };
    }
  }

  // ---------------------------------------------------------------------------
  // 功能二：个人凭据保险箱
  // ---------------------------------------------------------------------------
  function getVault() {
    try {
      const raw = GM_getValue(K.vault, '');
      if (!raw) return {};
      return JSON.parse(b64dec(raw)) || {};
    } catch (e) {
      return {};
    }
  }

  function setVault(vault) {
    GM_setValue(K.vault, b64enc(JSON.stringify(vault)));
  }

  function saveCredential(host, { username, password, note }) {
    const vault = getVault();
    const list = vault[host] || [];
    const idx = list.findIndex((x) => x.username === username);
    const entry = { username, password, note: note || '', updatedAt: new Date().toISOString() };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    vault[host] = list;
    setVault(vault);
    return entry;
  }

  function deleteCredential(host, username) {
    const vault = getVault();
    if (!vault[host]) return;
    vault[host] = vault[host].filter((x) => x.username !== username);
    if (!vault[host].length) delete vault[host];
    setVault(vault);
  }

  function setNativeValue(el, value) {
    try {
      const desc = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const isVisible = (el) => !!(el && el.offsetParent !== null);

  function fillLoginForm(username, password) {
    const pwd = Array.from(document.querySelectorAll('input[type=password]')).find(isVisible) || null;
    let user = null;

    if (pwd) {
      const all = Array.from(document.querySelectorAll('input'));
      const i = all.indexOf(pwd);
      for (let k = i - 1; k >= 0; k--) {
        const t = all[k];
        if (isVisible(t) && /^(text|email|tel|search|)$/i.test(t.type)) {
          user = t;
          break;
        }
      }
    }
    if (!user) {
      user =
        Array.from(document.querySelectorAll('input[type=text], input[type=email]')).find(isVisible) || null;
    }

    if (user) setNativeValue(user, username);
    if (pwd) setNativeValue(pwd, password);

    return { user: !!user, pwd: !!pwd };
  }

  // ---------------------------------------------------------------------------
  // 浮漂 + 面板 UI（Shadow DOM，可拖拽）
  // ---------------------------------------------------------------------------
  let logEl = null;
  let refreshVaultList = () => {};
  let hostEl = null; // 浮漂宿主元素
  let panelEl = null; // 面板元素
  let forceShown = false; // 浮漂已关闭时，通过菜单临时显示

  /** 依据「显示浮漂」开关应用可见性；关闭后仍可用油猴菜单打开面板 */
  function applyFloatVisibility() {
    if (!hostEl) return;
    const enabled = GM_getValue(K.showFloat, true);
    hostEl.style.display = enabled || forceShown ? '' : 'none';
    // 同步面板里的开关状态（例如通过菜单切换时）
    const chk = panelEl && panelEl.querySelector('#showfloat');
    if (chk) chk.checked = enabled;
  }

  function log(msg, ok) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    line.style.cssText =
      'padding:2px 0;color:' + (ok === false ? '#ff6b6b' : ok === true ? '#4ade80' : '#cbd5e1') + ';';
    logEl.prepend(line);
    while (logEl.childNodes.length > 30) logEl.removeChild(logEl.lastChild);
  }

  function loadPos() {
    try {
      const p = JSON.parse(GM_getValue(K.pos, 'null'));
      if (p && typeof p.left === 'number' && typeof p.top === 'number') {
        return {
          left: Math.min(Math.max(0, p.left), window.innerWidth - 44),
          top: Math.min(Math.max(0, p.top), window.innerHeight - 44),
        };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function mountUI() {
    if (document.getElementById('cookie-sync-host')) return; // 防止重复挂载

    const host = document.createElement('div');
    host.id = 'cookie-sync-host';
    const pos = loadPos();
    host.style.cssText =
      'position:fixed;z-index:2147483647;width:44px;height:44px;' +
      (pos ? `left:${pos.left}px;top:${pos.top}px;` : 'right:16px;bottom:16px;');
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    const cfg = getCfg();

    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, "Microsoft YaHei", sans-serif; }
        .btn {
          width: 44px; height: 44px; border-radius: 50%; border: none; cursor: grab;
          background: #2563eb; color: #fff; font-size: 20px; line-height: 44px; text-align: center;
          box-shadow: 0 4px 12px rgba(0,0,0,.35); user-select: none; touch-action: none;
        }
        .btn:hover { background: #1d4ed8; }
        .btn:active { cursor: grabbing; }
        .panel {
          display: none; position: absolute; right: 0; bottom: 52px; width: 340px;
          max-height: 82vh; overflow: auto;
          background: #1e293b; color: #e2e8f0;
          border: 1px solid #334155; border-radius: 12px; padding: 14px;
          box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px;
        }
        .panel.open { display: block; }
        .tabs { display: flex; gap: 6px; margin-bottom: 12px; }
        .tabs button {
          flex: 1; padding: 7px; border-radius: 8px; border: 1px solid #334155;
          background: #0f172a; color: #94a3b8; cursor: pointer; font-size: 12px;
        }
        .tabs button.active { background: #2563eb; border-color: #2563eb; color: #fff; }
        .tab { display: none; }
        .tab.active { display: block; }
        label { display: block; margin: 8px 0 3px; color: #94a3b8; font-size: 12px; }
        input[type=text], input[type=password] {
          width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid #334155;
          background: #0f172a; color: #e2e8f0; font-size: 12px;
        }
        .row { display: flex; gap: 8px; margin-top: 12px; }
        .row button {
          flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #334155;
          background: #0f172a; color: #e2e8f0; cursor: pointer; font-size: 12px;
        }
        .row button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
        .row button:hover { filter: brightness(1.15); }
        .chk { display: flex; align-items: center; gap: 6px; margin-top: 10px; color: #cbd5e1; }
        .log {
          margin-top: 10px; max-height: 110px; overflow: auto; background: #0f172a;
          border: 1px solid #1e293b; border-radius: 6px; padding: 6px; font-size: 11px; line-height: 1.5;
        }
        .list { margin-top: 10px; border-top: 1px solid #334155; padding-top: 8px; }
        .item {
          display: flex; align-items: center; gap: 6px; padding: 5px 0; font-size: 12px;
          border-bottom: 1px dashed #334155;
        }
        .item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .item button {
          padding: 3px 8px; font-size: 11px; border-radius: 5px; cursor: pointer;
          border: 1px solid #334155; background: #0f172a; color: #e2e8f0;
        }
        .muted { color: #64748b; font-size: 11px; margin-top: 8px; line-height: 1.6; }
        .warn { color: #fbbf24; }

        /* 面板标题栏 + 关闭按钮 */
        .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .head h3 { margin: 0; font-size: 13px; font-weight: 600; color: #f8fafc; }
        .head .x {
          width: 22px; height: 22px; padding: 0; line-height: 20px; text-align: center;
          border-radius: 6px; border: 1px solid #334155; background: #0f172a;
          color: #94a3b8; cursor: pointer; font-size: 14px;
        }
        .head .x:hover { color: #fca5a5; border-color: #fca5a5; }

        /* 底部开关行 */
        .switch {
          display: flex; align-items: center; justify-content: space-between;
          margin-top: 14px; padding-top: 10px; border-top: 1px solid #334155;
          color: #cbd5e1; font-size: 12px;
        }
        .switch input { width: auto; margin: 0; accent-color: #2563eb; cursor: pointer; }
      </style>

      <button class="btn" title="Cookie Sync / 凭据保险箱（可拖动）">🍪</button>

      <div class="panel">
        <div class="head">
          <h3>Cookie Sync</h3>
          <button class="x" id="close" title="收起面板">×</button>
        </div>

        <div class="tabs">
          <button data-tab="cookie" class="active">Cookie 同步</button>
          <button data-tab="vault">我的凭据</button>
        </div>

        <div class="tab active" data-tab="cookie">
          <label>服务器接口地址（POST）</label>
          <input type="text" id="url" placeholder="http://127.0.0.1:8787/api/cookies" value="${cfg.serverUrl}">

          <label>鉴权令牌 X-Auth-Token（可选）</label>
          <input type="password" id="token" placeholder="留空则不带令牌" value="${cfg.authToken}">

          <label class="chk"><input type="checkbox" id="auto" ${cfg.autoExport ? 'checked' : ''}> 打开页面时自动导出当前站点</label>

          <div class="row">
            <button class="primary" id="now">立即导出</button>
            <button id="save">保存配置</button>
          </div>

          <div class="log" id="log"></div>
          <div class="muted">当前站点：${location.hostname}</div>
        </div>

        <div class="tab" data-tab="vault">
          <div class="muted" style="margin-top:0">
            仅用于保存<b>你自己账号</b>的凭据。内容以混淆形式存于本机油猴存储，非强加密。
          </div>

          <label>网站（默认当前站点）</label>
          <input type="text" id="v-host" value="${location.hostname}">

          <label>账号 / 用户名</label>
          <input type="text" id="v-user" placeholder="your@account">

          <label>密码</label>
          <input type="password" id="v-pass" placeholder="你的密码">

          <label>备注（可选）</label>
          <input type="text" id="v-note" placeholder="例如：主号 / 备用">

          <div class="row">
            <button class="primary" id="v-save">保存到本地</button>
            <button id="v-upload">上传到服务器</button>
          </div>

          <div class="list" id="v-list"></div>
          <div class="muted warn">上传使用「Cookie 同步」标签页里的服务器地址与令牌；建议仅走 HTTPS。</div>
        </div>

        <label class="switch">
          <span>在页面显示浮漂</span>
          <input type="checkbox" id="showfloat" ${GM_getValue(K.showFloat, true) ? 'checked' : ''}>
        </label>
      </div>
    `;

    const btn = root.querySelector('.btn');
    const panel = root.querySelector('.panel');
    logEl = root.querySelector('#log');
    hostEl = host;
    panelEl = panel;

    // ---- 收起面板（× 按钮）----
    root.querySelector('#close').addEventListener('click', () => {
      panel.classList.remove('open');
      forceShown = false;
      applyFloatVisibility();
    });

    // ---- 「在页面显示浮漂」开关 ----
    const floatChk = root.querySelector('#showfloat');
    floatChk.addEventListener('change', () => {
      GM_setValue(K.showFloat, floatChk.checked);
      forceShown = false;
      applyFloatVisibility();
      toast(
        floatChk.checked ? '已显示浮漂' : '已隐藏浮漂（可用油猴菜单「打开面板」再次打开）',
        'ok'
      );
    });

    // 应用初始可见性（重启页面后开关依然生效）
    applyFloatVisibility();

    // ---- 拖拽 + 点击开合 ----
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    btn.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = host.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = startLeft + 'px';
      host.style.top = startTop + 'px';
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    btn.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const left = Math.min(Math.max(0, startLeft + dx), window.innerWidth - 44);
      const top = Math.min(Math.max(0, startTop + dy), window.innerHeight - 44);
      host.style.left = left + 'px';
      host.style.top = top + 'px';
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (moved) {
        GM_setValue(
          K.pos,
          JSON.stringify({ left: parseFloat(host.style.left), top: parseFloat(host.style.top) })
        );
      } else {
        panel.classList.toggle('open');
      }
    };
    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);

    // ---- 标签切换 ----
    root.querySelectorAll('.tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        root.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
        root.querySelectorAll('.tab').forEach((t) =>
          t.classList.toggle('active', t.dataset.tab === b.dataset.tab)
        );
      });
    });

    // ---- Cookie 标签 ----
    root.querySelector('#save').addEventListener('click', () => {
      GM_setValue(K.serverUrl, root.querySelector('#url').value.trim());
      GM_setValue(K.authToken, root.querySelector('#token').value.trim());
      GM_setValue(K.autoExport, root.querySelector('#auto').checked);
      log('配置已保存', true);
      toast('配置已保存', 'ok');
    });

    root.querySelector('#now').addEventListener('click', () => {
      log('开始导出…');
      runExport({ silent: false });
    });

    // ---- 凭据标签 ----
    const vaultInputs = () => ({
      host: root.querySelector('#v-host').value.trim() || location.hostname,
      username: root.querySelector('#v-user').value.trim(),
      password: root.querySelector('#v-pass').value,
      note: root.querySelector('#v-note').value.trim(),
    });

    root.querySelector('#v-save').addEventListener('click', () => {
      const { host, username, password, note } = vaultInputs();
      if (!username || !password) {
        log('账号和密码不能为空', false);
        toast('账号和密码不能为空', 'err');
        return;
      }
      saveCredential(host, { username, password, note });
      root.querySelector('#v-pass').value = '';
      log(`已保存本地凭据：${username} @ ${host}`, true);
      toast(`已保存本地凭据：${username}`, 'ok');
      refreshVaultList();
    });

    root.querySelector('#v-upload').addEventListener('click', async () => {
      const { host, username, password, note } = vaultInputs();
      if (!username || !password) {
        toast('账号和密码不能为空', 'err');
        return;
      }
      const { serverUrl } = getCfg();
      if (!serverUrl) {
        toast('未配置服务器地址（见 Cookie 标签页）', 'err');
        return;
      }
      const credUrl = serverUrl.replace(/\/api\/cookies\/?$/, '/api/credentials');
      const res = await postJson(credUrl, {
        site: host,
        username,
        password,
        note,
        exportedAt: new Date().toISOString(),
      });
      const msg = res.ok ? `已上传凭据 ${username} @ ${host}` : res.message;
      log(msg, res.ok);
      toast(msg, res.ok ? 'ok' : 'err');
    });

    function renderList() {
      const host = root.querySelector('#v-host').value.trim() || location.hostname;
      const listEl = root.querySelector('#v-list');
      const list = getVault()[host] || [];
      listEl.innerHTML = '';

      if (!list.length) {
        listEl.innerHTML = '<div class="muted">该站点暂无已保存凭据</div>';
        return;
      }

      list.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'item';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = entry.username + (entry.note ? `（${entry.note}）` : '');

        const fillBtn = document.createElement('button');
        fillBtn.textContent = '填入';
        fillBtn.addEventListener('click', () => {
          const r = fillLoginForm(entry.username, entry.password);
          const ok = r.pwd || r.user;
          const msg = ok
            ? `已填入表单（账号:${r.user ? '✓' : '✗'} 密码:${r.pwd ? '✓' : '✗'}），请自行点击登录`
            : '未在当前页面找到登录输入框';
          log(msg, ok);
          toast(msg, ok ? 'ok' : 'err');
        });

        const delBtn = document.createElement('button');
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
          deleteCredential(host, entry.username);
          log(`已删除凭据：${entry.username}`, true);
          toast(`已删除凭据：${entry.username}`, 'ok');
          refreshVaultList();
        });

        row.append(name, fillBtn, delBtn);
        listEl.appendChild(row);
      });
    }

    refreshVaultList = renderList;
    root.querySelector('#v-host').addEventListener('input', renderList);
    renderList();

    try {
      const last = JSON.parse(GM_getValue(K.lastResult, 'null'));
      if (last) log(`上次：${last.message}`, last.ok);
    } catch (e) {
      /* ignore */
    }

    dbg('面板已挂载，浮漂位置：', pos || '默认右下角');

    if (cfg.autoExport && cfg.serverUrl) {
      setTimeout(() => runExport({ silent: true }), 1500);
    }
  }

  // ---------------------------------------------------------------------------
  // 菜单命令
  // ---------------------------------------------------------------------------
  GM_registerMenuCommand('🍪 立即导出当前站点 Cookie', () => runExport({ silent: false }));
  GM_registerMenuCommand('🔑 填入我的登录凭据', () => {
    const host = location.hostname;
    const list = getVault()[host] || [];
    if (!list.length) {
      toast(`当前站点（${host}）没有已保存的凭据`, 'err');
      return;
    }
    const r = fillLoginForm(list[0].username, list[0].password);
    toast(r.pwd || r.user ? '已填入登录表单，请自行点击登录' : '未找到登录输入框', r.pwd || r.user ? 'ok' : 'err');
  });
  GM_registerMenuCommand('⚙️ 打开面板', () => {
    if (!hostEl || !panelEl) {
      toast('面板尚未挂载，请刷新页面', 'err');
      return;
    }
    forceShown = true; // 浮漂已关闭时也能打开面板
    applyFloatVisibility();
    panelEl.classList.add('open');
  });

  GM_registerMenuCommand('🫥 显示 / 隐藏浮漂', () => {
    const next = !GM_getValue(K.showFloat, true);
    GM_setValue(K.showFloat, next);
    forceShown = false;
    applyFloatVisibility();
    toast(next ? '已显示浮漂' : '已隐藏浮漂', 'ok');
  });

  // ---------------------------------------------------------------------------
  // 启动（含 body 出现前的等待与重试）
  // ---------------------------------------------------------------------------
  function boot() {
    try {
      if (window.top !== window.self) return; // 只在顶层文档运行
      dbg(
        `启动：GM_cookie=${typeof GM_cookie !== 'undefined'}，GM.cookie=${
          typeof GM !== 'undefined' && !!GM.cookie
        }`
      );

      if (!document.body) {
        window.addEventListener('DOMContentLoaded', boot, { once: true });
        return;
      }
      mountUI();
    } catch (err) {
      dbg('启动失败：', err);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 部分 SPA 会替换 body，挂载点丢失时补挂
  setInterval(() => {
    if (window.top !== window.self) return;
    if (document.body && !document.getElementById('cookie-sync-host')) {
      try {
        logEl = null;
        forceShown = false;
        mountUI();
      } catch (e) {
        /* ignore */
      }
    }
  }, 3000);
})();
