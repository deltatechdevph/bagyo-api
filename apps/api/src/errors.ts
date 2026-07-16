import { DOCS_BASE_URL } from '@bagyo/shared';

/** Application error carrying the public error envelope fields. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly docsPath = '',
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  envelope() {
    return {
      error: {
        code: this.code,
        message: this.message,
        docs: `${DOCS_BASE_URL}${this.docsPath}`,
      },
    };
  }
}

export const unauthorized = (message = 'Missing or invalid API key') =>
  new ApiError(401, 'UNAUTHORIZED', message, '#authentication');
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError(
    429,
    'RATE_LIMITED',
    'Daily request quota exceeded for this API key',
    '#rate-limits',
    {
      'retry-after': String(retryAfterSeconds),
    },
  );
