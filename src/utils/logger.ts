export function createLogger(context: Record<string, string>) {
  const fmt = (level: string, msg: string, meta?: object) =>
    JSON.stringify({
      level,
      msg,
      ...context,
      ...(meta || {}),
      timestamp: new Date().toISOString(),
    });
  return {
    info: (msg: string, meta?: object) => console.log(fmt('info', msg, meta)),
    warn: (msg: string, meta?: object) => console.warn(fmt('warn', msg, meta)),
    error: (msg: string, meta?: object) =>
      console.error(fmt('error', msg, meta)),
    debug: (msg: string, meta?: object) => {
      if (process.env.NODE_ENV !== 'production')
        console.log(fmt('debug', msg, meta));
    },
  };
}
