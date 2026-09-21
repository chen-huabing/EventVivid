import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class DomainError extends Error {
  constructor(message: string, public readonly status = HttpStatus.BAD_REQUEST) {
    super(message);
  }
}

@Catch(DomainError, ZodError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(error: DomainError | ZodError, host: ArgumentsHost) {
    const isValidation = error instanceof ZodError;
    host.switchToHttp().getResponse<FastifyReply>().status(isValidation ? HttpStatus.BAD_REQUEST : error.status).send({
      code: isValidation ? 'VALIDATION_ERROR' : 'DOMAIN_ERROR',
      message: isValidation ? error.issues.map((issue) => issue.message).join('；') : error.message,
    });
  }
}
