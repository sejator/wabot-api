import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import Redlock, { CompatibleRedisClient } from 'redlock';

export const REDIS_CLIENT = 'REDIS_CLIENT';
export const REDLOCK = 'REDLOCK';

/**
 * Modul Redis global yang menyediakan klien ioredis dan instance Redlock
 *
 * @remarks
 * Modul ini secara otomatis tersedia di seluruh aplikasi karena didekorasi dengan @Global().
 * Menyediakan dua provider utama:
 * - REDIS_CLIENT: Instance klien Redis menggunakan ioredis
 * - REDLOCK: Instance Redlock untuk distributed locking
 *
 * @example
 * ```typescript
 * // Menggunakan dalam service
 * constructor(
 *   @Inject(REDIS_CLIENT) private redis: Redis,
 *   @Inject(REDLOCK) private redlock: Redlock
 * ) {}
 * ```
 *
 * @public
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
          return new Redis(redisUrl);
        }
        const host = process.env.REDIS_HOST || '127.0.0.1';
        const port = parseInt(process.env.REDIS_PORT || '6379', 10);
        return new Redis({ host, port });
      },
    },
    {
      provide: REDLOCK,
      inject: [REDIS_CLIENT],
      useFactory: (redisClient: Redis) => {
        const clientForRedlock =
          redisClient as unknown as CompatibleRedisClient;

        const redlock = new Redlock([clientForRedlock], {
          driftFactor: 0.01,
          retryCount: 3,
          retryDelay: 200,
          retryJitter: 200,
        });

        redlock.on('clientError', (err) => {
          console.warn('Redlock clientError', err);
        });

        return redlock;
      },
    },
  ],
  exports: [REDIS_CLIENT, REDLOCK],
})
export class RedisModule {}
