import { randomUUID } from 'crypto';
export const LoggerOptions = () => {
  return {
    pinoHttp: {
      //extract the trace ID from the incoming request headers or generate a new one if not present
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
      //custom log level based on the response status code and error presence
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      //serializers for formatting request and response objects in the logs
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
