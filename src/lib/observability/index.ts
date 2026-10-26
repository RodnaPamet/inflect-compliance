/**
 * Observability — barrel export.
 *
 * Public API:
 *   Context:  runWithRequestContext, getRequestContext, getRequestId, mergeRequestContext
 *   Logger:   logger, log, extractErrorMeta, createChildLogger, pinoInstance
 *   Tracing:  getTracer, traceUsecase, traceOperation, traceRepository
 *   Metrics:  recordRequestMetrics, recordRequestError
 *   Sentry:   initSentry, captureError, setSentryContext
 *   Bootstrap: initTelemetry, isTelemetryInitialized
 */

export {
    runWithRequestContext,
    getRequestContext,
    getRequestId,
    mergeRequestContext,
} from './context';
export type { RequestContextData } from './context';

export {
    logger,
    log,
    extractErrorMeta,
    createChildLogger,
    pinoInstance,
} from './logger';
export type { LogLevel, LogFields } from './logger';

export {
    getTracer,
    traceUsecase,
    traceOperation,
} from './tracing';

export {
    traceRepository,
    detectResultCount,
} from './repository-tracing';

export {
    recordRequestMetrics,
    recordRequestError,
    recordJobMetrics,
    startQueueDepthReporting,
    stopQueueDepthReporting,
    normalizeRoute,
} from './metrics';

export {
    initSentry,
    captureError,
    setSentryContext,
} from './sentry';

export {
    initTelemetry,
    isTelemetryInitialized,
} from './instrumentation';

export {
    runJob,
} from './job-runner';
