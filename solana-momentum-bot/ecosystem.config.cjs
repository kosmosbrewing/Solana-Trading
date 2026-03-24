// pm2 ecosystem config for solana-momentum-bot
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'momentum-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      // Why: HTTP listener가 없는 worker 프로세스라 cluster_mode 이점이 없음
      //       Node 22 + PM2 cluster 조합에서 startup AggregateError 루프 방지
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      // Structured JSON logging — pm2 log rotation 호환
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/bot-error.log',
      out_file: 'logs/bot-out.log',
      merge_logs: true,
      // Graceful shutdown: SIGINT → 10s timeout
      kill_timeout: 10000,
      listen_timeout: 8000,
    },
    {
      name: 'momentum-shadow',
      script: 'scripts/vps-realtime-shadow.sh',
      interpreter: '/bin/bash',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/shadow-error.log',
      out_file: 'logs/shadow-out.log',
      merge_logs: true,
      kill_timeout: 10000,
      listen_timeout: 8000,
    },
    {
      name: 'momentum-ops-bot',
      script: 'dist/ops/telegramControlBot.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/ops-error.log',
      out_file: 'logs/ops-out.log',
      merge_logs: true,
      kill_timeout: 10000,
      listen_timeout: 8000,
    },
  ],
};
