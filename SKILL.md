---
name: "muse-cookies-sync"
description: "安装、部署、配置和维护 Muse Cookie Sync：用油猴脚本读取当前网站 Cookie，上传到自建 Node.js 接收端，并在自己的另一台设备上手动拉取和恢复。适用于用户询问 Cookie 跨设备同步、接收端部署或该仓库二次开发。"
---

# Muse Cookie Sync

## Source Repository

完整源码仓库：

`https://github.com/caichengle666/muse-cookies-sync`

开始前获取最新版并读取 `README.md`、`cookie-sync.user.js`、`server/receiver.js` 和相关部署文件。不要根据旧副本猜测接口或配置。

## Purpose

该项目由两部分组成：

- 浏览器客户端 `cookie-sync.user.js`：通过 Tampermonkey/Violentmonkey 读取当前网站 Cookie，上传到自建服务器；用户主动操作时可拉取并通过 `GM_cookie.set` 写回当前网站。
- Node.js 接收端 `server/receiver.js`：使用 `X-Auth-Token` 鉴权，保存最新快照和历史数据，并按 `site` 返回最新 Cookie。

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
4. 安装用户脚本后，在面板配置完整的 `/api/cookies` 地址和相同令牌。
5. 上传验证：在用户自己的测试账号页面执行“立即导出”，确认服务端生成相应站点的最新快照。
6. 恢复验证：在用户自己的另一浏览器环境打开同一站点，执行“从服务器恢复”，核对写入、跳过和失败数量，再手动刷新页面。
7. 修改代码后至少运行：

```bash
node --check cookie-sync.user.js
node --check server/receiver.js
node --check server/receiver.test.js
cd server && npm test
```

界面或 Cookie 写回行为变化时，同时运行 `_test/harness.html` 对应 probe，并用真实浏览器确认结果。

## Safety And Scope

- 仅处理用户本人账号、本人设备和本人控制的接收端；不得改造成收集第三方用户凭据或 Cookie 的工具。
- Cookie、Token 和凭据均视为秘密。不要输出到聊天、提交到仓库或写入普通调试日志。
- 不自动从服务器覆盖本地 Cookie。恢复必须由用户主动触发，完成后由用户决定是否刷新页面。
- 服务端返回的站点必须与当前站点一致；过期、域名不匹配或无法正确表达的 Cookie 应跳过并报告。
- 不声称“上传成功”就代表登录一定可迁移；需要在目标设备实际访问网站验证。
- `server/data/` 和环境变量文件不得提交。部署前确认 `TOKEN`、HTTPS、数据目录权限和备份策略。

## Integration

若接收端运行在 Muse 式沙盒并需要公网域名，可配合：

`https://github.com/caichengle666/muse-tunnel`

先让接收端只监听本地地址，再由 tunnel 工具提供公网 HTTPS 入口。Cookie Sync 自身不管理 Cloudflare DNS 或隧道。

