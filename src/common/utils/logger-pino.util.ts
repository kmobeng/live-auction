import { randomUUID } from 'crypto';
export const LoggerOptions = () => {
  return {
    pinoHttp: {
      genReqId: (req) => {
        const header = req.headers['x-request-id'];
        return (Array.isArray(header) ? header[0] : header) || randomUUID();
      },
      level: 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: { singleLine: true, colorize: true },
            }
          : undefined,
      autoLogging: {
        ignore: (req) => req.url === '/metrics',
      },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
      },
    },
  };
};
