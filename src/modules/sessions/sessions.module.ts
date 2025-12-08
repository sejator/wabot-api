import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { EngineModule } from 'src/common/interfaces/engines/engine.module';

@Module({
  imports: [PrismaModule, EngineModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService, EngineModule],
})
export class SessionsModule {}
