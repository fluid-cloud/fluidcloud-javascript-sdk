export enum ErrorCode {
  OperationNotSupported = 'OPERATION_NOT_SUPPORTED',
  ProviderNotFound = 'PROVIDER_NOT_FOUND',
  EntityNotFound = 'ENTITY_NOT_FOUND',
  InvalidCredentials = 'INVALID_CREDENTIALS',
  NotFound = 'NOT_FOUND',
  AccessDenied = 'ACCESS_DENIED',
  Validation = 'VALIDATION',
  Provider = 'PROVIDER',
}

/** Base class for every error the SDK throws. */
export class FluidCloudError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.code = code;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Thrown when the requested operation is not supported by the active provider. */
export class OperationNotSupportedError extends FluidCloudError {
  constructor(message = 'operation not supported by this provider', options?: { cause?: unknown }) {
    super(message, ErrorCode.OperationNotSupported, options);
  }
}

/** Thrown when the provider type on the entity is unknown. */
export class ProviderNotFoundError extends FluidCloudError {
  constructor(message = 'provider not found', options?: { cause?: unknown }) {
    super(message, ErrorCode.ProviderNotFound, options);
  }
}

/** Thrown when the cloud entity is not found on the FluidCloud server. */
export class EntityNotFoundError extends FluidCloudError {
  constructor(message = 'entity not found', options?: { cause?: unknown }) {
    super(message, ErrorCode.EntityNotFound, options);
  }
}

/** Thrown when credentials are missing or malformed. */
export class InvalidCredentialsError extends FluidCloudError {
  constructor(message = 'invalid or missing credentials', options?: { cause?: unknown }) {
    super(message, ErrorCode.InvalidCredentials, options);
  }
}

/** Thrown when the requested resource does not exist. */
export class NotFoundError extends FluidCloudError {
  constructor(message = 'resource not found', options?: { cause?: unknown }) {
    super(message, ErrorCode.NotFound, options);
  }
}

/** Thrown when the caller is not permitted to access the resource. */
export class AccessDeniedError extends FluidCloudError {
  constructor(message = 'access denied', options?: { cause?: unknown }) {
    super(message, ErrorCode.AccessDenied, options);
  }
}

/** Thrown when configuration fails validation. */
export class ValidationError extends FluidCloudError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field} ${message}`, ErrorCode.Validation);
    this.field = field;
  }
}

/** Wraps an underlying provider SDK error with provider and operation context. */
export class ProviderError extends FluidCloudError {
  readonly provider: string;
  readonly operation: string;

  constructor(provider: string, operation: string, cause: unknown) {
    super(`${provider}: ${operation} failed: ${messageOf(cause)}`, ErrorCode.Provider, { cause });
    this.provider = provider;
    this.operation = operation;
  }
}

/** Describes an operation that cannot be replicated on a specific provider. */
export class UnsupportedError extends FluidCloudError {
  readonly provider: string;
  readonly operation: string;
  readonly alternative: string;

  constructor(provider: string, operation: string, message: string, alternative = '') {
    const base = `${provider}: ${operation} is not supported on this provider. ${message}`;
    super(alternative ? `${base} Recommended alternative: ${alternative}` : base, ErrorCode.OperationNotSupported);
    this.provider = provider;
    this.operation = operation;
    this.alternative = alternative;
  }
}

/** Extracts a human-readable message from an unknown thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/** Reports whether err, or any error in its cause chain, carries the given code. */
export function hasCode(err: unknown, code: ErrorCode): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 16; depth++) {
    if (current instanceof FluidCloudError && current.code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Reports whether the error means "this resource does not exist". */
export function isNotFound(err: unknown): boolean {
  return hasCode(err, ErrorCode.NotFound) || hasCode(err, ErrorCode.EntityNotFound);
}

/** Reports whether the error means "you may not do this". */
export function isAccessDenied(err: unknown): boolean {
  return hasCode(err, ErrorCode.AccessDenied);
}

/** Reports whether the error means "this provider cannot do this". */
export function isUnsupported(err: unknown): boolean {
  return hasCode(err, ErrorCode.OperationNotSupported);
}

/** Rethrows cause as a ProviderError carrying provider and operation context. */
export function wrapProviderError(provider: string, operation: string, cause: unknown): never {
  if (cause instanceof UnsupportedError || cause instanceof ProviderError) throw cause;
  throw new ProviderError(provider, operation, cause);
}
