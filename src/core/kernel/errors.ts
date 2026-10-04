export type ErrorCode =
  | 'not_found'
  | 'invalid_argument'
  | 'conflict'
  | 'permission_denied'
  | 'unavailable'
  | 'timeout'
  | 'aborted'
  | 'provider_error'
  | 'provider_auth'
  | 'rate_limited'
  | 'invalid_response'
  | 'opencode_error'
  | 'git_error'
  | 'vault_error'
  | 'internal'

const STATUS_LIKE: Record<ErrorCode, number> = {
  not_found: 404,
  invalid_argument: 400,
  conflict: 409,
  permission_denied: 403,
  unavailable: 503,
  timeout: 504,
  aborted: 499,
  provider_error: 502,
  provider_auth: 401,
  rate_limited: 429,
  invalid_response: 502,
  opencode_error: 502,
  git_error: 500,
  vault_error: 500,
  internal: 500,
}

/** Error type carried across every layer; `code` drives retry/fallback policy. */
export class AppError extends Error {
  readonly code: ErrorCode
  override readonly cause?: unknown
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.cause = options?.cause
    this.details = options?.details
  }

  get retryable(): boolean {
    return this.code === 'timeout' || this.code === 'unavailable' || this.code === 'rate_limited' || this.code === 'provider_error'
  }

  toHttpLike(): number {
    return STATUS_LIKE[this.code]
  }

  static from(err: unknown, fallback: ErrorCode = 'internal'): AppError {
    if (err instanceof AppError) return err
    const message = err instanceof Error ? err.message : String(err)
    return new AppError(fallback, message, { cause: err })
  }

  static is(err: unknown, ...codes: ErrorCode[]): err is AppError {
    return err instanceof AppError && (codes.length === 0 || codes.includes(err.code))
  }
}

export const notFound = (what: string, id?: string) =>
  new AppError('not_found', id ? `${what} not found: ${id}` : `${what} not found`)
export const invalid = (message: string, details?: Record<string, unknown>) => new AppError('invalid_argument', message, { details })
