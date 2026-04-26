export class AppError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: string, message: string, options?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CONFIG_ERROR", message, { status: 500, details });
    this.name = "ConfigError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super("NOT_FOUND", message, { status: 404, details });
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, { status: 400, details });
    this.name = "ValidationError";
  }
}

export class AgentCashError extends AppError {
  constructor(message: string, details?: unknown) {
    super("AGENTCASH_ERROR", message, { status: 502, details });
    this.name = "AgentCashError";
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, details?: unknown) {
    super("TIMEOUT", message, { status: 504, details });
    this.name = "TimeoutError";
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(message: string, details?: unknown) {
    super("INSUFFICIENT_BALANCE", message, { status: 402, details });
    this.name = "InsufficientBalanceError";
  }
}

export class SpendingCapError extends AppError {
  constructor(message: string, details?: unknown) {
    super("SPENDING_CAP_EXCEEDED", message, { status: 400, details });
    this.name = "SpendingCapError";
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, details?: unknown) {
    super("RATE_LIMITED", message, { status: 429, details });
    this.name = "RateLimitError";
  }
}

export class LockUnavailableError extends AppError {
  constructor(message = "Another request is already in progress. Please retry in a moment.", details?: unknown) {
    super("LOCK_UNAVAILABLE", message, { status: 409, details });
    this.name = "LockUnavailableError";
  }
}

export class QuoteError extends AppError {
  constructor(message: string, details?: unknown) {
    super("QUOTE_ERROR", message, { status: 402, details });
    this.name = "QuoteError";
  }
}
