'use strict';

/**
 * cookie-sync.user.js 离线测试：node:vm 沙箱 + 油猴 API 桩 + 极简假 DOM。
 * 不访问网络，不依赖浏览器或第三方包。
 *
 *   node --test _test/userscript.test.js
 *   （server 的 npm test 也会一起跑它）
 *
 * 覆盖：
 *   H1 面板 / toast 使用 closed shadowRoot；令牌不回显到 DOM（留空保留旧值）；
 *      非 isTrusted 事件一律忽略；「填入」只允许当前站点的凭据。
 *   H2 导出按 Cookie 域匹配规则过滤；父域查询不越过注册域（github.io、com.cn 等）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const SCRIPT_PATH = path.join(__dirname, '..', 'cookie-sync.user.js');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 极简假 DOM（只实现脚本用到的部分）
// ---------------------------------------------------------------------------
class FakeEvent {
  constructor(type, opts) {
    this.type = type;
    this.bubbles = !!(opts && opts.bubbles);
    this.isTrusted = false; // 页面脚本构造的事件永远是 false
  }
}

function makeClassList(el) {
  const get = () => (el.className ? el.className.split(/\s+/).filter(Boolean) : []);
  const set = (arr) => {
    el.className = arr.join(' ');
  };
  return {
    add: (c) => set(Array.from(new Set([...get(), c]))),
    remove: (c) => set(get().filter((x) => x !== c)),
    contains: (c) => get().includes(c),
    toggle: (c, force) => {
      const has = get().includes(c);
      const want = force === undefined ? !has : !!force;
      if (want && !has) set([...get(), c]);
      if (!want && has) set(get().filter((x) => x !== c));
      return want;
    },
  };
}

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c);
  }
  prepend(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.unshift(c);
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '') this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatchEvent(ev) {
    for (let n = this; n; n = ev.bubbles ? n.parentNode || n.host || null : null) {
      for (const fn of n.listeners[ev.type] || []) fn.call(n, ev);
      if (!ev.bubbles) break;
    }
    return true;
  }
  *descendants() {
    for (const c of this.childNodes) {
      if (c instanceof FakeElement) {
        yield c;
        yield* c.descendants();
      }
    }
  }
  querySelectorAll(sel) {
    const groups = sel.split(',').map((s) => s.trim().split(/\s+/).map(parseCompound));
    const out = [];
    for (const el of this.descendants()) {
      if (groups.some((g) => matchChain(el, g, this))) out.push(el);
    }
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

function parseCompound(s) {
  const m = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)=([^\]]+)\]/g;
  let r;
  while ((r = re.exec(s))) {
    if (r[1]) m.tag = r[1].toUpperCase();
    else if (r[2]) m.id = r[2];
    else if (r[3]) m.classes.push(r[3]);
    else if (r[4]) m.attrs.push([r[4], r[5].replace(/^["']|["']$/g, '')]);
  }
  return m;
}

function matchCompound(el, m) {
  if (m.tag && el.tagName !== m.tag) return false;
  if (m.id && el.getAttribute('id') !== m.id) return false;
  for (const c of m.classes) if (!el.classList.contains(c)) return false;
  for (const [k, v] of m.attrs) {
    const actual = k === 'type' ? el.type : el.getAttribute(k);
    if (actual !== v) return false;
  }
  return true;
}

function matchChain(el, chain, scope) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let p = el.parentNode; p && p !== scope && i >= 0; p = p.parentNode) {
    if (p instanceof FakeElement && matchCompound(p, chain[i])) i--;
  }
  return i < 0;
}

class FakeText extends FakeNode {
  constructor(doc, text) {
    super(doc);
    this.data = text;
  }
  get textContent() {
    return this.data;
  }
}

class FakeShadowRoot extends FakeNode {
  constructor(doc, host, mode) {
    super(doc);
    this.host = host;
    this.mode = mode;
  }
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.className = '';
    this.style = { cssText: '' };
    this.classList = makeClassList(this);
    this._shadow = null;
    this._value = undefined;
    this._checked = undefined;
    this.disabled = false;
    this.title = '';
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }
  get type() {
    return (this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : '')).toLowerCase();
  }
  get value() {
    if (this._value !== undefined) return this._value;
    return this.getAttribute('value') || '';
  }
  set value(v) {
    this._value = String(v);
  }
  get checked() {
    if (this._checked !== undefined) return this._checked;
    return this.getAttribute('checked') !== null;
  }
  set checked(v) {
    this._checked = !!v;
  }
  get placeholder() {
    return this.getAttribute('placeholder') || '';
  }
  set placeholder(v) {
    this.setAttribute('placeholder', v);
  }
  get dataset() {
    const ds = {};
    for (const k of Object.keys(this.attributes)) {
      if (k.startsWith('data-')) ds[k.slice(5)] = this.attributes[k];
    }
    return ds;
  }
  get offsetParent() {
    // 在文档里且未隐藏即视为可见
    return this.ownerDocument.body.contains(this) ? this.ownerDocument.body : null;
  }
  get shadowRoot() {
    return this._shadow && this._shadow.mode === 'open' ? this._shadow : null;
  }
  attachShadow({ mode }) {
    this._shadow = new FakeShadowRoot(this.ownerDocument, this, mode);
    this.ownerDocument.shadowLog.push({ host: this, mode, root: this._shadow });
    return this._shadow;
  }
  getBoundingClientRect() {
    return { left: 100, top: 100, width: 44, height: 44 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  click() {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.readyState = 'complete';
    this.title = 'test page';
    this.cookie = '';
    this.shadowLog = [];
    this.body = this.createElement('body');
    this.appendChild(this.body);
  }
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  createTextNode(t) {
    return new FakeText(this, t);
  }
  getElementById(id) {
    for (const el of this.descendants()) if (el.getAttribute('id') === id) return el;
    return null;
  }
}

/** 真实用户事件（只有浏览器能产生 isTrusted=true；这里用普通对象模拟） */
function trustedEvent(type, extra) {
  return Object.assign({ type, isTrusted: true, bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }, extra);
}

