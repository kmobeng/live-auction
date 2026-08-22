import type { PrismaService } from '../prisma.service';
import type { NotificationService } from '../notification/notification.service';
import { OutboxPoller } from './outbox-poller';

const makeEvent = (overrides: Record<string, any> = {}) => ({
  id: 'event-1',
  aggregateId: 'user-1',
  aggregateType: 'user',
  eventType: 'user-registered',
  payload: { email: 'jane@example.com', verificationToken: '123456' },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  processedAt: null,
  ...overrides,
});

describe('OutboxPoller', () => {
  let poller: OutboxPoller;
  let findMany: jest.Mock;
  let update: jest.Mock;
  let enqueueEmailVerification: jest.Mock;
  let enqueuePasswordReset: jest.Mock;
  let enqueueEmailChangeNotice: jest.Mock;
  let loggerWarn: jest.Mock;
  let loggerError: jest.Mock;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    update = jest.fn().mockResolvedValue(undefined);
    enqueueEmailVerification = jest.fn().mockResolvedValue(undefined);
    enqueuePasswordReset = jest.fn().mockResolvedValue(undefined);
    enqueueEmailChangeNotice = jest.fn().mockResolvedValue(undefined);

    poller = new OutboxPoller(
      {
        outboxEvent: { findMany, update },
      } as unknown as PrismaService,
      {
        enqueueEmailVerification,
        enqueuePasswordReset,
        enqueueEmailChangeNotice,
      } as unknown as NotificationService,
    );

    loggerWarn = jest.fn();
    loggerError = jest.fn();
    (poller as any).logger = { warn: loggerWarn, error: loggerError };
  });

  it('queries unprocessed events oldest-first in batches of 50', async () => {
    await poller.dispatchOutboxEvents();

    expect(findMany).toHaveBeenCalledWith({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing when there are no pending events', async () => {
    await poller.dispatchOutboxEvents();

    expect(enqueueEmailVerification).not.toHaveBeenCalled();
    expect(enqueuePasswordReset).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('routes user-registered events to the verification email queue', async () => {
    findMany.mockResolvedValue([
      makeEvent({
        payload: { email: 'jane@example.com', verificationToken: '123456' },
      }),
    ]);

    await poller.dispatchOutboxEvents();

    expect(enqueueEmailVerification).toHaveBeenCalledWith({
      to: 'jane@example.com',
      token: '123456',
    });
    expect(enqueuePasswordReset).not.toHaveBeenCalled();
  });

  it('routes password-reset-requested events to the reset email queue using resetToken', async () => {
    findMany.mockResolvedValue([
      makeEvent({
        eventType: 'password-reset-requested',
        payload: { email: 'jane@example.com', resetToken: 'abc123' },
      }),
    ]);

    await poller.dispatchOutboxEvents();

    expect(enqueuePasswordReset).toHaveBeenCalledWith({
      to: 'jane@example.com',
      token: 'abc123',
    });
  });

  it('routes email-verification-requested events to the verification email queue using token', async () => {
    findMany.mockResolvedValue([
      makeEvent({
        eventType: 'email-verification-requested',
        payload: { email: 'jane@example.com', token: '654321' },
      }),
    ]);

    await poller.dispatchOutboxEvents();

    expect(enqueueEmailVerification).toHaveBeenCalledWith({
      to: 'jane@example.com',
      token: '654321',
    });
  });

  it('routes email-change-requested events to the new inbox plus a notice to the old one', async () => {
    findMany.mockResolvedValue([
      makeEvent({
        eventType: 'email-change-requested',
        payload: {
          email: 'new-jane@example.com',
          previousEmail: 'jane@example.com',
          token: '246810',
        },
      }),
    ]);

    await poller.dispatchOutboxEvents();

    expect(enqueueEmailVerification).toHaveBeenCalledWith({
      to: 'new-jane@example.com',
      token: '246810',
    });
    expect(enqueueEmailChangeNotice).toHaveBeenCalledWith({
      to: 'jane@example.com',
      newEmail: 'new-jane@example.com',
    });
  });

  it('marks each dispatched event as processed after its handler succeeds', async () => {
    const first = makeEvent({ id: 'event-1' });
    const second = makeEvent({
      id: 'event-2',
      aggregateId: 'user-2',
      eventType: 'email-verification-requested',
      payload: { email: 'john@example.com', token: '111111' },
    });
    findMany.mockResolvedValue([first, second]);

    await poller.dispatchOutboxEvents();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: 'event-1' },
      data: { processedAt: expect.any(Date) },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: 'event-2' },
      data: { processedAt: expect.any(Date) },
    });
  });

  it('keeps a failing event unprocessed and still dispatches later events', async () => {
    const failing = makeEvent({ id: 'event-1' });
    const healthy = makeEvent({
      id: 'event-2',
      aggregateId: 'user-2',
      eventType: 'password-reset-requested',
      payload: { email: 'john@example.com', resetToken: 'abc123' },
    });
    findMany.mockResolvedValue([failing, healthy]);
    enqueueEmailVerification
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);

    await poller.dispatchOutboxEvents();

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({
      outboxEventId: 'event-1',
      eventType: 'user-registered',
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'event-2' },
      data: { processedAt: expect.any(Date) },
    });
  });

  it('marks unknown event types as processed and logs a warning instead of retrying forever', async () => {
    findMany.mockResolvedValue([
      makeEvent({ eventType: 'totally-unknown-event' }),
    ]);

    await poller.dispatchOutboxEvents();

    expect(loggerWarn).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: { processedAt: expect.any(Date) },
    });
  });
});
