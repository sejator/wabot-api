import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { EngineModule } from 'src/common/interfaces/engines/engine.module';
import { SessionsGateway } from './sessions.gateway';

@Module({
  imports: [PrismaModule, EngineModule],
  controllers: [SessionsController],
  providers: [SessionsService, SessionsGateway],
  exports: [SessionsService, EngineModule],
})
export class SessionsModule {}