function fire(el, ev) {
  el.dispatchEvent(ev);
}

/** 遍历文档 + 所有 shadow root，收集全部属性 / 文本 / value，用于检查令牌是否泄露到 DOM */
function allDomStrings(doc) {
  const out = [];
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c instanceof FakeText) out.push(c.data);
      if (c instanceof FakeElement) {
        out.push(...Object.values(c.attributes), c.value, c.className);
        if (c._shadow) walk(c._shadow);
        walk(c);
      }
    }
  };
  walk(doc);
  return out;
}

// ---------------------------------------------------------------------------
// 沙箱
// ---------------------------------------------------------------------------
function loadScript({ hostname = 'www.example.com', store = {}, cookies = [], fieldDocument } = {}) {
  const doc = new FakeDocument();
  if (fieldDocument) fieldDocument(doc);
  const timers = [];
  const xhrs = [];
  const cookieQueries = [];
  const menu = {};

  const location = {
    hostname,
    host: hostname,
    protocol: 'https:',
    href: `https://${hostname}/page`,
  };

  const GM_cookie = {
    list(details, cb) {
      cookieQueries.push(details);
      let out;
      if (details.url) {
        // 模拟浏览器：{url} 只返回会发给该 URL 的 Cookie（这里简单按域匹配 + path=/）
        out = cookies.filter((c) => {
          const d = String(c.domain || '').replace(/^\./, '');
          return (c.path || '/') === '/' && (c.hostOnly ? d === hostname : hostname === d || hostname.endsWith('.' + d));
        });
      } else {
        // 模拟浏览器：{domain: d} 返回 d 及其所有子域的 Cookie —— 包括兄弟子域
        out = cookies.filter((c) => {
          const d = String(c.domain || '').replace(/^\./, '');
          return d === details.domain || d.endsWith('.' + details.domain);
        });
      }
      cb(out.map((c) => ({ ...c })), null);
    },
    set(details, cb) {
      cb(null);
    },
  };

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
  };
  win.top = win;
  win.self = win;

  const ctx = {
    window: win,
    document: doc,
    location,
    navigator: { userAgent: 'node-test' },
    console: { log() {} },
    Event: FakeEvent,
    URL,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
    setInterval: () => 0,
    GM_getValue: (k, d) => (k in store ? store[k] : d),
    GM_setValue: (k, v) => {
      store[k] = v;
    },
    GM_deleteValue: (k) => {
      delete store[k];
    },
    GM_registerMenuCommand: (name, fn) => {
      menu[name] = fn;
    },
    GM_notification() {},
    GM_cookie,
    GM_xmlhttpRequest: (o) => {
      xhrs.push(o);
      o.onload({ status: 200, responseText: '{"ok":true}' });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx, { filename: 'cookie-sync.user.js' });

  const panel = doc.shadowLog.find((x) => x.host.getAttribute('id') === 'cookie-sync-host');
  return { doc, ctx, store, xhrs, cookieQueries, menu, timers, panel, root: panel && panel.root };
}

