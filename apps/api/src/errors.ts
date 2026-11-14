import type { ApiErrorBody } from '@clickland/contracts';

export type ErrorCode = ApiErrorBody['error']['code'];

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  query_failed: 502,
  assistant_unavailable: 503,
  unavailable: 503,
  internal: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return STATUS[this.code];
  }

  body(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const notFound = (what: string) => new ApiError('not_found', `${what} not found`);
