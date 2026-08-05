import { ZodError } from 'zod';
import { env } from '@/env';

/**
 * Standard API Error Response Shape
 * This ensures all API errors (4xx, 5xx) look the same to clients.
 */
export type ApiErrorResponse = {
    error: {
        code: string;          // e.g., "VALIDATION_ERROR", "UNAUTHORIZED", "INTERNAL", "NOT_FOUND"
        message: string;       // Safe, user-facing error message
        requestId?: string;    // Correlation ID for logs
        details?: unknown;     // Optional safe details (like Zod validation issues)
    };
};

/**
 * Custom AppError for internal throwing.
 * Use these to safely bubble up known errors to the `withApiErrorHandling` wrapper.
 */
export class AppError extends Error {
    public readonly code: string;
    public readonly status: number;
    public readonly expose: boolean;
    public readonly details?: unknown;

    constructor(
        message: string,
        code: string,
        status: number,
        expose: boolean = true,
        details?: unknown
    ) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.status = status;
        this.expose = expose;
        this.details = details;

        // Ensure accurate stack traces in V8 environments
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

// ── Typed Error Subclasses ──
// These allow `instanceof` discrimination in catch blocks and tests,
// while preserving the same code/status/expose semantics as the base AppError.

export class ValidationError extends AppError {
    constructor(message: string, details?: unknown) {
        super(message, 'BAD_REQUEST', 400, true, details);
        this.name = 'ValidationError';
    }
}

export class NotFoundError extends AppError {
    constructor(message: string = 'Not Found') {
        super(message, 'NOT_FOUND', 404, true);
        this.name = 'NotFoundError';
    }
}

export class ForbiddenError extends AppError {
    constructor(message: string = 'Forbidden') {
        super(message, 'FORBIDDEN', 403, true);
        this.name = 'ForbiddenError';
    }
}

export class UnauthorizedError extends AppError {
    constructor(message: string = 'Unauthorized') {
        super(message, 'UNAUTHORIZED', 401, true);
        this.name = 'UnauthorizedError';
    }
}

export class ConflictError extends AppError {
    constructor(message: string = 'Conflict', details?: unknown) {
        super(message, 'CONFLICT', 409, true, details);
        this.name = 'ConflictError';
    }
}

export class RateLimitedError extends AppError {
    constructor(message: string = 'Too many requests') {
        super(message, 'RATE_LIMITED', 429, true);
        this.name = 'RateLimitedError';
    }
}

export class GoneError extends AppError {
    constructor(message: string = 'Gone') {
        super(message, 'GONE', 410, true);
        this.name = 'GoneError';
    }
}

export class InternalError extends AppError {
    constructor(message: string = 'Internal Server Error') {
        super(message, 'INTERNAL', 500, false);
        this.name = 'InternalError';
    }
}

// ── Domain-Specific Error Codes ──
// Use these for errors that need machine-readable discrimination beyond HTTP status.

export type DomainErrorCode =
    | 'TENANT_ISOLATION_VIOLATION'
    | 'STALE_DATA'
    | 'DEPRECATED_RESOURCE'
    | 'CONFIGURATION_ERROR'
    | 'EXTERNAL_SERVICE_ERROR'
    | 'PAYLOAD_TOO_LARGE';

export class DomainError extends AppError {
    public readonly domainCode: DomainErrorCode;

    constructor(message: string, domainCode: DomainErrorCode, status: number = 400, details?: unknown) {
        super(message, domainCode, status, status < 500, details);
        this.name = 'DomainError';
        this.domainCode = domainCode;
    }
}

// ── Type Guard ──

export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
}

// ── Shortcut Factory Helpers (backward-compatible) ──
// These now return typed subclass instances for instanceof discrimination
// while preserving the same API: throw badRequest('msg')

export const badRequest = (message: string, details?: unknown) =>
    new ValidationError(message, details);

export const unauthorized = (message: string = 'Unauthorized') =>
    new UnauthorizedError(message);

export const forbidden = (message: string = 'Forbidden') =>
    new ForbiddenError(message);

export const notFound = (message: string = 'Not Found') =>
    new NotFoundError(message);

