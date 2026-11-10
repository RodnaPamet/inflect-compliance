/**
 * The logger for a standalone process: the BullMQ worker and the scheduler (#5022).
 *
 * Those two processes start from `scripts/` and log before, around and outside
 * any request context, so they cannot use `log()` from `./logger`, which reads
 * one. They each built a bare `pino()` instead, and its lines carried no
 * `requestId`. That mattered more than it looks: the Ops Agent on the
 * production VM (`deploy/ops-agent-config.yaml`) ships a container line to
 * Cloud Logging only if its text contains `requestId`, which is how it tells
 * the app's Pino JSON from pgbouncer's plain text. So every line the worker
 * wrote about a job, including "job processing failed", stayed in a container
 * log that Watchtower discards on every new image. Measured on 2026-11-10:
 * none of the worker's own messages in seven days of Cloud Logging.
 *
 * Every line from this logger carries `requestId`, set to the process name,
 * the way `log()` sets `'unknown'` outside a request. A field passed to a call
 * still wins, so a line that knows its job can name it.
 *
 * Imports nothing but pino: the worker bundle is built from `scripts/` and
 * should not pull the observability barrel in for one logger.
 * `tests/unit/observability/process-logger.test.ts` holds the lines to the
 * agent's filter, read from the config file itself.
 */
import pino from 'pino';

export type ProcessName = 'worker' | 'scheduler';

export function createProcessLogger(
    processName: ProcessName,
    destination?: pino.DestinationStream,
): pino.Logger {
    const pretty = process.env.NODE_ENV !== 'production' && destination === undefined;
    return pino(
        {
            level: process.env.LOG_LEVEL || 'info',
            mixin: () => ({ requestId: processName }),
            transport: pretty
                ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' } }
                : undefined,
        },
        destination,
    );
}
