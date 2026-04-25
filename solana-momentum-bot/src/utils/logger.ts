import winston from 'winston';

// Base58 프라이빗 키 (87-88자) 만 마스킹 — 짧은 문자열은 무시
const PRIVATE_KEY_PATTERN = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;

function maskSensitive(message: string): string {
  // 짧은 메시지는 프라이빗 키를 포함할 수 없으므로 스킵
  if (message.length < 87) return message;
  return message.replace(PRIVATE_KEY_PATTERN, (match) =>
    `${match.slice(0, 6)}...${match.slice(-4)}`
  );
}

const maskFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = maskSensitive(info.message);
  }
  return info;
});

// Phase H1.3 (2026-04-25): test 환경에서는 LOG_SILENT=true 로 console 전부 차단.
// LOG_LEVEL=error 만으로는 expect-error 테스트의 의도된 ERROR 가 stdout 에 노출됨.
const isSilent = process.env.LOG_SILENT === 'true';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  silent: isSilent,
  format: winston.format.combine(
    maskFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, module, ...rest }) => {
      const mod = module ? `[${module}]` : '';
      const extra = Object.keys(rest).length > 0
        ? ` ${JSON.stringify(rest)}`
        : '';
      return `${timestamp} ${level.toUpperCase().padEnd(5)} ${mod} ${message}${extra}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/bot.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

export function createModuleLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}
