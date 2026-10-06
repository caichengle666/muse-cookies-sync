// Cookie Sync —— PM2 进程配置（systemd 的替代方案，二选一即可）
// ---------------------------------------------------------------
// 用法：
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save                 # 保存进程列表
//   pm2 startup              # 生成开机自启命令，按提示执行
//   pm2 logs cookie-sync     # 看日志
//
// 注意：本文件里写 TOKEN 会进 Git，建议改用 .env + dotenv，
//       或设置环境变量后删除下面的 env 段。生产推荐直接用 systemd 方案。
// ---------------------------------------------------------------

module.exports = {
  apps: [
    {
      name: 'cookie-sync',
      script: 'receiver.js',
      cwd: '/opt/cookie-sync/server', // ← 改成你的部署路径
      instances: 1,
      exec_mode: 'fork',

      env: {
        PORT: 8787,
        HOST: '127.0.0.1', // 放在 Nginx 后面，只监听本机
        TOKEN: 'REPLACE_WITH_openssl_rand_hex_32',
      },

      autorestart: true,
      max_memory_restart: '200M',
      out_file: '/var/log/cookie-sync/out.log',
      error_file: '/var/log/cookie-sync/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
