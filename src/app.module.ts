import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionsModule } from './modules/sessions/sessions.module';
import { MessagesModule } from './modules/messages/messages.module';
import { FileLoggerModule } from './common/logger/file-logger/file-logger.module';
import { RedisModule } from './modules/redis/redis.module';
import { ScheduleModule } from '@nestjs/schedule';
import { LogCleanupService } from './common/logger/log-cleanup.service';
import { AuthMiddleware } from './auth/auth.middleware';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SessionsModule,
    MessagesModule,
    FileLoggerModule,
    RedisModule,
  ],
  controllers: [AppController],
  providers: [AppService, LogCleanupService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
