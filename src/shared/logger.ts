type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function currentLevel(): LogLevel {
  const raw = (process.env.DEVSPACE_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()];
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    debug: (...args) => {
      if (shouldLog('debug')) console.debug(prefix, ...args);
    },
    info: (...args) => {
      if (shouldLog('info')) console.info(prefix, ...args);
    },
    warn: (...args) => {
      if (shouldLog('warn')) console.warn(prefix, ...args);
    },
    error: (...args) => {
      if (shouldLog('error')) console.error(prefix, ...args);
    },
  };
}
