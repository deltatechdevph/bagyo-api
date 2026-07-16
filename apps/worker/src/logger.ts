import { pino } from 'pino';

export function createLogger(level: string, name: string) {
  return pino({
    name,
    level,
    ...(process.env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
