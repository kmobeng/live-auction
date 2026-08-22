// src/common/filters/all-exceptions.filter.ts
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '../../../generated/prisma/client';

interface ErrorResponse {
  statusCode: number;
  errorMessage: string;
  isOperational: boolean;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, errorMessage, isOperational } =
      this.resolveError(exception);

    if (process.env.NODE_ENV === 'development') {
      response.status(statusCode).json({
        success: false,
        message: errorMessage,
        name: (exception as Error)?.name,
        stack: (exception as Error)?.stack,
      });
      return;
    }

    if (!isOperational) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        (exception as Error)?.stack,
      );
    }

    response.status(statusCode).json({
      success: false,
      message: isOperational
        ? errorMessage
        : 'Something went wrong. Please try again later.',
    });
  }

  private resolveError(exception: unknown): ErrorResponse {
    // Known NestJS HTTP exceptions
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : (response as any).message || exception.message;
      return {
        statusCode: exception.getStatus(),
        errorMessage: Array.isArray(message) ? message.join(', ') : message,
        isOperational: true,
      };
    }

    // Prisma: unique constraint violation (e.g. duplicate email)
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        const field =
          (exception.meta?.target as string[])?.join(', ') ?? 'field';
        return {
          statusCode: HttpStatus.CONFLICT,
          errorMessage: `Duplicate value: ${field} already exists. Please use a different value.`,
          isOperational: true,
        };
      }
      if (exception.code === 'P2025') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          errorMessage: 'Record not found.',
          isOperational: true,
        };
      }
    }

    // Anything else — genuinely unexpected
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorMessage: 'Internal server error',
      isOperational: false,
    };
  }
}
