import { Test, TestingModule } from '@nestjs/testing';
import { BidsService } from './bids.service';
import { PrismaService } from '../prisma.service';
import { BidsGateway } from './bids.gateway';

describe('BidsService', () => {
  let service: BidsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BidsService,
        {
          provide: PrismaService,
          useValue: {
            auction: { findUnique: jest.fn() },
            bid: { create: jest.fn() },
            $transaction: jest.fn(),
          },
        },
        {
          provide: BidsGateway,
          useValue: { emitBidCreated: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<BidsService>(BidsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
