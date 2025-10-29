import { Test, TestingModule } from '@nestjs/testing';
import { FileLoggerService } from './file-logger.service';

describe('FileLoggerService', () => {
  let service: FileLoggerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FileLoggerService],
    }).compile();

    service = module.get<FileLoggerService>(FileLoggerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