const tick = () => new Promise((r) => setImmediate(r));
async function exportVia(env) {
  env.menu['🍪 立即导出当前站点 Cookie']();
  for (let i = 0; i < 20 && !env.xhrs.length; i++) await tick();
  assert.equal(env.xhrs.length, 1, '应当发出一次上传请求');
  return JSON.parse(env.xhrs[0].data);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

// ---------------------------------------------------------------------------
// H1
// ---------------------------------------------------------------------------
test('H1: 面板与 toast 都使用 closed shadowRoot，页面拿不到 host.shadowRoot', async () => {
  const env = loadScript({ store: { cs_server_url: 'https://srv.local/api/cookies', cs_auth_token: 't' } });
  assert.ok(env.panel, '面板应已挂载');
  assert.equal(env.panel.mode, 'closed');
  assert.equal(env.doc.getElementById('cookie-sync-host').shadowRoot, null);

  // 触发一个 toast
  env.menu['🫥 显示 / 隐藏浮漂']();
  const toastHost = env.doc.shadowLog.find((x) => x.host.getAttribute('id') === 'cookie-sync-toast-host');
  assert.ok(toastHost, 'toast 应已挂载');
  assert.equal(toastHost.mode, 'closed');
  assert.equal(toastHost.host.shadowRoot, null);
  assert.ok(env.doc.shadowLog.every((x) => x.mode === 'closed'));
});

test('H1: 令牌不回显到 DOM；留空保存保留旧令牌，填写后才替换并立即清空输入框', async () => {
  const SECRET = 'super-secret-token-123';
  const env = loadScript({ store: { cs_server_url: 'https://srv.local/api/cookies', cs_auth_token: SECRET } });
  const tokenInput = env.root.querySelector('#token');
  assert.equal(tokenInput.type, 'password');
  assert.equal(tokenInput.value, '');
  assert.ok(!allDomStrings(env.doc).some((s) => String(s).includes(SECRET)), '令牌不应出现在任何 DOM 属性/文本/value 中');

  // 留空保存：保留旧值
  fire(env.root.querySelector('#save'), trustedEvent('click'));
  assert.equal(env.store.cs_auth_token, SECRET);

  // 填写新令牌保存：替换，且输入框被清空
  tokenInput.value = 'new-token-456';
  fire(env.root.querySelector('#save'), trustedEvent('click'));
  assert.equal(env.store.cs_auth_token, 'new-token-456');
  assert.equal(tokenInput.value, '');
  assert.ok(!allDomStrings(env.doc).some((s) => String(s).includes('new-token-456')));
});

test('H1: 非 isTrusted 事件（dispatchEvent / el.click()）被所有按钮忽略', async () => {
  const env = loadScript({
    hostname: 'evil.example',
    store: {
      cs_server_url: 'https://srv.local/api/cookies',
      cs_auth_token: 'old',
      cs_vault: b64({ 'evil.example': [{ username: 'me', password: 'pw' }] }),
    },
    fieldDocument: (doc) => {
      const p = doc.createElement('input');
      p.setAttribute('type', 'password');
      p.setAttribute('id', 'page-pwd');
      doc.body.appendChild(p);
    },
  });
  const r = env.root;

  // 即使页面拿到了 root（closed 模式下本拿不到），合成事件也不能驱动任何操作
  r.querySelector('#token').value = 'attacker';
  r.querySelector('#url').value = 'https://attacker.example/api/cookies';
  r.querySelector('#save').click();
  assert.equal(env.store.cs_auth_token, 'old');
  assert.equal(env.store.cs_server_url, 'https://srv.local/api/cookies');

  r.querySelector('#now').click();
  r.querySelector('#restore').click();
  r.querySelector('#v-upload').click();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(env.xhrs.length, 0, '合成点击不应触发任何网络请求');

  r.querySelector('#v-user').value = 'x';
  r.querySelector('#v-pass').value = 'y';
  r.querySelector('#v-save').click();
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(env.store.cs_vault, 'base64').toString())), ['evil.example']);

  const [fillBtn, delBtn] = r.querySelectorAll('#v-list button');
  fillBtn.click();
  assert.equal(env.doc.getElementById('page-pwd').value, '', '合成点击不应填入密码');
  delBtn.click();
  assert.match(Buffer.from(env.store.cs_vault, 'base64').toString(), /"me"/, '合成点击不应删除凭据');

  const panel = r.querySelector('.panel');
  r.querySelector('.btn').dispatchEvent(new FakeEvent('pointerdown'));
  r.querySelector('.btn').dispatchEvent(new FakeEvent('pointerup'));
  assert.equal(panel.classList.contains('open'), false, '合成 pointer 事件不应打开面板');

  const chk = r.querySelector('#showfloat');
  chk.checked = false;
  chk.dispatchEvent(new FakeEvent('change'));
  assert.equal(env.store.cs_show_float, undefined, '合成 change 不应改设置');
  assert.equal(chk.checked, true, '合成 change 造成的勾选应被回滚');

  // 对照组：真实点击可以工作
  fire(r.querySelector('#save'), trustedEvent('click'));
  assert.equal(env.store.cs_server_url, 'https://attacker.example/api/cookies');
});

