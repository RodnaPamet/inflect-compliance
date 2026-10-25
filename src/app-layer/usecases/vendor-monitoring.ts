/**
 * Continuous vendor monitoring — the "assessed once → continuously assured"
 * engine.
 *
 * A vendor assessment is a point-in-time snapshot that goes stale the moment
 * it's signed. This usecase is the always-on companion: on every run it
 * re-checks a vendor's posture across three free/public signal families and,
 * when posture changes, takes action.
 *
 *   1. ATTESTATION EXPIRY — the parsed SOC 2 / ISO cert period (from the
 *      vendor-doc extraction). An expired report flips the vendor into
 *      reassessment-due (`nextReviewAt = now`) + records the timeline +
 *      (opt-in) materialises a Finding + notifies the owner.
 *   2. BREACH INTELLIGENCE — a keyless public breach-feed domain check. A
 *      newly-seen breach flips the vendor into reassessment-due + records the
 *      timeline + (opt-in) materialises a Finding + notifies the owner.
 *   3. TLS / SECURITY-HEADER GRADE — a light public grade of the vendor's
 *      site. Records the timeline + updates rolling state; informational.
 *
 * Every posture change lands one idempotent `VendorPostureEvent` (the
 * continuous-assurance timeline). Findings materialise ONLY when the tenant
 * opts in via `VendorMonitor.materializeFindings` — mirroring the vendor-doc
 * propose-not-commit stance: monitoring always records + notifies, but a
 * scored Finding is a deliberate escalation. All external signals ride the
 * shared provider + `fetchWithRetry` seam, never a parallel fetch path.
 */
import { z } from 'zod';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { createFinding } from './finding';
import { resolveTenantSlugForLinks, tenantPageLink } from '../notifications/tenant-link';
import { getBreachProvider } from '@/app-layer/services/vendor-monitoring/breach-provider';
import { getTlsProvider } from '@/app-layer/services/vendor-monitoring/tls-provider';
import {
    evaluateAttestations,
    isNewBreach,
    isFailingGrade,
    type AttestationView,
} from '@/app-layer/services/vendor-monitoring/evaluate';
import type { BreachSignal, TlsSignal } from '@/app-layer/services/vendor-monitoring/types';
import { env } from '@/env';
import type { FindingSeverity } from '@prisma/client';

/** Finding provenance tags — the only linkage between a Finding and a vendor. */
export const VENDOR_BREACH_KIND = 'VENDOR_BREACH';
export const VENDOR_ATTESTATION_EXPIRED_KIND = 'VENDOR_ATTESTATION_EXPIRED';

export const RunVendorMonitorSchema = z.object({
    vendorId: z.string().min(1),
    /** Override "now" (tests). */
    now: z.date().optional(),
    /** Inject a breach signal (tests) — skips the provider fetch. */
    breachSignal: z.custom<BreachSignal>().optional(),
    /** Inject a TLS signal (tests) — skips the provider fetch. */
    tlsSignal: z.custom<TlsSignal>().optional(),
});
export type RunVendorMonitorInput = z.input<typeof RunVendorMonitorSchema>;

export interface VendorMonitorResult {
    vendorId: string;
    ran: boolean;
    attestationStatus: 'EXPIRED' | 'EXPIRING' | 'OK';
    breachDetected: boolean;
    tlsGrade: string | null;
    reassessmentTriggered: boolean;
    eventsCreated: number;
    findingsCreated: number;
    notified: number;
}

