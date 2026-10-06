# Cookie Sync · Cookie 同步 & 个人凭据保险箱

读取浏览器「本地 Cookie / 当前网站 Cookie」，并通过油猴脚本推送到你**自建服务器**；
同时提供一个**个人凭据保险箱**，保存并一键填入**你自己账号**的登录凭据。

> ⚠️ **合规边界（务必遵守）**
> 本工具仅用于处理**你自己**的数据：导出**你自己账号**在**你自己设备**上的 Cookie，
> 或保存**你自己**的登录凭据。
> **不得**改写为在第三方页面收集**他人**输入的账号密码，不得伪装成目标网站的登录框。
> 这类「收集他人凭据」的行为属于钓鱼，违法，本项目不提供该能力。

---

## 目录结构

```
cookie-sync/
├── cookie-sync.user.js      # 油猴脚本（Tampermonkey / Violentmonkey）
├── server/
│   ├── receiver.js          # 零依赖接收端（Node.js 原生 http）
│   ├── package.json
│   └── data/                # 接收到的 Cookie 落盘目录（自动生成）
└── README.md
```

---

## 工作流程

```
浏览器页面                     油猴脚本                      你的服务器
  │  GM_cookie.list()            │                              │
  │ ─────── Cookie 列表 ───────► │                              │
  │  （读不到则回退 document.cookie）                             │
  │                              │  POST /api/cookies           │
  │                              │  X-Auth-Token: ***           │
  │                              │ ───────────────────────────► │
  │                              │        200 {ok:true}         │
  │                              │ ◄─────────────────────────── │
```

---

## 一、启动服务器

需要 Node.js（≥16，无需任何第三方依赖）。

```bash
cd cookie-sync/server

# 默认端口 8787，无令牌
node receiver.js

# 启用令牌 + 自定义端口（推荐）
# Linux / macOS
PORT=9000 TOKEN=mysecret node receiver.js
# Windows CMD
set PORT=9000&& set TOKEN=mysecret&& node receiver.js
# Windows PowerShell
$env:PORT=9000; $env:TOKEN="mysecret"; node receiver.js
```

启动后输出：

```
Cookie Sync 接收端已启动
  监听地址 : http://0.0.0.0:8787
  油猴填入 : http://<你的服务器IP>:8787/api/cookies
  鉴权令牌 : 已启用（X-Auth-Token）
  数据目录 : .../server/data
```

**部署到远程服务器时**，记得在云厂商安全组 / 防火墙上放行对应端口，
并建议用 Nginx 反代 + HTTPS（浏览器会拦截部分混合内容请求）。

接口一览：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ping` | 健康检查，返回 `{ok:true}` |
| POST | `/api/cookies` | 接收 Cookie；设置 `TOKEN` 后需带 `X-Auth-Token` |
| POST | `/api/credentials` | 接收「你本人账号」凭据（`site`/`username`/`password`），同样需令牌 |

落盘文件（`server/data/`）：

- `cookies-<host>-<时间戳>.json` —— 每次导出的快照
- `latest-<host>.json` —— 该站点最新一份
- `cookies.jsonl` —— 追加式日志（每行一条 JSON）
- `credentials-<host>.json` —— 凭据文件（**明文保存**，按账号归并）

---

## 二、安装油猴脚本

1. 浏览器安装 **Tampermonkey**（或 Violentmonkey）。
2. 新建脚本，把 `cookie-sync.user.js` 全文粘贴进去，保存。
3. 打开任意网站，右下角出现 🍪 悬浮按钮即为成功。

---

## 三、配置与使用

点右下角 🍪 打开面板：

| 项 | 说明 |
| --- | --- |
| **服务器接口地址** | 填 `http://<你的服务器IP>:<端口>/api/cookies`。本机测试填 `http://127.0.0.1:8787/api/cookies` |
| **鉴权令牌** | 与服务端启动时的 `TOKEN` 一致；留空表示不带令牌 |
| **自动导出** | 勾选后每次打开页面自动推送当前站点 Cookie |

操作：

- **立即导出** —— 采集当前站点 Cookie 并推送，面板底部显示日志。
- **保存配置** —— 写入油猴存储（`GM_setValue`），下次打开自动生效。

也可以通过 Tampermonkey 菜单命令触发：

- `🍪 立即导出当前站点 Cookie`
- `⚙️ 打开配置面板`

---

## 四、Cookie 读取说明

脚本按以下顺序尝试，取到即止：

1. `GM_cookie.list({ url })` —— 读取**当前网站**全部 Cookie（可含 HttpOnly），首次使用 Tampermonkey 会弹窗请求授权；
2. `GM_cookie.list({ domain })` —— 按域名兜底；
3. `document.cookie` —— 最后回退，**读不到 HttpOnly Cookie**。

因此：

- 想导出**登录态等 HttpOnly Cookie**，必须允许 Tampermonkey 的 `GM_cookie` 权限；
- 若只显示少量 Cookie，通常是权限未授予或该站 Cookie 多为 HttpOnly。

