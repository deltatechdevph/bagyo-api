import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { DOCS_BASE_URL } from '@bagyo/shared';
import { ApiError } from '../errors.js';

function asFastifyError(err: unknown): Partial<FastifyError> {
  if (typeof err === 'object' && err !== null) return err;
  return {};
}

/**
 * Single error mapper: every thrown error leaves as the documented envelope
 * `{ error: { code, message, docs } }`. Stack traces never leak.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers)) void reply.header(k, v);
      return reply.status(err.statusCode).send(err.envelope());
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.validation
            .map((v) => `${v.instancePath || 'input'}: ${v.message ?? 'invalid'}`)
            .join('; '),
          docs: `${DOCS_BASE_URL}#validation`,
        },
      });
    }

    const fe = asFastifyError(err);
    const status = typeof fe.statusCode === 'number' && fe.statusCode >= 400 ? fe.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong on our side.',
          docs: DOCS_BASE_URL,
        },
      });
    }
    return reply.status(status).send({
      error: {
        code: fe.code && /^[A-Z_]+$/.test(fe.code) ? fe.code : 'REQUEST_ERROR',
        message: fe.message ?? 'Request error',
        docs: DOCS_BASE_URL,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.url.split('?')[0] ?? req.url} does not exist`,
        docs: DOCS_BASE_URL,
      },
    });
  });
}
