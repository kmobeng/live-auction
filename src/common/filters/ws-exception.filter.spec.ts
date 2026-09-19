import { Logger, UnauthorizedException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { WsExceptionFilter } from './ws-exception.filter';

const makeHost = () => {
  const emit = jest.fn();
  const host = {
    switchToWs: () => ({
      getClient: () => ({ emit }),
      getPattern: () => 'joinAuction',
      getData: () => ({ auctionId: 'auction-1' }),
    }),
  } as never;
  return { host, emit };
};

describe('WsExceptionFilter', () => {
  it('emits the real message for WsException', () => {
    const { host, emit } = makeHost();
    new WsExceptionFilter().catch(
      new WsException('Access token is missing'),
      host,
    );

    expect(emit).toHaveBeenCalledWith(
      'exception',
      expect.objectContaining({
        status: 'error',
        message: 'Access token is missing',
      }),
    );
  });

  it('maps HttpException to its message instead of "Internal server error"', () => {
    const { host, emit } = makeHost();
    new WsExceptionFilter().catch(
      new UnauthorizedException('Access token is missing'),
      host,
    );

    const messages = emit.mock.calls.map((call) => call[1]?.message);
    expect(messages).toContain('Access token is missing');
    expect(messages).not.toContain('Internal server error');
  });

  it('maps unknown errors to a generic message and logs the stack', () => {
    const { host, emit } = makeHost();
    const loggerSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    new WsExceptionFilter().catch(new Error('ECONNREFUSED'), host);

    expect(emit).toHaveBeenCalledWith(
      'exception',
      expect.objectContaining({
        status: 'error',
        message: 'Internal server error',
      }),
    );
    expect(loggerSpy).toHaveBeenCalled();
    loggerSpy.mockRestore();
  });
});