test('H1: 「填入」只允许当前站点的凭据', async () => {
  const env = loadScript({
    hostname: 'evil.example',
    store: {
      cs_vault: b64({
        'bank.example': [{ username: 'alice', password: 'bank-pw' }],
        'evil.example': [{ username: 'me', password: 'own-pw' }],
      }),
    },
    fieldDocument: (doc) => {
      const u = doc.createElement('input');
      u.setAttribute('type', 'text');
      u.setAttribute('id', 'page-user');
      const p = doc.createElement('input');
      p.setAttribute('type', 'password');
      p.setAttribute('id', 'page-pwd');
      doc.body.append(u, p);
    },
  });
  const r = env.root;
  const pageUser = env.doc.getElementById('page-user');
  const pagePwd = env.doc.getElementById('page-pwd');

  // 切到别的站点（即使是真实用户输入），列表能看，但「填入」被禁用且点击无效
  const vHost = r.querySelector('#v-host');
  vHost.value = 'bank.example';
  fire(vHost, trustedEvent('input'));
  let fillBtn = r.querySelector('#v-list button');
  assert.equal(fillBtn.textContent, '填入');
  assert.equal(fillBtn.disabled, true);
  fire(fillBtn, trustedEvent('click'));
  assert.equal(pagePwd.value, '');
  assert.equal(pageUser.value, '');

  // 当前站点的凭据可以填入
  vHost.value = 'evil.example';
  fire(vHost, trustedEvent('input'));
  fillBtn = r.querySelector('#v-list button');
  assert.equal(fillBtn.disabled, false);
  fire(fillBtn, trustedEvent('click'));
  assert.equal(pageUser.value, 'me');
  assert.equal(pagePwd.value, 'own-pw');
});

