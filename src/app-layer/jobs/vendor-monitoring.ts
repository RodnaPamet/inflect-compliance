/**
 * Vendor continuous-monitoring sweep.
 *
 * Runs the posture monitor (breach / attestation-expiry / TLS) for every
 * enabled `VendorMonitor`, then fires the vendor-reassessment cadence reminder
 * so cert-expiry, N-month, and posture-change triggers all flow through one
 * daily pass. No-op when `VENDOR_MONITOR_ENABLED=0` (air-gapped deployments
 * that can't reach the public feeds).
 *
 * Idempotent: posture events dedupe by fingerprint, findings by sourceRef,
 * notifications by dedupeKey — a re-run is safe. Per-vendor try/catch so one
 * vendor's provider failure doesn't sink the sweep.
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { runVendorMonitor } from '../usecases/vendor-monitoring';
import { runVendorReassessmentReminder } from '../usecases/vendor-reassessment-reminder';
import { env } from '@/env';
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context';
import type { JobRunResult } from './types';

function makeSystemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'vendor-monitoring', discriminator: String(Date.now()) });
}

export async function runVendorMonitoringJob(options?: {
    tenantId?: string;
    vendorId?: string;
    now?: Date;
}): Promise<{ result: JobRunResult; scanned: number; actioned: number }> {
    return runJob('vendor-monitoring', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const now = options?.now ?? new Date();

        if (env.VENDOR_MONITOR_ENABLED === '0') {
            logger.info('vendor-monitoring: disabled via VENDOR_MONITOR_ENABLED=0', { component: 'job' });
            return {
                result: buildResult(startedAt, startMs, 0, 0, { disabled: true }),
                scanned: 0,
                actioned: 0,
            };
        }

        // Find enabled monitors (optionally scoped). We sweep monitors that
        // exist; a vendor with no monitor row yet is picked up the first time
        // its posture is inspected on-demand (which creates the row).
        const monitors = await prisma.vendorMonitor.findMany({
            where: {
                enabled: true,
                ...(options?.tenantId ? { tenantId: options.tenantId } : {}),
                ...(options?.vendorId ? { vendorId: options.vendorId } : {}),
            },
            select: { tenantId: true, vendorId: true },
            take: 5000,
        });

        let scanned = 0;
        let actioned = 0;
        let errored = 0;

        for (const m of monitors) {
            scanned++;
            try {
                const ctx = makeSystemCtx(m.tenantId);
                const r = await runVendorMonitor(ctx, { vendorId: m.vendorId, now });
                if (r.eventsCreated > 0 || r.findingsCreated > 0) actioned++;
            } catch (err) {
                errored++;
                logger.warn('vendor-monitoring: per-vendor run failed', {
                    component: 'job',
                    tenantId: m.tenantId,
                    vendorId: m.vendorId,
                    err: err instanceof Error ? err : new Error(String(err)),
                });
            }
        }

        // Reassessment cadence reminder — reuse the existing sweep so cert
        // expiry / N-month / posture-change all trigger reassessment in one
        // daily pass. (This finally wires the previously-orphaned reminder.)
        let reminded = 0;
        try {
            const rr = await runVendorReassessmentReminder({ tenantId: options?.tenantId, now });
            reminded = rr.reminded;
        } catch (err) {
            logger.warn('vendor-monitoring: reassessment reminder failed', {
                component: 'job',
                err: err instanceof Error ? err : new Error(String(err)),
            });
        }

        logger.info('vendor-monitoring: sweep complete', { component: 'job', scanned, actioned, errored, reminded });
        return {
            result: buildResult(startedAt, startMs, scanned, actioned + reminded, { errored, reminded }),
            scanned,
            actioned,
        };
    });
}

function buildResult(
    startedAt: string,
    startMs: number,
    scanned: number,
    actioned: number,
    details: Record<string, unknown>,
): JobRunResult {
    const completedAt = new Date().toISOString();
    return {
        jobName: 'vendor-monitoring',
        jobRunId: crypto.randomUUID(),
        success: true,
        startedAt,
        completedAt,
        durationMs: Math.round(performance.now() - startMs),
        itemsScanned: scanned,
        itemsActioned: actioned,
        itemsSkipped: 0,
        details,
    };
}
