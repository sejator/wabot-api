import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { EngineManager } from './engine-manager';
import { ConnectorRegistry } from './connector-registry.service';
import { BaileysEngine } from './baileys.engine';
import { WWebJSEngine } from './wwebjs.engine';
import { WebhookModule } from 'src/modules/webhook/webhook.module';
import { WppConnectEngine } from './wppconnect.engine';
import { MongoModule } from 'src/mongo/mongo.module';

@Module({
  imports: [PrismaModule, WebhookModule, MongoModule],
  providers: [
    EngineManager,
    ConnectorRegistry,
    BaileysEngine,
    WWebJSEngine,
    WppConnectEngine,
  ],
  exports: [EngineManager, ConnectorRegistry],
})
export class EngineModule implements OnModuleInit {
  private readonly logger = new Logger(EngineModule.name);

  constructor(
    private readonly engineManager: EngineManager,
    private readonly baileysEngine: BaileysEngine,
    private readonly wwebjsEngine: WWebJSEngine,
    private readonly wppconnect: WppConnectEngine,
  ) {}

  onModuleInit() {
    this.engineManager.register(this.baileysEngine);
    this.engineManager.register(this.wwebjsEngine);
    this.engineManager.register(this.wppconnect);
    this.logger.log('Engines registered');
  }
}
