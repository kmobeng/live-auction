import { Catch, ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof WsException) {
      const client = host.switchToWs().getClient<Socket>();
      const error = exception.getError();
      const message =
        typeof error === 'string'
          ? error
          : ((error as any)?.message ?? 'Ws error');
      client.emit('exception', {
        status: 'error',
        message,
      });
      // also call parent for logging if needed
      super.catch(exception, host);
      return;
    }

    if (exception instanceof HttpException) {
      // HTTP exceptions (e.g. UnauthorizedException from verifyAccessToken,
      // ThrottlerException from the global throttler guard) are not WsExceptions,
      // so without this mapping the client only sees "Internal server error".
      const response = exception.getResponse();
      const rawMessage =
        typeof response === 'string'
          ? response
          : ((response as any)?.message ?? exception.message);
      const message = Array.isArray(rawMessage)
        ? rawMessage.join(', ')
        : rawMessage;
      super.catch(new WsException(message), host);
      return;
    }

    this.logger.error(
      'Unhandled WS exception',
      (exception as Error)?.stack ?? String(exception),
    );
    super.catch(new WsException('Internal server error'), host);
  }
}
