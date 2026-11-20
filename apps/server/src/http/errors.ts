import type { FastifyError, FastifyInstance } from 'fastify';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { ZodError } from 'zod';

/** JSON response envelope used by every non-streaming endpoint. */
export type Envelope<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: { code: string; message: string; details?: unknown } };

export function ok<T>(data: T): Envelope<T> {
  return { success: true, data, error: null };
}

export function fail(code: string, message: string, details?: unknown): Envelope<never> {
  return { success: false, data: null, error: details === undefined ? { code, message } : { code, message, details } };
}

/** An expected failure with a stable machine-readable code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const unauthorized = (message = 'authentication required') => new AppError(401, 'UNAUTHORIZED', message);

const STACK_FRAME_RE = /^ {4}at (?:\S.* \()?(?:file:\/\/|node:|\/)\S*:\d+:\d+\)?$/;

/**
 * What may be logged about an unexpected error. Database errors carry the
 * query parameters in their message — user text, openids, token hashes — so
 * no message is logged at all: only the error class, the SQLSTATE and the
 * stack frames (the frames without the message line).
 */
export function loggableError(error: unknown): { errName: string; sqlState?: string; frames?: string } {
  const root = error instanceof DrizzleQueryError ? error.cause : error;
  // Some libraries (drizzle's DrizzleQueryError) leave `name` as "Error".
  const errName = error instanceof Error ? (error.constructor.name !== 'Error' ? error.constructor.name : error.name) : typeof error;
  const sqlState = root && typeof root === 'object' && 'code' in root && typeof root.code === 'string' ? root.code : undefined;
  // Only lines shaped like V8 stack frames ("    at fn (file:line:col)"): a
  // multi-line message (e.g. a user's text inside query params) may contain
  // lines that merely start with "at".
  const frames = error instanceof Error && error.stack
    ? error.stack.split('\n').filter((line) => STACK_FRAME_RE.test(line)).slice(0, 8).join('\n')
    : undefined;
  return { errName, ...(sqlState ? { sqlState } : {}), ...(frames ? { frames } : {}) };
}

/**
 * Map errors to envelopes. Validation errors list only the offending paths and
 * messages — never the submitted values, which may be private user text.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(fail(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      return reply.status(400).send(fail('VALIDATION_FAILED', 'request validation failed', issues));
    }
    const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send(fail('BAD_REQUEST', error.message));
    }
    request.log.error(loggableError(error), 'unhandled error');
    return reply.status(500).send(fail('INTERNAL', 'internal server error'));
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send(fail('NOT_FOUND', 'route not found')));
}
