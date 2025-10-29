import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';

type ErrorResponse = string | Record<string, any>;

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new FileLoggerService(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let errorResponse: ErrorResponse;

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        errorResponse = res;
      } else if (typeof res === 'object' && res !== null) {
        errorResponse = res as Record<string, any>;
      } else {
        errorResponse = 'Internal server error';
      }
    } else if (exception instanceof Error) {
      errorResponse = exception.message;
    } else {
      errorResponse = 'Internal server error';
    }

    const errorMessage =
      typeof errorResponse === 'string'
        ? errorResponse
        : (errorResponse.message as string) || 'Internal server error';

    this.logger.error(errorMessage);

    const clientMessage =
      status >= 500 ? 'Internal server error' : errorMessage;

    response.status(status).setHeader('X-Powered-By', 'SendNotif').json({
      success: false,
      code: status,
      message: clientMessage,
    });
  }
}
