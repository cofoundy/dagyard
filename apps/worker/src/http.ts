import type { ApiError, ErrorCode, ErrorReason } from '@dagyard/model';

const STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  cycle: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
  unavailable: 503,
  overloaded: 503,
  uncertain: 503,
};

/** Error con la forma del contrato: `{"error": {"code", "message", "reason"?}}`, mensaje en español. */
export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason?: ErrorReason,
  ) {
    super(message);
  }
  get status(): number {
    return STATUS[this.code];
  }
}

export const fail = (code: ErrorCode, message: string, reason?: ErrorReason): never => {
  throw new ApiFailure(code, message, reason);
};

/** El 409 de un duplicado: `conflict` como siempre, con `reason: 'exists'` (#110). */
export const exists = (message: string): never => fail('conflict', message, 'exists');

export function errorResponse(code: ErrorCode, message: string, headers?: HeadersInit, reason?: ErrorReason): Response {
  const body: ApiError = { error: { code, message, ...(reason ? { reason } : {}) } };
  return Response.json(body, { status: STATUS[code], headers });
}

export const notFound = (what: string): never => fail('not_found', `${what} no existe`);
