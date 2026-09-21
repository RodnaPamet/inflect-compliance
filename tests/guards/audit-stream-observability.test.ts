/**
 * Structural ratchet — audit-stream delivery stays OTel-instrumented.
 *
 * REGRESSION CLASS
 * ----------------
 * `audit-stream.ts` once tracked delivery failures with a
 * module-level `_deliveryFailureCount` counter — an in-memory
 * number, invisible beyond logs, lost on restart. The roadmap-2 P1
 * remediation replaced it with real OpenTelemetry metrics
 * (`recordAuditStreamDelivery` and friends in
 * `src/lib/observability/metrics.ts`): success/failure counters, a
 * retry-attempts histogram, a delivery-duration histogram, a
 * buffer-overflow counter, and a buffer-depth observable gauge.
 *
 * The failure mode this guard prevents: a future refactor quietly
 * dropping the OTel calls and degrading back to logs-plus-an-
 * in-memory-counter — audit delivery failures going silent again.
 *
 * This is a structural scan (no DB, no OTel runtime). The behaviour
 * of the metrics is covered by `tests/unit/audit-trail-stream.test.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const AUDIT_STREAM = read('src/app-layer/events/audit-stream.ts');
const METRICS = read('src/lib/observability/metrics.ts');

/** The six OTel instruments that make audit-stream delivery observable. */
const AUDIT_STREAM_METRICS = [
    'audit_stream.delivery.success',
    'audit_stream.delivery.failures',
    'audit_stream.delivery.attempts',
    'audit_stream.delivery.duration',
    'audit_stream.buffer.overflow_dropped',
    'audit_stream.buffer.depth',
];

describe('audit-stream observability — delivery is OTel-instrumented', () => {
    it('audit-stream.ts records every batch outcome via recordAuditStreamDelivery', () => {
        expect(AUDIT_STREAM).toMatch(/recordAuditStreamDelivery\(/);
    });

    it('the delivery record carries an outcome — success AND failure are metered', () => {
        // A regression that only recorded failures would lose the
        // success/failure ratio. The call MUST pass `outcome:`.
        expect(AUDIT_STREAM).toMatch(/recordAuditStreamDelivery\(\{[\s\S]*?outcome:/);
    });

    it('audit-stream.ts records buffer pressure (overflow counter + depth gauge)', () => {
        expect(AUDIT_STREAM).toMatch(/recordAuditStreamBufferOverflow\(/);
        expect(AUDIT_STREAM).toMatch(/startAuditStreamBufferReporting\(/);
    });

    it('audit-stream.ts has NOT regressed to an in-memory failure counter', () => {
        // `_deliveryFailureCount` was the pre-remediation module-level
        // counter. Its return would mean delivery failures are once
        // again invisible beyond logs.
        expect(AUDIT_STREAM).not.toContain('_deliveryFailureCount');
    });

    it('metrics.ts defines all six audit-stream instruments', () => {
        for (const metric of AUDIT_STREAM_METRICS) {
            expect(METRICS).toContain(metric);
        }
    });

    it('metrics.ts exports the audit-stream recorders', () => {
        expect(METRICS).toMatch(/export function recordAuditStreamDelivery/);
        expect(METRICS).toMatch(/export function recordAuditStreamBufferOverflow/);
        expect(METRICS).toMatch(/export function startAuditStreamBufferReporting/);
    });
});
