import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class LogCleanupService {
  private readonly logger = new Logger(LogCleanupService.name);
  private readonly logDir = path.join(process.cwd(), 'logs');

  // Jalankan setiap hari jam 00:00 WIB
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  handleLogCleanup() {
    try {
      if (!fs.existsSync(this.logDir)) {
        this.logger.warn(`Log directory not found: ${this.logDir}`);
        return;
      }

      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 hari dalam ms

      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;

        if (age > maxAge) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.logger.log(`Deleted ${deletedCount} old log file(s)`);
      } else {
        this.logger.debug('No old log files to delete');
      }
    } catch (error) {
      this.logger.error(
        `Failed to clean up logs: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
