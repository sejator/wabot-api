import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class LogCleanupService {
  private readonly logger = new Logger(LogCleanupService.name);
  private readonly logDir = path.join(process.cwd(), 'logs');

  // Jalankan setiap hari pukul 1 pagi
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  handleLogCleanup() {
    try {
      if (!fs.existsSync(this.logDir)) {
        this.logger.warn(`Log directory not found: ${this.logDir}`);
        return;
      }

      const files = fs.readdirSync(this.logDir);
      if (files.length === 0) {
        this.logger.debug('No log files found to clean up');
        return;
      }

      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 hari dalam ms
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.logDir, file);

        // Skip folder atau file non-log
        if (!file.endsWith('.log')) continue;

        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;

        if (age > maxAge) {
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (err) {
            this.logger.warn(`Failed to delete ${file}: ${err}`);
          }
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