/** Derive a registrable domain from vendor.domain or websiteUrl. */
function resolveDomain(vendor: { domain: string | null; websiteUrl: string | null }): string | null {
    if (vendor.domain) return vendor.domain.trim().toLowerCase();
    if (vendor.websiteUrl) {
        try {
            return new URL(vendor.websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
        } catch {
            return null;
        }
    }
    return null;
}

function dayStamp(d: Date): string {
    return d.toISOString().slice(0, 10);
}

interface PlannedEvent {
    eventType: string;
    severity: string;
    source: string;
    summary: string;
    fingerprint: string;
    detailsJson: Record<string, unknown>;
    /** Finding provenance to materialise (opt-in), if this event escalates. */
    finding?: { kind: string; sourceRef: string; severity: FindingSeverity; title: string; description: string };
}

/**
 * Run the monitor for a single vendor. Called on-demand (API "run now") with a
 * request ctx, and by the `vendor-monitoring` sweep with a system ctx.
 */
export async function runVendorMonitor(
    ctx: RequestContext,
    rawInput: RunVendorMonitorInput,
): Promise<VendorMonitorResult> {
    assertCanWrite(ctx);
    const input = RunVendorMonitorSchema.parse(rawInput);
    const now = input.now ?? new Date();

    // ── Phase A: load vendor + monitor (create default if absent) + the
    //    latest dated attestations + existing vendor findings. ──
    const loaded = await runInTenantContext(ctx, async (db) => {
        const vendor = await db.vendor.findFirst({
            where: { id: input.vendorId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, domain: true, websiteUrl: true, ownerUserId: true, nextReviewAt: true, status: true },
        });
        if (!vendor) throw notFound('Vendor not found');

        const existingMonitor = await db.vendorMonitor.findUnique({
            where: { tenantId_vendorId: { tenantId: ctx.tenantId, vendorId: vendor.id } },
        });
        const monitor = existingMonitor ?? await db.vendorMonitor.create({
            data: { tenantId: ctx.tenantId, vendorId: vendor.id },
        });

        const extractions = await db.vendorDocExtraction.findMany({
            where: { tenantId: ctx.tenantId, vendorId: vendor.id, auditPeriodEnd: { not: null } },
            select: { id: true, reportType: true, auditPeriodEnd: true },
            orderBy: { auditPeriodEnd: 'asc' },
            take: 100,
        });

        const existingFindings = await db.finding.findMany({
            where: {
                tenantId: ctx.tenantId,
                sourceKind: { in: [VENDOR_BREACH_KIND, VENDOR_ATTESTATION_EXPIRED_KIND] },
                deletedAt: null,
            },
            select: { id: true, sourceRef: true },
            take: 5000,
        });

        return { vendor, monitor, extractions, existingFindings };
    });

    const { vendor, monitor, extractions, existingFindings } = loaded;
    if (!monitor.enabled) {
        return { vendorId: vendor.id, ran: false, attestationStatus: 'OK', breachDetected: false, tlsGrade: monitor.tlsGrade, reassessmentTriggered: false, eventsCreated: 0, findingsCreated: 0, notified: 0 };
    }

    const domain = resolveDomain(vendor);
    const planned: PlannedEvent[] = [];
    let reassessmentTriggered = false;
    let attestationStatus: VendorMonitorResult['attestationStatus'] = 'OK';
    let breachDetected = false;
    let tlsGrade: string | null = monitor.tlsGrade;
    let newBreachAt: Date | null = null;
    let newTlsCheckedAt: Date | null = null;

    // ── Signal 1: attestation expiry. ──
    if (monitor.checkAttestation) {
        const views: AttestationView[] = extractions.map((e) => ({ extractionId: e.id, reportType: e.reportType, auditPeriodEnd: e.auditPeriodEnd }));
        const verdict = evaluateAttestations(views, now);
        attestationStatus = verdict.status;
        if (verdict.status === 'EXPIRED' && verdict.governing) {
            const g = verdict.governing;
            reassessmentTriggered = true;
            planned.push({
                eventType: 'ATTESTATION_EXPIRED',
                severity: 'HIGH',
                source: 'internal',
                summary: `${g.reportType ?? 'Attestation'} expired (period ended ${dayStamp(g.auditPeriodEnd!)}) — assessment is stale`,
                fingerprint: `attestation-expired:${vendor.id}:${g.extractionId}`,
                detailsJson: { extractionId: g.extractionId, reportType: g.reportType, expiredAt: g.auditPeriodEnd!.toISOString() },
                finding: {
                    kind: VENDOR_ATTESTATION_EXPIRED_KIND,
                    sourceRef: `${vendor.id}:${g.extractionId}`,
                    severity: 'MEDIUM' as FindingSeverity,
                    title: `Vendor attestation expired — ${vendor.name}`.slice(0, 250),
                    description: `${g.reportType ?? 'Attestation'} for vendor "${vendor.name}" expired (period ended ${dayStamp(g.auditPeriodEnd!)}). The signed assessment no longer reflects a current attestation; reassessment is due.`,
                },
            });
            planned.push({
                eventType: 'REASSESSMENT_TRIGGERED',
                severity: 'MEDIUM',
                source: 'internal',
                summary: `Reassessment triggered by expired attestation`,
                fingerprint: `reassessment:attestation:${vendor.id}:${g.extractionId}`,
                detailsJson: { reason: 'attestation_expired', extractionId: g.extractionId },
            });
        } else if (verdict.status === 'EXPIRING' && verdict.governing) {
            const g = verdict.governing;
            planned.push({
                eventType: 'ATTESTATION_EXPIRING',
                severity: 'LOW',
                source: 'internal',
                summary: `${g.reportType ?? 'Attestation'} expires ${dayStamp(g.auditPeriodEnd!)} (within 30 days)`,
                fingerprint: `attestation-expiring:${vendor.id}:${g.extractionId}:${dayStamp(g.auditPeriodEnd!)}`,
                detailsJson: { extractionId: g.extractionId, reportType: g.reportType, expiresAt: g.auditPeriodEnd!.toISOString() },
            });
        }
    }

    // ── Signal 2: breach intelligence. ──
    if (monitor.checkBreach && domain) {
        const signal = input.breachSignal ?? await getBreachProvider(env.VENDOR_MONITOR_BREACH_PROVIDER).check(domain);
        if (isNewBreach(signal, monitor.breachLastSeenAt)) {
            breachDetected = true;
            reassessmentTriggered = true;
            newBreachAt = new Date(signal.latestBreachAt!);
            const breachKey = signal.latestBreachAt!;
            const names = signal.breaches.map((b) => b.name).slice(0, 5).join(', ');
            planned.push({
                eventType: 'BREACH_DETECTED',
                severity: 'HIGH',
                source: signal.source,
                summary: `Vendor domain ${domain} appeared in a breach (${dayStamp(newBreachAt)})`,
                fingerprint: `breach:${vendor.id}:${breachKey}`,
                detailsJson: { domain, latestBreachAt: signal.latestBreachAt, breaches: signal.breaches.slice(0, 20) },
                finding: {
                    kind: VENDOR_BREACH_KIND,
                    sourceRef: `${vendor.id}:${breachKey}`,
                    severity: 'HIGH' as FindingSeverity,
                    title: `Vendor breach detected — ${vendor.name}`.slice(0, 250),
                    description: `Vendor "${vendor.name}" (${domain}) appeared in a monitored breach feed with a breach dated ${dayStamp(newBreachAt)}${names ? `: ${names}` : ''}. Re-assess the vendor's posture and containment.`,
                },
            });
            planned.push({
                eventType: 'REASSESSMENT_TRIGGERED',
                severity: 'MEDIUM',
                source: 'internal',
                summary: `Reassessment triggered by breach activity`,
                fingerprint: `reassessment:breach:${vendor.id}:${breachKey}`,
                detailsJson: { reason: 'breach', breachAt: signal.latestBreachAt },
            });
        }
    }

    // ── Signal 3: TLS / security-header grade (light — timeline + state). ──
    if (monitor.checkTls && domain) {
        const signal = input.tlsSignal ?? await getTlsProvider(env.VENDOR_MONITOR_TLS_PROVIDER).grade(domain);
        if (signal.grade && signal.grade !== monitor.tlsGrade) {
            tlsGrade = signal.grade;
            newTlsCheckedAt = new Date(signal.checkedAt);
            planned.push({
                eventType: 'TLS_GRADE',
                severity: isFailingGrade(signal.grade) ? 'MEDIUM' : 'INFO',
                source: signal.source,
                summary: `TLS / security-header grade for ${domain}: ${signal.grade}${monitor.tlsGrade ? ` (was ${monitor.tlsGrade})` : ''}`,
                fingerprint: `tls:${vendor.id}:${signal.grade}:${dayStamp(newTlsCheckedAt)}`,
                detailsJson: { domain, grade: signal.grade, present: signal.presentHeaders, missing: signal.missingHeaders },
            });
        } else if (signal.grade) {
            tlsGrade = signal.grade;
            newTlsCheckedAt = new Date(signal.checkedAt);
        }
    }

    // ── Materialise findings (opt-in), OUTSIDE the tenant tx — createFinding
    //    opens its own. Idempotent by (sourceKind, sourceRef). ──
    const findingBySourceRef = new Map(existingFindings.map((f) => [f.sourceRef, f.id]));
    let findingsCreated = 0;
    if (monitor.materializeFindings) {
        for (const p of planned) {
            if (!p.finding) continue;
            if (findingBySourceRef.has(p.finding.sourceRef)) continue;
            const created = await createFinding(ctx, {
                severity: p.finding.severity,
                type: 'OBSERVATION',
                title: p.finding.title,
                description: p.finding.description,
                sourceKind: p.finding.kind,
                sourceRef: p.finding.sourceRef,
            });
            findingBySourceRef.set(p.finding.sourceRef, created.id);
            findingsCreated++;
        }
    }

    // ── Phase B: persist events (idempotent) + vendor/monitor state +
    //    notifications + audit. ──
    const { eventsCreated, notified } = await runInTenantContext(ctx, async (db) => {
        let evCreated = 0;
        for (const p of planned) {
            const res = await db.vendorPostureEvent.createMany({
                data: [{
                    tenantId: ctx.tenantId,
                    vendorId: vendor.id,
                    eventType: p.eventType,
                    severity: p.severity,
                    source: p.source,
                    summary: p.summary,
                    fingerprint: p.fingerprint,
                    detailsJson: p.detailsJson as object,
                    createdFindingId: p.finding ? findingBySourceRef.get(p.finding.sourceRef) ?? null : null,
                    occurredAt: now,
                }],
                skipDuplicates: true,
            });
            evCreated += res.count;
        }

        // Flip the vendor into reassessment-due when posture changed.
        if (reassessmentTriggered && (vendor.nextReviewAt == null || vendor.nextReviewAt > now)) {
            await db.vendor.update({ where: { id: vendor.id }, data: { nextReviewAt: now } });
        }

        // Refresh rolling monitor state.
        await db.vendorMonitor.update({
            where: { tenantId_vendorId: { tenantId: ctx.tenantId, vendorId: vendor.id } },
            data: {
                lastRunAt: now,
                lastRunStatus: 'OK',
                lastError: null,
                ...(newBreachAt ? { breachLastSeenAt: newBreachAt, breachCount: { increment: 1 } } : {}),
                ...(tlsGrade ? { tlsGrade } : {}),
                ...(newTlsCheckedAt ? { tlsCheckedAt: newTlsCheckedAt } : {}),
                attestationExpiresAt: extractions.length ? extractions[0].auditPeriodEnd : null,
            },
        });

        // Notify the vendor owner on genuine posture changes (not on TLS-only
        // or expiring-soon nudges — those are informational). Deduped per
        // (vendor, day) so a re-run is a no-op.
        let notifiedCount = 0;
        const alerting = planned.filter((p) => p.eventType === 'BREACH_DETECTED' || p.eventType === 'ATTESTATION_EXPIRED');
        if (vendor.ownerUserId && alerting.length > 0 && evCreated > 0) {
            // `/t/<slug>`-prefixed — a bare `/vendors/<id>` 404'd from the bell
            // (#4128). The sweep runs under a system context with no slug, so
            // the helper looks it up.
            const linkUrl = tenantPageLink(await resolveTenantSlugForLinks(db, ctx), `/vendors/${vendor.id}`);
            const res = await db.notification.createMany({
                data: alerting.map((p) => ({
                    tenantId: ctx.tenantId,
                    userId: vendor.ownerUserId!,
                    type: 'VENDOR_POSTURE_ALERT' as const,
                    title: p.eventType === 'BREACH_DETECTED' ? `Vendor breach: ${vendor.name}` : `Vendor attestation expired: ${vendor.name}`,
                    message: p.summary,
                    linkUrl,
                    dedupeKey: `${ctx.tenantId}:VENDOR_POSTURE_ALERT:${p.fingerprint}:${vendor.ownerUserId}:${dayStamp(now)}`,
                })),
                skipDuplicates: true,
            });
            notifiedCount = res.count;
        }

        await logEvent(db, ctx, {
            action: 'VENDOR_MONITOR_RUN',
            entityType: 'Vendor',
            entityId: vendor.id,
            details: `Monitored ${vendor.name}: attestation=${attestationStatus}, breach=${breachDetected}, tls=${tlsGrade ?? 'n/a'} — ${evCreated} posture events, ${findingsCreated} findings`,
            detailsJson: { category: 'custom', event: 'vendor_monitor_run' },
            metadata: { vendorId: vendor.id, attestationStatus, breachDetected, tlsGrade, reassessmentTriggered, eventsCreated: evCreated, findingsCreated },
        });

        return { eventsCreated: evCreated, notified: notifiedCount };
    });

    return {
        vendorId: vendor.id,
        ran: true,
        attestationStatus,
        breachDetected,
        tlsGrade,
        reassessmentTriggered,
        eventsCreated,
        findingsCreated,
        notified,
    };
}

/** The monitor row + recent posture timeline for a vendor (read surface). */
export async function getVendorPosture(ctx: RequestContext, vendorId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const vendor = await db.vendor.findFirst({
            where: { id: vendorId, tenantId: ctx.tenantId },
            select: { id: true, name: true, nextReviewAt: true },
        });
        if (!vendor) throw notFound('Vendor not found');
        const monitor = await db.vendorMonitor.findUnique({
            where: { tenantId_vendorId: { tenantId: ctx.tenantId, vendorId } },
        });
        const events = await db.vendorPostureEvent.findMany({
            where: { tenantId: ctx.tenantId, vendorId },
            orderBy: { occurredAt: 'desc' },
            take: 100,
        });
        // Provider mode so the UI can honestly flag demo/stub signals: breach
        // + TLS grades come from deterministic stubs unless a real provider is
        // configured via env (mirrors the getBreachProvider/getTlsProvider
        // factory selection). Attestation is always real (no provider), so
        // it's intentionally omitted here.
        const providers = {
            breach: env.VENDOR_MONITOR_BREACH_PROVIDER === 'hibp-domain' ? 'hibp-domain' : 'stub',
            tls: env.VENDOR_MONITOR_TLS_PROVIDER === 'header-grade' ? 'header-grade' : 'stub',
        };
        return { vendor, monitor, events, providers };
    });
}

/** Toggle monitoring config for a vendor (enable/disable, per-signal, findings). */
export const UpdateVendorMonitorSchema = z.object({
    enabled: z.boolean().optional(),
    checkAttestation: z.boolean().optional(),
    checkBreach: z.boolean().optional(),
    checkTls: z.boolean().optional(),
    materializeFindings: z.boolean().optional(),
});
export type UpdateVendorMonitorInput = z.infer<typeof UpdateVendorMonitorSchema>;

export async function updateVendorMonitor(ctx: RequestContext, vendorId: string, rawInput: UpdateVendorMonitorInput) {
    assertCanWrite(ctx);
    const input = UpdateVendorMonitorSchema.parse(rawInput);
    return runInTenantContext(ctx, async (db) => {
        const vendor = await db.vendor.findFirst({ where: { id: vendorId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!vendor) throw notFound('Vendor not found');
        return db.vendorMonitor.upsert({
            where: { tenantId_vendorId: { tenantId: ctx.tenantId, vendorId } },
            create: { tenantId: ctx.tenantId, vendorId, ...input },
            update: input,
        });
    });
}
