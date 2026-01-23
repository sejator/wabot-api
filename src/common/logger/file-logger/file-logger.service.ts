import { ConsoleLogger, Injectable } from '@nestjs/common';
import pino, { Logger } from 'pino';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FileLoggerService extends ConsoleLogger {
  private logger: Logger;
  private readonly contextName: string;
  private currentDate: string;
  private logDir: string;

  constructor(context: string = 'App') {
    super(context);
    this.contextName = context;

    this.logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.currentDate = this.getDate();
    this.logger = this.createLoggerInstance(this.currentDate);
  }

  private getDate(): string {
    return new Date()
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })
      .replace(/\//g, '-');
  }

  private createLoggerInstance(date: string): Logger {
    const logFile = path.join(this.logDir, `app-${date}.log`);

    return pino(
      {
        level: 'debug',
        base: { context: this.contextName },
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

  private rotateIfNeeded() {
    const today = this.getDate();

    if (today !== this.currentDate) {
      this.currentDate = today;
      this.logger.flush?.();
      this.logger = this.createLoggerInstance(today);
    }
  }

  private resolveContext(context?: string): string {
    return context ?? this.contextName ?? this.constructor.name;
  }

  override log(message: string, ...optionalParams: unknown[]) {
    this.rotateIfNeeded();
    const ctx = this.resolveContext(optionalParams[0] as string);
    super.log(`[${ctx}] ${message}`);
    this.logger.info({ message, context: ctx, extra: optionalParams });
  }

  override debug(message: string, context?: string) {
    this.rotateIfNeeded();
    const ctx = this.resolveContext(context);
    super.debug(`[${ctx}] ${message}`);
    this.logger.debug({ message, context: ctx });
  }

  override warn(message: string, context?: string) {
    this.rotateIfNeeded();
    const ctx = this.resolveContext(context);
    super.warn(`[${ctx}] ${message}`);
    this.logger.warn({ message, context: ctx });
  }

  override error(message: string, trace?: string, context?: string) {
    this.rotateIfNeeded();
    const ctx = this.resolveContext(context);
    super.error(`[${ctx}] ${message}`, trace);
    this.logger.error({ message, trace, context: ctx });
  }

  override verbose(message: string, context?: string) {
    this.rotateIfNeeded();
    const ctx = this.resolveContext(context);
    super.verbose(`[${ctx}] ${message}`);
    this.logger.trace({ message, context: ctx });
  }
}
