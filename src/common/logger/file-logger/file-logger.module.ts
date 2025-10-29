import { Module } from '@nestjs/common';
import { FileLoggerService } from './file-logger.service';

@Module({
  providers: [FileLoggerService],
  exports: [FileLoggerService],
})
export class FileLoggerModule {}
