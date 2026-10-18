---
name: "muse-cookies-sync"
description: "安装、部署、配置和维护 Muse Cookie Sync：用油猴脚本读取当前网站 Cookie，上传到自建 Node.js 接收端，并在自己的另一台设备上手动拉取和恢复；附带保存并填入本人账号凭据的个人凭据保险箱。适用于用户询问 Cookie 跨设备同步、接收端部署或该仓库二次开发。"
---

# Muse Cookie Sync

## Source Repository

完整源码仓库：

`https://github.com/caichengle666/muse-cookies-sync`

开始前获取最新版并读取 `README.md`、`cookie-sync.user.js`、`server/receiver.js` 和相关部署文件。不要根据旧副本猜测接口或配置。

## Purpose

该项目由两部分组成：

- 浏览器客户端 `cookie-sync.user.js`（当前 `@version 1.6.1`）：通过 Tampermonkey/Violentmonkey 读取当前网站 Cookie，上传到自建服务器；用户主动操作时可拉取并通过 `GM_cookie.set` 写回当前网站。另有「我的凭据」标签页：保存本人账号凭据（本地 Base64 混淆，可选上传 `/api/credentials`），点「填入」只填表单、不自动提交。
- Node.js 接收端 `server/receiver.js`（零依赖）：使用 `X-Auth-Token` 鉴权，保存最新快照和历史数据，并按 `site` 返回最新 Cookie；另提供只读管理页 `/admin`、`/api/sites`、`/health`。

## Current Behavior（以代码为准）

浏览器端：

- 面板和提示浮层挂在 `closed` 模式的 Shadow DOM 里，页面脚本（以及 agent 在页面里注入的脚本）拿不到 `shadowRoot`。
- 所有按钮/开关只响应 `event.isTrusted === true` 的真实用户操作；`dispatchEvent`、`el.click()` 等合成事件一律被忽略。需要点面板时用真实点击，逻辑校验以离线测试为准。
- 令牌输入框是密码框，保存后立即清空、从不回显到 DOM；之后**留空点「保存配置」保留原令牌**，填新值才会替换（占位符显示“已保存（留空则保留原令牌）”）。
- 凭据「填入」**仅限当前站点**：「网站」改成别的域名时可以查看/删除该站点条目，但「填入」按钮禁用；菜单命令 `🔑 填入我的登录凭据` 同样只取当前站点。
- 导出按 `{url}` + `{domain}` 逐级父域（最多 4 级，IP 不推断父域）合并去重，去重键 `name + domain + path + partitionKey`。父域查询**不越过注册域**：内置常见多级公共后缀（`com.cn`、`co.uk`、`co.jp`、`com.au` 等及 `github.io`、`gitlab.io`、`pages.dev`、`workers.dev`、`vercel.app`、`netlify.app` 等），不是完整 Public Suffix List，未收录的按单级 TLD 处理。每条结果再按浏览器域匹配规则过滤（`hostOnly` 须完全相同；否则 `h === d` 或 `h.endsWith('.' + d)` 且 `d` 不能是公共后缀），丢弃条数记在 payload `sources` 的 `filtered=N`。
- 读不到 `GM_cookie` 时回退 `document.cookie`：拿不到的字段置 `null`、推断字段标 `inferred: true`，`fieldComplete=false`。
- 恢复：服务端返回的 `payload.site` 与当前主机名不一致直接报错；不属于当前站点或已过期的 Cookie 计入“跳过”。
- 勾选「自动导出」且已填地址时，页面加载约 1.5 秒后自动推送当前站点。

接收端：

- `TOKEN` 必填，未设置（或只有空白）时拒绝启动；`HOST` 默认 `127.0.0.1`，`PORT` 默认 `8787`；其余变量 `DATA_DIR`、`LOG_FORMAT`、`MAX_SNAPSHOTS_PER_SITE`、`RETENTION_DAYS`、`DEDUP` 见 README 表格。`receiver.js` 不解析 `.env` 文件。
- **不支持 CORS**：不发送任何 `Access-Control-*` 头，`OPTIONS` 一律返回 `405`（`Allow: GET, POST`）。油猴脚本走 `GM_xmlhttpRequest`、`/admin` 是同源，都不需要 CORS；不要尝试从普通网页 `fetch` 跨域调用接口，验证接口请用 `curl` 等命令行工具。
- `/health`、`/api/ping` 无需令牌；`/admin` 页面本身可打开，读数据需在页面里填同一个 `TOKEN`；`/api/sites`、`GET/POST /api/cookies`、`POST /api/credentials` 都要 `X-Auth-Token`。
- 落盘（`server/data/` 或 `DATA_DIR`）：`cookies-<host>-<时间戳>.json` 快照（受保留策略约束）、`latest-<host>.json`、追加式 `cookies.jsonl`、`credentials-<host>.json`（**明文**）。

