import { ConsoleLogger, Injectable } from '@nestjs/common';
import pino, { Logger } from 'pino';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FileLoggerService extends ConsoleLogger {
  private readonly logger: Logger;
  private readonly contextName: string;

  constructor(context: string = 'App') {
    super(context);
    this.contextName = context;

    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const date = new Date()
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })
      .replace(/\//g, '-');
    const logFile = path.join(logDir, `app-${date}.log`);

    this.logger = pino(
      {
        level: 'debug',
        base: { context },
        timestamp: () => {
          const now = new Date().toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            hour12: false,
          });

          const [tgl, jam] = now.split(' ');
          const [bulan, hari, tahun] = tgl.split('/');
          const formatted = `${hari}-${bulan}-${tahun} ${jam}`;

          return `,"time":"${formatted}"`;
        },
        formatters: {
          level(label) {
            return { level: label.toUpperCase() };
          },
        },
      },
      pino.destination({ dest: logFile, append: true }),
    );
  }

  private resolveContext(context?: string): string {
    return context ?? this.contextName ?? this.constructor.name;
  }

  override log(message: string, ...optionalParams: unknown[]) {
    const ctx = this.resolveContext(optionalParams[0] as string);
    super.log(`[${ctx}] ${message}`);
    this.logger.info({ message, context: ctx, extra: optionalParams });
  }

  override debug(message: string, context?: string) {
    const ctx = this.resolveContext(context);
    super.debug(`[${ctx}] ${message}`);
    this.logger.debug({ message, context: ctx });
  }

  override warn(message: string, context?: string) {
    const ctx = this.resolveContext(context);
    super.warn(`[${ctx}] ${message}`);
    this.logger.warn({ message, context: ctx });
  }

  override error(message: string, trace?: string, context?: string) {
    const ctx = this.resolveContext(context);
    super.error(`[${ctx}] ${message}`, trace);
    this.logger.error({ message, trace, context: ctx });
  }

  override verbose(message: string, context?: string) {
    const ctx = this.resolveContext(context);
    super.verbose(`[${ctx}] ${message}`);
    this.logger.trace({ message, context: ctx });
  }
}
