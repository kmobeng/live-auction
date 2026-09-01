import { Test, TestingModule } from '@nestjs/testing';
import { BidsController } from './bids.controller';
import { BidsService } from './bids.service';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { IsEmailVerifiedGuard } from '../common/guards/is-email-verified.guard';

describe('BidsController', () => {
  let controller: BidsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BidsController],
      providers: [
        {
          provide: BidsService,
          useValue: { createBidService: jest.fn() },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(IsEmailVerifiedGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<BidsController>(BidsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
