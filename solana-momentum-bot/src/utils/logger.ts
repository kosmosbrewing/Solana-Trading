import winston from 'winston';

const SENSITIVE_PATTERNS = [
  /[1-9A-HJ-NP-Za-km-z]{87,88}/g,  // Base58 private keys
  /[1-9A-HJ-NP-Za-km-z]{43,44}/g,  // Solana public keys (마스킹: 앞6 + ... + 뒤4)
];

function maskSensitive(message: string): string {
  let masked = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (match.length > 20) {
        return `${match.slice(0, 6)}...${match.slice(-4)}`;
      }
      return match;
    });
  }
  return masked;
}

const maskFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = maskSensitive(info.message);
  }
  return info;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
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
      maxsize: 10 * 1024 * 1024, // 10MB
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