// ---------------------------------------------------------------------------
// H2
// ---------------------------------------------------------------------------
test('H2: 导出按 Cookie 域匹配规则过滤兄弟子域与 hostOnly 父域 Cookie', async () => {
  const env = loadScript({
    hostname: 'www.test.example.com',
    store: { cs_server_url: 'https://srv.local/api/cookies', cs_auth_token: 't' },
    cookies: [
      { name: 'parent', value: '1', domain: '.example.com', path: '/', hostOnly: false },
      { name: 'mid', value: '2', domain: '.test.example.com', path: '/admin', hostOnly: false },
      { name: 'own_host', value: '3', domain: 'www.test.example.com', path: '/', hostOnly: true },
      { name: 'sibling', value: 'x', domain: '.other.example.com', path: '/', hostOnly: false },
      { name: 'sibling_host', value: 'x', domain: 'api.example.com', path: '/', hostOnly: true },
      { name: 'parent_hostonly', value: 'x', domain: 'example.com', path: '/', hostOnly: true },
      { name: 'mid_hostonly', value: 'x', domain: 'test.example.com', path: '/', hostOnly: true },
      { name: 'child', value: 'x', domain: 'a.www.test.example.com', path: '/', hostOnly: true },
    ],
  });
  const p = await exportVia(env);
  assert.deepEqual(p.cookies.map((c) => c.name).sort(), ['mid', 'own_host', 'parent']);
  assert.deepEqual(
    env.cookieQueries.filter((q) => q.domain).map((q) => q.domain),
    ['www.test.example.com', 'test.example.com', 'example.com']
  );
  assert.ok(p.sources.some((s) => /^filtered=\d+$/.test(s)));
});

test('H2: 父域查询不越过注册域（github.io / com.cn / co.uk）', async () => {
  const cases = [
    {
      hostname: 'alice.github.io',
      domains: ['alice.github.io'],
      cookies: [
        { name: 'mine', domain: 'alice.github.io', path: '/', hostOnly: true },
        { name: 'other_site', domain: 'bob.github.io', path: '/', hostOnly: true },
        { name: 'suffix_wide', domain: '.github.io', path: '/', hostOnly: false },
      ],
      keep: ['mine'],
    },
    {
      hostname: 'www.shop.com.cn',
      domains: ['www.shop.com.cn', 'shop.com.cn'],
      cookies: [
        { name: 'site', domain: '.shop.com.cn', path: '/', hostOnly: false },
        { name: 'other_site', domain: '.another.com.cn', path: '/', hostOnly: false },
        { name: 'suffix_wide', domain: '.com.cn', path: '/', hostOnly: false },
      ],
      keep: ['site'],
    },
    {
      hostname: 'a.b.example.co.uk',
      domains: ['a.b.example.co.uk', 'b.example.co.uk', 'example.co.uk'],
      cookies: [
        { name: 'site', domain: '.example.co.uk', path: '/', hostOnly: false },
        { name: 'suffix_wide', domain: '.co.uk', path: '/', hostOnly: false },
        { name: 'tld_wide', domain: '.uk', path: '/', hostOnly: false },
      ],
      keep: ['site'],
    },
  ];
  for (const c of cases) {
    const env = loadScript({
      hostname: c.hostname,
      store: { cs_server_url: 'https://srv.local/api/cookies', cs_auth_token: 't' },
      cookies: c.cookies.map((x) => ({ value: 'v', ...x })),
    });
    const p = await exportVia(env);
    assert.deepEqual(
      env.cookieQueries.filter((q) => q.domain).map((q) => q.domain),
      c.domains,
      `${c.hostname} 的父域查询`
    );
    assert.deepEqual(p.cookies.map((x) => x.name).sort(), c.keep, `${c.hostname} 导出的 Cookie`);
  }
});

test('H2: IP 主机不做父域查询，只导出精确匹配的 Cookie', async () => {
  const env = loadScript({
    hostname: '192.168.1.10',
    store: { cs_server_url: 'https://srv.local/api/cookies', cs_auth_token: 't' },
    cookies: [{ name: 'ip', value: 'v', domain: '192.168.1.10', path: '/', hostOnly: true }],
  });
  const p = await exportVia(env);
  assert.equal(env.cookieQueries.filter((q) => q.domain).length, 0);
  assert.deepEqual(p.cookies.map((x) => x.name), ['ip']);
});