推送的 payload 结构：

```json
{
  "site": "example.com",
  "url": "https://example.com/page",
  "title": "页面标题",
  "source": "GM_cookie(url)",
  "ua": "Mozilla/5.0 ...",
  "exportedAt": "2026-10-06T05:56:24.000Z",
  "count": 3,
  "cookies": [
    { "name": "session", "value": "...", "domain": "example.com", "path": "/", "httpOnly": true }
  ]
}
```

---

## 五、个人凭据保险箱（「我的凭据」标签页）

用于保存**你自己账号**的登录凭据，并在需要时一键填入当前页面的登录表单。

**操作流程**

1. 打开面板 → 切到「我的凭据」标签；
2. 填 **网站**（默认当前域名）、**账号**、**密码**、备注（可选）；
3. 点 **保存到本地** —— 写入本机油猴存储（Base64 混淆，非强加密）；
4. 点 **上传到服务器** —— 推送到 `/api/credentials`（复用 Cookie 标签页里的地址与令牌）；
5. 在已存列表里点 **填入**（或菜单命令 `🔑 填入我的登录凭据`）—— 脚本会在当前页面定位
   登录输入框并填入，**不会自动提交**，由你手动点登录；
6. 点 **删除** 移除某条凭据。

**它做什么 / 不做什么**

| 会做 | 不会做 |
| --- | --- |
| 保存你自己填写的凭据 | 收集页面上他人输入的凭据 |
| 你点按钮后填入当前页面的登录框 | 后台静默抓取表单 |
| 上传到你自己的鉴权服务器 | 伪装成目标网站自己的登录框 |

**安全提示**

- 本地存储为「防窥」级别，别在公共/共享电脑使用；
- 服务端 `credentials-*.json` 是**明文**，务必启用 `TOKEN` + HTTPS，且不要暴露公网；
- 更稳妥的替代：只用「保存到本地 + 填入」，不上传服务器。

---

## 六、常见问题

**Q：面板显示「未配置服务器地址」？**
A：先在面板填写地址并点「保存配置」。

**Q：推送失败 / 网络错误？**
A：①确认服务端已启动；②端口已放行；③地址拼写正确（注意结尾路径 `/api/cookies`）；
④若服务器返回 401，说明 `TOKEN` 与面板中令牌不一致。

**Q：为什么自动导出没触发？**
A：需同时满足「已勾选自动导出」且「已填写服务器地址」，并在页面加载约 1.5s 后推送。

**Q：如何只对特定网站生效？**
A：把脚本头部 `@match *://*/*` 改成具体站点，例如 `@match https://example.com/*`，
这样脚本只在指定站点注入，更安全。

**Q：点「立即导出」好像没反应？**
A：v1.2.0 起每次操作都会在**页面顶部弹出提示**（成功为绿色、失败为红色），不再只写在面板小日志里。若确实没有任何提示：
①按 `F12` 打开控制台，过滤 `[Cookie Sync]` 看日志；
②最常见原因是**还没配置服务器地址**——此时会弹红色提示「未配置服务器地址」；
③确认脚本已在油猴里启用、且当前页面是顶层文档（脚本 `@noframes`，不在子 iframe 里跑）。

**Q：浮漂能拖动吗？位置会记住吗？**
A：可以。按住 🍪 拖动即可移动，松手后位置会保存，下次打开还在原处；轻点（不拖动）则开合面板。

**Q：为什么提示里显示 `document.cookie` 而不是 `GM_cookie`？**
A：说明 Tampermonkey 的 `GM_cookie` 未授权，脚本自动回退到 `document.cookie`，此时读不到 HttpOnly Cookie。到油猴设置里允许该权限即可。

---

## 七、调试与自测（开发用）

`_test/harness.html` 是一个**本地测试台**：它用桩函数模拟油猴 API
（`GM_getValue` / `GM_setValue` / `GM_xmlhttpRequest` 等），不装油猴也能验证界面与交互。

```bash
cd cookie-sync
python -m http.server 8899
# 浏览器打开：
#   http://127.0.0.1:8899/_test/harness.html            （只看浮漂与面板）
#   http://127.0.0.1:8899/_test/harness.html?auto=1     （自动点开面板并导出）
#   http://127.0.0.1:8899/_test/harness.html?auto=1&nourl=1  （验证未配置地址的报错）
#   http://127.0.0.1:8899/_test/harness.html?drag=1     （验证拖拽）
```

`_test/preview-*.png` 是自测截图留档。

---

## 八、安全建议

- 服务端**务必设置 `TOKEN`**，否则任何知道地址的人都能往你的服务器写数据；
- 优先用 HTTPS 传输；
- `data/` 目录含有凭据，切勿提交到公开仓库（建议 `.gitignore` 忽略）；
- 定期清理历史快照。
