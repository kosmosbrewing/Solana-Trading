// pm2 ecosystem config for solana-momentum-bot
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'momentum-bot',
      script: 'dist/index.js',
      cwd: __dirname,
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
      // Helius WS 수집기 — GeckoTerminal trending 풀 자동 감지 + raw-swaps.jsonl 저장
      // 저장 경로: data/realtime-swaps/{poolAddress}/raw-swaps.jsonl
      name: 'helius-collector',
      script: 'scripts/helius-collector.ts',
      interpreter: 'npx',
      interpreter_args: 'ts-node',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/collector-error.log',
      out_file: 'logs/collector-out.log',
      merge_logs: true,
      kill_timeout: 15000,
    },
  ],
};
