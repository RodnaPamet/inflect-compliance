/**
 * Edge-Compatible Structured Logger
 *
 * Minimal structured logging for code that runs in Next.js edge runtime
 * (middleware, edge API routes). Pino cannot be used in edge runtime
 * because it depends on Node.js worker_threads and fs.
 *
 * This logger emits structured JSON to console.* — which is the only
 * I/O channel available in edge runtime. The JSON format is intentionally
 * compatible with Pino's output so log aggregators can parse both
 * identically.
 *
 * For standard Node.js server code, use `@/lib/observability/logger` instead.
 */

export type EdgeLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<EdgeLogLevel, number> = {
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
};

interface EdgeLogFields {
    component?: string;
    [key: string]: unknown;
}

function emit(level: EdgeLogLevel, msg: string, fields?: EdgeLogFields): void {
    const entry = {
        level: LEVEL_VALUES[level],
        time: Date.now(),
        msg,
        ...fields,
        // ALWAYS present, as the Node logger's is (#5131). The production Ops
        // Agent ships a container line to Cloud Logging only when its text
        // contains both `requestId` and `msg` (deploy/ops-agent-config.yaml),
        // so a line without one never left the container: every middleware
        // document_load / soft_navigation line and every edge warning. A
        // caller's own id wins; 'unknown' otherwise, the Node logger's value.
        requestId: typeof fields?.requestId === 'string' && fields.requestId ? fields.requestId : 'unknown',
    };

    const json = JSON.stringify(entry);

    // Suppress emission in the Jest `node` test environment by default.
    // Middleware-invoking integration tests (auth-ratelimit, auth-routes)
    // otherwise flood stderr with pino-shaped JSON for every blocked
    // request. A specific test can opt back in by setting
    // `EDGE_LOGGER_IN_TEST=1` — observability-foundation.test.ts does
    // exactly that when asserting the console shape.
    if (
        process.env.NODE_ENV === 'test' &&
        process.env.EDGE_LOGGER_IN_TEST !== '1'
    ) {
        return;
    }

    switch (level) {
        case 'error':
            console.error(json);  
            break;
        case 'warn':
            console.warn(json);  
            break;
        default:
            console.log(json);  
    }
}

/**
 * Edge-compatible structured logger.
 * Output format matches Pino JSON for unified log aggregation.
 */
export const edgeLogger = {
    debug: (msg: string, fields?: EdgeLogFields) => emit('debug', msg, fields),
    info: (msg: string, fields?: EdgeLogFields) => emit('info', msg, fields),
    warn: (msg: string, fields?: EdgeLogFields) => emit('warn', msg, fields),
    error: (msg: string, fields?: EdgeLogFields) => emit('error', msg, fields),
} as const;