它不是无条件恢复所有登录状态的方案。网站可能额外绑定 IP、User-Agent、设备指纹、本地存储、Passkey 或二次验证。

## Choose A Mode

- 只安装浏览器脚本：用户已有兼容接收端，只需配置 Cookie 接口地址和令牌。
- 只部署接收端：用户已有脚本，需要在本机、VPS 或私有服务器保存 Cookie。
- 完整搭建：部署接收端，再安装浏览器脚本并完成一次上传和恢复验证。
- 二次开发：在现有仓库内修改时遵循当前代码结构，同时更新测试和 README 中受影响的行为。

需求未说明时，先确认用户需要哪种模式以及接收端运行位置。已经明确时直接执行，不重复询问。

## Workflow

1. 检查目标环境：接收端需要 Node.js 18+；浏览器端需要 Tampermonkey 或 Violentmonkey，并授予 `GM_cookie` 权限。
2. 部署接收端时生成长随机 `TOKEN`，通过环境变量提供，不写入 Git。远程部署使用 HTTPS，并优先让 Node 只监听反向代理可访问的地址。
3. 启动后验证 `GET /health`，再使用带 `X-Auth-Token` 的真实 HTTP 请求验证上传和按站点拉取。
4. 安装用户脚本后，在面板配置完整的 `/api/cookies` 地址和相同令牌（令牌保存后不回显，再次保存时留空即保留）。
5. 上传验证：在用户自己的测试账号页面执行“立即导出”，确认服务端生成相应站点的最新快照。
6. 恢复验证：在用户自己的另一浏览器环境打开同一站点，执行“从服务器恢复”，核对写入、跳过和失败数量，再手动刷新页面。
7. 修改代码后至少运行：

```bash
node --check cookie-sync.user.js
node --check server/receiver.js
node --check server/receiver.test.js
node --check _test/userscript.test.js
cd server && npm test   # = node --test receiver.test.js ../_test/userscript.test.js
```

`_test/userscript.test.js` 用 `node:vm` + GM 桩 + 假 DOM 离线覆盖 closed shadowRoot、令牌不回显、`isTrusted` 校验、「填入」仅限当前站点、Cookie 域过滤与注册域边界；改动这些行为时同步更新它。界面或 Cookie 写回行为变化时，再用 `_test/harness.html` 对应 probe 检查，并用真实浏览器确认结果。注意：测试台里自动派发的点击会被 `isTrusted` 校验忽略（预期行为），测试台靠在加载脚本前包装 `attachShadow` 拿到面板根节点，按钮交互需手动点击。

部署文件：`deploy/cookie-sync.service`（`WorkingDirectory=/opt/cookie-sync/server`、`EnvironmentFile=/opt/cookie-sync/server/.env`，按此路径放环境变量文件，模板见 `deploy/cookie-sync.env.example`）、`deploy/nginx-cookie-sync.conf`（反代 + HTTPS，Node 只监听 `127.0.0.1`）、`deploy/ecosystem.config.js`（PM2 备选）。

## Safety And Scope

- 仅处理用户本人账号、本人设备和本人控制的接收端；不得改造成收集第三方用户凭据或 Cookie 的工具。
- Cookie、Token 和凭据均视为秘密。不要输出到聊天、提交到仓库或写入普通调试日志。
- 不自动从服务器覆盖本地 Cookie。恢复必须由用户主动触发，完成后由用户决定是否刷新页面。
- 服务端返回的站点必须与当前站点一致；过期、域名不匹配或无法正确表达的 Cookie 应跳过并报告。
- 不要绕开面板隔离（改回 open shadowRoot、去掉 `isTrusted` 校验、把令牌写回 DOM、允许跨站「填入」）或给服务端加回 CORS：脚本注入所有站点，这些防护是令牌和凭据不被页面读走的前提。
- 凭据保险箱只保存、填入本人账号；服务端 `credentials-*.json` 为明文，上传前确认已启用 `TOKEN` + HTTPS 且不暴露公网。
- 不声称“上传成功”就代表登录一定可迁移；需要在目标设备实际访问网站验证。
- `server/data/` 和环境变量文件不得提交。部署前确认 `TOKEN`、HTTPS、数据目录权限和备份策略。

## Integration

若接收端运行在 Muse 式沙盒并需要公网域名，可配合：

`https://github.com/caichengle666/muse-tunnel`

先让接收端只监听本地地址，再由 tunnel 工具提供公网 HTTPS 入口。Cookie Sync 自身不管理 Cloudflare DNS 或隧道。

