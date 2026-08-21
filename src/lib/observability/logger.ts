/**
 * Structured Logger — Pino-backed structured JSON logging.
 *
 * Provides the canonical log format for the entire application.
 * Every log entry is auto-enriched with fields from the observability
 * request context (requestId, tenantId, userId, route) when available.
 *
 * CANONICAL LOG FIELDS:
 *   level      — Pino numeric level (mapped to debug/info/warn/error/fatal)
 *   time       — epoch ms (Pino default)
 *   msg        — human-readable message
 *   requestId  — correlation ID
 *   tenantId   — tenant scope
 *   userId     — authenticated user
 *   route      — request route pattern
 *   durationMs — elapsed time since request start
 *   component  — logical subsystem (e.g. "api", "auth", "sso", "job")
 *   err        — serialized error (Pino convention) when applicable
 *
 * REDACTION:
 *   Pino's built-in redaction strips sensitive fields at the serializer
 *   level so they never appear in the output stream.
 *
 * SAFETY:
 *   - Never log raw secrets, tokens, passwords, or full request bodies.
 *   - Sensitive fields are redacted by Pino before serialization.
 */

import pino from 'pino';
import { getRequestContext } from './context';

// ── Redaction config ──
// Paths that may contain secrets. Pino replaces their values with "[Redacted]".
const REDACT_PATHS = [
    'authorization',
    'cookie',
    'password',
    'secret',
    'token',
    'mfaCode',
    'clientSecret',
    'accessToken',
    'refreshToken',
    'idToken',
    'privateKey',
    'totpSecret',
    'req.headers.authorization',
    'req.headers.cookie',
    // Directory identifiers. Not credentials — which is exactly why they were
    // missed: the list until now was "things that authenticate", and an
    // objectGUID or a bind DN does not. It identifies a PERSON, in a line that
    // carries no RLS, no tenant scope and no retention policy, and that lands
    // in whatever aggregator the deployment uses. The notification layer
    // already refuses to put these in a mail; a log is the weaker surface, not
    // the stronger one.
    //
    // pino matches a bare key at the ROOT level only, and `log()` spreads its
    // fields into a root-level object — so these bite where they are written.
    // They do NOT reach inside a `error: '…Entra refused to disable account
    // <guid>…'` string, which is why the identity write paths also scrub their
    // error text through redactDirectoryIdentifiers before logging it. Adding
    // the key alone would have made those lines LOOK sanitised while the id sat
    // in the field beside it.
    'externalUserId',
    'distinguishedName',
    'userPrincipalName',
    'sAMAccountName',
];

// ── Determine environment ──
const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
const logLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL) || (isDev ? 'debug' : 'info');

// ── Build Pino transport ──
// In development, use pino-pretty for human-readable output.
// In production/test, emit raw JSON to stdout for log aggregators.
function buildTransport(): pino.TransportSingleOptions | undefined {
    if (!isDev) return undefined;
    // pino-pretty is externalized via next.config.js (serverComponentsExternalPackages)
    // so we can reference it directly without triggering webpack warnings.
    return {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss.l',
        },
    };
}

const transport = buildTransport();

/**
 * Base Pino instance — singleton for the process.
 * Child loggers can be created from this for subsystem-specific bindings.
 */
export const pinoInstance: pino.Logger = pino({
    level: logLevel,
    redact: {
        paths: REDACT_PATHS,
        censor: '[Redacted]',
    },
    // Pino serializers for common objects
    serializers: {
        err: pino.stdSerializers.err,
    },
    ...(transport ? { transport } : {}),
});

// ── Public API ──

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogFields {
    /** Logical subsystem */
    component?: string;
    /** Duration in ms */
    durationMs?: number;
    /** Error metadata — a string message or structured error info */
    error?: string | { name: string; message: string; stack?: string };
    /** Serialized error for Pino's err convention */
    err?: Error;
    /** Any additional safe metadata */
    [key: string]: unknown;
}

/**
 * Emit a structured log entry.
 * Auto-enriches with request context from AsyncLocalStorage.
 */
export function log(level: LogLevel, msg: string, fields?: LogFields): void {
    const ctx = getRequestContext();

    const bindings: Record<string, unknown> = {
        requestId: ctx?.requestId ?? 'unknown',
        ...(ctx?.tenantId && { tenantId: ctx.tenantId }),
        ...(ctx?.userId && { userId: ctx.userId }),
        ...(ctx?.route && { route: ctx.route }),
        ...fields,
    };

    // Auto-calculate durationMs from context if not explicitly provided
    if (bindings.durationMs === undefined && ctx?.startTime) {
        bindings.durationMs = Math.round(performance.now() - ctx.startTime);
    }

    pinoInstance[level](bindings, msg);
}

/**
 * Convenience helpers — each calls `log` with the appropriate level.
 */
export const logger = {
    debug: (msg: string, fields?: LogFields) => log('debug', msg, fields),
    info: (msg: string, fields?: LogFields) => log('info', msg, fields),
    warn: (msg: string, fields?: LogFields) => log('warn', msg, fields),
    error: (msg: string, fields?: LogFields) => log('error', msg, fields),
    fatal: (msg: string, fields?: LogFields) => log('fatal', msg, fields),
    /** Create a child logger with fixed bindings for a subsystem. */
    child: (bindings: Record<string, unknown>): pino.Logger => pinoInstance.child(bindings),
} as const;

/**
 * Create a child logger with fixed bindings for a subsystem.
 * The child automatically inherits redaction and level settings.
 *
 * @example
 *   const ssoLogger = createChildLogger({ component: 'sso' });
 *   ssoLogger.info('SSO callback received');
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
    return pinoInstance.child(bindings);
}

/**
 * Helper: extract safe error metadata from an Error instance.
 * Use this when attaching error info to log fields.
 *
 * @example
 *   logger.error('Request failed', { error: extractErrorMeta(err) });
 */
export function extractErrorMeta(err: unknown): LogFields['error'] {
    if (err instanceof Error) {
        return {
            name: err.constructor.name,
            message: err.message,
            stack: err.stack,
        };
    }
    return {
        name: 'UnknownError',
        message: String(err),
    };
}
