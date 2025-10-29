import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { Response } from 'express';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, any> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<any> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse<Response>();

    response.setHeader('X-Powered-By', 'SendNotif');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');

    return next.handle().pipe(
      map((data) => ({
        success: true,
        code: response.statusCode || 200,
        data: data ?? {},
      })),
    );
  }
}
