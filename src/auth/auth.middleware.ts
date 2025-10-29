import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new FileLoggerService(AuthMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];

    if (typeof authHeader !== 'string') {
      this.logger.warn(`Missing authorization header from IP: ${req.ip}`);
      throw new UnauthorizedException('Access denied');
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      this.logger.warn(`Invalid auth format from IP: ${req.ip}`);
      throw new UnauthorizedException('Access denied');
    }

    const validToken = process.env.SERVER_TOKEN || 'acakTokendeFault';
    if (token !== validToken) {
      this.logger.warn(`Invalid token attempt from IP: ${req.ip}`);
      throw new UnauthorizedException('Access denied');
    }

    // --- Validasi IP ---
    const allowedIps = (process.env.SERVER_IP || '127.0.0.1,localhost')
      .split(',')
      .map((ip) => ip.trim());

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress;

    if (!allowedIps.includes(clientIp ?? '')) {
      this.logger.warn(`Blocked unauthorized IP: ${clientIp}`);
      throw new ForbiddenException('Access denied');
    }

    next();
  }
}