export const conflict = (message: string = 'Conflict') =>
    new ConflictError(message);

export const rateLimited = (message: string = 'Too many requests') =>
    new RateLimitedError(message);

export const gone = (message: string = 'Gone') =>
    new GoneError(message);

export const internal = (message: string = 'Internal Server Error') =>
    new InternalError(message);

// ── Domain-Specific Factories ──

export const tenantIsolationViolation = (message: string = 'Tenant isolation violation') =>
    new DomainError(message, 'TENANT_ISOLATION_VIOLATION', 403);

export const staleData = (
    message: string = 'Data has been modified by another user',
    details?: unknown,
) => new DomainError(message, 'STALE_DATA', 409, details);

export const deprecatedResource = (message: string = 'This resource is no longer supported') =>
    new DomainError(message, 'DEPRECATED_RESOURCE', 410);

export const configurationError = (message: string) =>
    new DomainError(message, 'CONFIGURATION_ERROR', 500);

export const externalServiceError = (message: string) =>
    new DomainError(message, 'EXTERNAL_SERVICE_ERROR', 502);

/**
 * Converts ANY thrown error into a safe ApiErrorResponse payload
 * and determines the correct HTTP status code.
 */
export function toApiErrorResponse(error: unknown, requestId?: string): { payload: ApiErrorResponse, status: number } {
    let payload: ApiErrorResponse = {
        error: {
            code: 'INTERNAL',
            message: 'An unexpected internal server error occurred',
            requestId
        }
    };
    let status = 500;

    if (error instanceof AppError) {
        status = error.status;
        payload.error.code = error.code;
        payload.error.message = error.expose ? error.message : 'An error occurred';
        if (error.details) payload.error.details = error.details;
    } else if (error instanceof ZodError) {
        status = 400;
        payload.error.code = 'VALIDATION_ERROR';
        payload.error.message = 'Invalid request payload';
        payload.error.details = error.issues.map(iss => ({
            path: iss.path,
            code: iss.code,
            message: iss.message
        }));
        // Prisma known error detection (without explicitly importing Prisma to keep Edge safe)
    } else if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as Record<string, unknown>).code === 'string') {
        const prismaError = error as { code: string; meta?: { target?: unknown }; message?: string };
        if (prismaError.code === 'P2002') {
            status = 409;
            payload.error.code = 'CONFLICT';
            payload.error.message = 'A resource with that unique constraint already exists';
            payload.error.details = prismaError.meta?.target;
        } else if (prismaError.code === 'P2025') {
            status = 404;
            payload.error.code = 'NOT_FOUND';
            payload.error.message = 'Resource not found or already deleted';
        }
    } else if (
        error instanceof Error &&
        (error.name === 'PrismaClientValidationError' ||
            error.constructor?.name === 'PrismaClientValidationError')
    ) {
        // Prisma rejected the QUERY SHAPE — an unknown enum member, a
        // missing required field, a wrong scalar type. It carries no
        // `code`, so it used to fall through to the generic INTERNAL 500
        // and become indistinguishable from a crash.
        //
        // Deliberately still 5xx, not 400. By the time a value reaches the
        // driver it has passed the route's Zod schema, so a
        // PrismaClientValidationError means OUR query construction is
        // wrong, not that the caller sent a bad request — answering 400
        // would blame the client for a server defect and hide the bug.
        // (The user-input path that used to land here — a raw string cast
        // onto an enum column — is now rejected at the boundary by
        // `z.nativeEnum`; this branch exists so the next one is
        // identifiable rather than silent.)
        //
        // Detected by name rather than `instanceof`: this module is
        // imported from Edge middleware, which cannot pull in
        // `@prisma/client` (see the comment above).
        status = 500;
        payload.error.code = 'INVALID_QUERY';
        payload.error.message = 'An unexpected internal server error occurred';
    }

    // Never leak stack traces or raw messages for 500s unless in strict dev mode testing
    if (status === 500 && env.NODE_ENV === 'test' && error instanceof Error && 'testExpose' in error && (error as Error & { testExpose?: unknown }).testExpose) {
        payload.error.details = error.message;
    }

    return { payload, status };
}
