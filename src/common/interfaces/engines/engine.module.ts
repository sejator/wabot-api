import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { EngineManager } from './engine-manager';
import { ConnectorRegistry } from './connector-registry.service';
import { BaileysEngine } from './baileys.engine';
import { WWebJSEngine } from './wwebjs.engine';
import { WebhookModule } from 'src/modules/webhook/webhook.module';

@Module({
  imports: [PrismaModule, WebhookModule],
  providers: [EngineManager, ConnectorRegistry, BaileysEngine, WWebJSEngine],
  exports: [EngineManager, ConnectorRegistry],
})
export class EngineModule implements OnModuleInit {
  private readonly logger = new Logger(EngineModule.name);

  constructor(
    private readonly engineManager: EngineManager,
    private readonly baileysEngine: BaileysEngine,
    private readonly wwebjsEngine: WWebJSEngine,
  ) {}

  onModuleInit() {
    this.engineManager.register(this.baileysEngine);
    this.engineManager.register(this.wwebjsEngine);
    this.logger.log('Engines registered');
  }
}
