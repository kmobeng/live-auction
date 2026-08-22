import type { Prisma } from '../../generated/prisma/client';
import { OutboxService } from './outbox.service';

describe('OutboxService', () => {
  let service: OutboxService;
  let tx: { outboxEvent: { create: jest.Mock } };

  beforeEach(() => {
    service = new OutboxService();
    tx = {
      outboxEvent: {
        create: jest
          .fn()
          .mockResolvedValue({ id: 'event-1', eventType: 'user-registered' }),
      },
    };
  });

  it('writes the event through the provided transaction client', async () => {
    await service.createEvent(tx as unknown as Prisma.TransactionClient, {
      aggregateType: 'user',
      aggregateId: 'user-1',
      eventType: 'user-registered',
      payload: { email: 'jane@example.com', verificationToken: '123456' },
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'user',
        aggregateId: 'user-1',
        eventType: 'user-registered',
        payload: { email: 'jane@example.com', verificationToken: '123456' },
      },
    });
  });

  it('returns the created outbox row', async () => {
    const result = await service.createEvent(
      tx as unknown as Prisma.TransactionClient,
      {
        aggregateType: 'user',
        aggregateId: 'user-1',
        eventType: 'password-reset-requested',
        payload: { email: 'jane@example.com', resetToken: 'abc123' },
      },
    );

    expect(result).toEqual({ id: 'event-1', eventType: 'user-registered' });
  });
});
