/**
 * Scanner ingestion — the usecase that turns DevSecOps scanner output
 * (SARIF) into two compliance-graph artefacts:
 *
 *   1. AUTOMATED CONTROL EVIDENCE (the capability IC lacked). A passing
 *      run is materialised as an Evidence row + ControlEvidenceLink
 *      (kind INTEGRATION_RESULT) on the control the tenant maps the
 *      scanner to. This is IC's FIRST automated-evidence seam — the same
 *      shape future signal sources (cloud-config, IdP) plug into:
 *        resolve target control → upsert a rolling Evidence row keyed by
 *        (control, source) → refresh its freshness window.
 *      It deliberately reuses the Epic-evidence freshness sweep: the row
 *      carries a `nextReviewDate`, so if scans stop the existing
 *      stale-review sweep flips it to NEEDS_REVIEW with no new code.
 *
 *   2. FINDINGS for failures (the triage side). Findings at/above a
 *      threshold reconcile into `Finding` rows via the EXISTING
 *      `createFinding` usecase, tagged `sourceKind='SCANNER'` /
 *      `sourceRef=<fingerprint>` — the same idempotent-materialiser
 *      pattern NIS2 self-assessment (`nis2-readiness.ts`) and CVE
 *      conversion (`vulnerability.ts`) use. Re-scanning is idempotent;
 *      a finding that drops out of the scan is reconciled CLOSED.
 *
 * This is a connector of the existing "external security signal →
 * compliance graph" subsystem (sibling to the Cve/AssetVulnerability +
 * vulnerability.ts path), NOT a parallel ingestion path. There is NO
 * proprietary composite score here by design — scanner coverage is
 * expressed downstream as control-evidence completeness (a transparent,
 * framework-tied number), never an opaque grade.
 */
import { z } from 'zod';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { createFinding } from './finding';
import {
    parseSarif,
    type ScannerSeverity,
    type ScannerSource,
    type ScanType,
} from '../services/sarif';
import { mapCwes } from '../services/cwe-mapping';
import type { FindingSeverity } from '@prisma/client';
import { drainPages, DRAIN_PAGE_SIZE } from '@/app-layer/jobs/drain-pages';
import { recordScannerFindingsTruncated } from '@/lib/observability/integration-metrics';

/** Provenance tag on materialised Findings — the reconcile key space. */
export const SCANNER_SOURCE_KIND = 'SCANNER';

/** Severity ranking for threshold gating + run-outcome derivation. */
const SEVERITY_RANK: Record<ScannerSeverity, number> = {
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
};

/** Default freshness window for automated scanner evidence (days). */
const EVIDENCE_FRESHNESS_DAYS = 30;

/** Default: only HIGH+ findings materialise a Finding (don't spam on lint). */
const DEFAULT_FINDING_THRESHOLD: ScannerSeverity = 'HIGH';

/** Safety cap on Findings materialised per ingest (abuse / runaway guard). */
const MAX_FINDINGS_PER_INGEST = 100;

const SeverityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const IngestScannerRunSchema = z.object({
    /** Raw SARIF 2.1.0 document. */
    sarif: z.unknown(),
    /** Override the source inferred from the SARIF tool name. */
    source: z
        .enum(['SEMGREP', 'TRIVY', 'ZAP', 'GITLEAKS', 'CHECKOV', 'CODEQL', 'OTHER'])
        .optional(),
    scanType: z.enum(['SAST', 'SCA', 'DAST', 'SECRETS', 'IAC']).optional(),
    /** Project/repo ref the scan ran against, e.g. `owner/repo@<sha>`. */
    repoRef: z.string().max(500).optional(),
    // Only two producers exist today: programmatic API ingest + SARIF UPLOAD.
    // 'WEBHOOK' was an aspirational enum value with no entrypoint — removed
    // until a real scanner-webhook ingest route ships (don't advertise a
    // provenance the product can't actually produce).
    ingestedVia: z.enum(['API', 'UPLOAD']).default('API'),
    /** The control this scan proves (overrides the tenant mapping). */
    controlId: z.string().optional(),
    /** Min severity that materialises a Finding. Default HIGH. */
    findingThreshold: SeverityEnum.optional(),
    /** Opt out of Finding materialisation (evidence-only ingest). */
    materializeFindings: z.boolean().default(true),
    /** Explicit gate outcome from CI; else derived from the threshold. */
    outcome: z.enum(['PASS', 'FAIL', 'ERROR']).optional(),
});

export type IngestScannerRunInput = z.infer<typeof IngestScannerRunSchema>;

function toFindingSeverity(sev: ScannerSeverity): FindingSeverity {
    return sev as FindingSeverity;
}

/**
 * Resolve which control a scanner run proves. Precedence:
 *   1. explicit `controlId` on the request,
 *   2. the tenant's scanner IntegrationConnection mapping
 *      (`configJson.controlMappings[source]`),
 *   3. none — the run is recorded + findings triaged, but no automated
 *      evidence is produced (and we log that it was unmapped).
 *
 * (When an SSDF framework is installed, a tenant typically maps each
 *  scanner to the matching SSDF practice control here — but SSDF is not a
 *  prerequisite; any control the tenant chooses works.)
 */
async function resolveControlId(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    source: ScannerSource,
    explicit: string | undefined,
): Promise<string | null> {
    if (explicit) {
        const control = await db.control.findFirst({
            where: { id: explicit, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!control) throw badRequest('INVALID_CONTROL', 'Mapped control not found in this tenant');
        return control.id;
    }
    const conn = await db.integrationConnection.findFirst({
        where: { tenantId: ctx.tenantId, provider: 'scanner' },
        select: { configJson: true },
    });
    const mappings = (conn?.configJson as { controlMappings?: Record<string, string> } | null)?.controlMappings;
    const mapped = mappings?.[source];
    if (!mapped) return null;
    const control = await db.control.findFirst({
        where: { id: mapped, tenantId: ctx.tenantId },
        select: { id: true },
    });
    return control?.id ?? null;
}

export interface IngestScannerRunResult {
    scannerRunId: string;
    source: ScannerSource;
    scanType: ScanType;
    outcome: 'PASS' | 'FAIL' | 'ERROR';
    findingsIngested: number;
    controlId: string | null;
    evidenceId: string | null;
    findingsMaterialized: number;
    findingsReconciledClosed: number;
    /**
     * Above-threshold findings BEFORE the materialisation cap.
     *
     * `findingsIngested` counts every parsed finding including
     * below-threshold ones, so it cannot answer "were any of my findings
     * dropped?". This can: `findingsMaterialized + findingsTruncated` should
     * equal this.
     */
    aboveThresholdTotal: number;
    /** Above-threshold findings the cap discarded. Non-zero means loss. */
    findingsTruncated: number;
}

export async function ingestScannerRun(
    ctx: RequestContext,
    rawInput: z.input<typeof IngestScannerRunSchema>,
): Promise<IngestScannerRunResult> {
    assertCanWrite(ctx);

    // Apply schema defaults + validation HERE rather than trusting the
    // caller — the API route parses too, but direct callers (other
    // usecases, jobs, tests) must get `ingestedVia`/`materializeFindings`
    // defaults and enum validation just the same.
    const input = IngestScannerRunSchema.parse(rawInput);

    // Parse OUTSIDE the tenant transaction — pure CPU, and a malformed
    // upload should 400 before we open a DB transaction.
    let parsed;
    try {
        parsed = parseSarif(input.sarif);
    } catch (err) {
        throw badRequest('INVALID_SARIF', err instanceof Error ? err.message : 'Invalid SARIF document');
    }

    const source = input.source ?? parsed.source;
    const scanType = input.scanType ?? parsed.scanType;
    const threshold = input.findingThreshold ?? DEFAULT_FINDING_THRESHOLD;
    const thresholdRank = SEVERITY_RANK[threshold];

    const aboveThreshold = parsed.findings.filter((f) => SEVERITY_RANK[f.severity] >= thresholdRank);

    const aboveThresholdTotal = aboveThreshold.length;
    const derivedOutcome: 'PASS' | 'FAIL' = aboveThreshold.length > 0 ? 'FAIL' : 'PASS';
    const outcome = input.outcome ?? derivedOutcome;
    const ranAt = new Date();

    // ── Phase 1: persist the run + dedup findings + automated evidence ──
    const phase1 = await runInTenantContext(ctx, async (db) => {
        const controlId = await resolveControlId(db, ctx, source, input.controlId);

        const run = await db.scannerRun.create({
            data: {
                tenantId: ctx.tenantId,
                source,
                scanType,
                ranAt,
                outcome,
                repoRef: input.repoRef ? sanitizePlainText(input.repoRef) : null,
                findingCount: parsed.findings.length,
                ingestedVia: input.ingestedVia,
            },
        });

        // Resolve the scanned target to an asset so its findings hang off the
        // asset's vuln surface. RULE: normalize the run's repoRef (strip any
        // '@<ref>' suffix) and match it case-insensitively against
        // Asset.externalRef FIRST, then Asset.name — an externalRef match is
        // strictly preferred over a name match (a name is a soft, collision-prone
        // key). Each lookup carries a stable tiebreak (oldest, then id) so a
        // collision resolves to the SAME asset every run instead of flipping on
        // DB row order. No match → leave findings UNLINKED (logged, never
        // guessed). Resolved once per run since a run targets a single repo.
        let resolvedAssetId: string | null = null;
        if (input.repoRef) {
            const target = input.repoRef.split('@')[0].trim();
            if (target) {
                const stableOrder = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
                const asset =
                    (await db.asset.findFirst({
                        where: { tenantId: ctx.tenantId, externalRef: { equals: target, mode: 'insensitive' } },
                        orderBy: stableOrder,
                        select: { id: true },
                    })) ??
                    (await db.asset.findFirst({
                        where: { tenantId: ctx.tenantId, name: { equals: target, mode: 'insensitive' } },
                        orderBy: stableOrder,
                        select: { id: true },
                    }));
                resolvedAssetId = asset?.id ?? null;
                if (!resolvedAssetId) {
                    logger.info('scanner-ingestion: scan target did not resolve to an asset — findings left unlinked', {
                        component: 'scanner-ingestion',
                        tenantId: ctx.tenantId,
                        repoRef: target,
                    });
                }
            }
        }

        // Dedup by (tenantId, fingerprint): a recurring issue stays one
        // row. On update we refresh content but PRESERVE triage status
        // (a FALSE_POSITIVE / ACCEPTED finding must not silently reopen).
        for (const f of parsed.findings) {
            await db.scannerFinding.upsert({
                where: { tenantId_fingerprint: { tenantId: ctx.tenantId, fingerprint: f.fingerprint } },
                create: {
                    tenantId: ctx.tenantId,
                    scannerRunId: run.id,
                    fingerprint: f.fingerprint,
                    ruleId: f.ruleId,
                    severity: f.severity,
                    title: sanitizePlainText(f.title),
                    description: f.description ? sanitizePlainText(f.description) : null,
                    location: f.location,
                    cweIds: f.cweIds,
                    status: 'OPEN',
                    assetId: resolvedAssetId,
                },
                update: {
                    scannerRunId: run.id,
                    severity: f.severity,
                    title: sanitizePlainText(f.title),
                    description: f.description ? sanitizePlainText(f.description) : null,
                    location: f.location,
                    cweIds: f.cweIds,
                    // Only (re)link on resolve — a later run that can't resolve
                    // must not null an existing link.
                    ...(resolvedAssetId ? { assetId: resolvedAssetId } : {}),
                },
            });
        }

        // Automated control evidence — only a PASSING run proves the
        // control is OPERATING. Upsert a single rolling Evidence row per
        // (control, source) so daily scans refresh one record instead of
        // piling up; `nextReviewDate` makes the existing stale-review
        // sweep flag it if scans stop.
        let evidenceId: string | null = null;
        if (controlId && outcome === 'PASS') {
            const category = `scanner:${source}`;
            const nextReviewDate = new Date(ranAt.getTime() + EVIDENCE_FRESHNESS_DAYS * 86_400_000);
            const summary = `${source} ${scanType} scan passed on ${ranAt.toISOString().slice(0, 10)} — ${parsed.findings.length} finding(s), 0 at/above ${threshold}.${input.repoRef ? ` (${sanitizePlainText(input.repoRef)})` : ''}`;

            const existing = await db.evidence.findFirst({
                where: { tenantId: ctx.tenantId, evidenceControlLinks: { some: { controlId } }, category, type: 'TEXT', isArchived: false, deletedAt: null },
                select: { id: true },
            });
            if (existing) {
                const ev = await db.evidence.update({
                    where: { id: existing.id },
                    data: {
                        title: `Automated evidence — ${source} ${scanType}`,
                        content: summary,
                        dateCollected: ranAt,
                        nextReviewDate,
                        status: 'APPROVED',
                    },
                });
                evidenceId = ev.id;
            } else {
                const ev = await db.evidence.create({
                    data: {
                        tenantId: ctx.tenantId,
                        type: 'TEXT',
                        title: `Automated evidence — ${source} ${scanType}`,
                        content: summary,
                        category,
                        dateCollected: ranAt,
                        reviewCycle: 'MONTHLY',
                        nextReviewDate,
                        status: 'APPROVED',
                    },
                });
                await db.evidenceControlLink.create({
                    data: {
                        tenantId: ctx.tenantId,
                        evidenceId: ev.id,
                        controlId,
                        createdByUserId: ctx.userId ?? null,
                    },
                });
                evidenceId = ev.id;
                // Bridge into the control evidence tab as an integration result.
                try {
                    await db.controlEvidenceLink.create({
                        data: {
                            tenantId: ctx.tenantId,
                            controlId,
                            kind: 'INTEGRATION_RESULT',
                            integrationResultId: run.id,
                            note: `Automated evidence from ${source} ${scanType} scan`,
                        },
                    });
                } catch {
                    /* duplicate link is acceptable */
                }
            }
        }

        await logEvent(db, ctx, {
            action: 'SCANNER_RUN_INGESTED',
            entityType: 'ScannerRun',
            entityId: run.id,
            details: `Ingested ${source} ${scanType} run (${outcome}) — ${parsed.findings.length} findings${controlId ? '' : ' [unmapped: no automated evidence]'}`,
            detailsJson: { category: 'custom', event: 'scanner_run_ingested' },
            metadata: { source, scanType, outcome, findingCount: parsed.findings.length, controlId, evidenceId },
        });

        return { runId: run.id, controlId, evidenceId };
    });

    // ── Phase 2: materialise + reconcile Findings (each createFinding
    //    manages its own tenant transaction — mirrors vulnerability.ts). ──
    let findingsTruncated = 0;
    let findingsMaterialized = 0;
    let findingsReconciledClosed = 0;

    if (input.materializeFindings) {
        // Existing scanner-sourced findings keyed by fingerprint.
        // DRAINED, not capped. `byRef` below is the ONLY dedupe mechanism in
        // this ingest: a fingerprint missing from it reads as "never seen
        // before". So a `take` here does not drop work — it makes the ingest
        // forget history, creating DUPLICATE Findings for issues already
        // tracked and skipping the auto-close reconcile for issues already
        // fixed. That is silent corruption of the compliance record, a
        // different and worse thing than the omission the other caps caused.
        const existing = await runInTenantContext(ctx, async (db) =>
            drainPages((cursor) =>
                db.finding.findMany({
                    where: { tenantId: ctx.tenantId, sourceKind: SCANNER_SOURCE_KIND, deletedAt: null },
                    select: { id: true, sourceRef: true, status: true },
                    orderBy: { id: 'asc' },
                    take: DRAIN_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
            ),
        );
        const byRef = new Map<string, { id: string; status: string }>();
        for (const f of existing) {
            if (f.sourceRef) byRef.set(f.sourceRef, { id: f.id, status: f.status });
        }
        const currentRefs = new Set(aboveThreshold.map((f) => f.fingerprint));

        // Create a Finding for each above-threshold scanner finding that
        // doesn't already have an OPEN one (idempotent). Bounded by cap.
        // The materialisation cap STAYS — each iteration is a write, and an
        // unbounded write loop is a different risk from an unbounded read. But
        // it now reports itself: see `findingsTruncated` in the return.
        if (aboveThreshold.length > MAX_FINDINGS_PER_INGEST) {
            findingsTruncated = aboveThreshold.length - MAX_FINDINGS_PER_INGEST;
            logger.warn('scanner ingest truncated above-threshold findings', {
                component: 'scanner-ingestion',
                source,
                aboveThresholdTotal: aboveThreshold.length,
                cap: MAX_FINDINGS_PER_INGEST,
                dropped: findingsTruncated,
            });
            recordScannerFindingsTruncated({ source, dropped: findingsTruncated });
        }
        for (const f of aboveThreshold.slice(0, MAX_FINDINGS_PER_INGEST)) {
            const prior = byRef.get(f.fingerprint);
            if (prior && prior.status !== 'CLOSED') continue; // already tracked
            await createFinding(ctx, {
                severity: toFindingSeverity(f.severity),
                type: 'NONCONFORMITY',
                title: `${source}: ${f.title}`.slice(0, 250),
                description: f.description ?? f.title,
                controlId: phase1.controlId ?? undefined,
                sourceKind: SCANNER_SOURCE_KIND,
                sourceRef: f.fingerprint,
            });
            findingsMaterialized++;
        }

        // Reconcile: close scanner Findings whose finding no longer
        // appears at/above threshold (fixed) — the nis2-readiness pattern.
        const staleRefs = [...byRef.entries()]
            .filter(([ref, v]) => !currentRefs.has(ref) && v.status !== 'CLOSED')
            .map(([ref]) => ref);
        if (staleRefs.length > 0) {
            findingsReconciledClosed = await runInTenantContext(ctx, async (db) => {
                const res = await db.finding.updateMany({
                    where: {
                        tenantId: ctx.tenantId,
                        sourceKind: SCANNER_SOURCE_KIND,
                        sourceRef: { in: staleRefs },
                        status: { not: 'CLOSED' },
                    },
                    data: {
                        status: 'CLOSED',
                        verificationNotes: `Auto-closed: no longer reported by ${source} scan on ${ranAt.toISOString().slice(0, 10)}`,
                        verifiedAt: ranAt,
                    },
                });
                return res.count;
            });
            // Mark the corresponding ScannerFindings FIXED too.
            await runInTenantContext(ctx, async (db) => {
                await db.scannerFinding.updateMany({
                    where: { tenantId: ctx.tenantId, fingerprint: { in: staleRefs }, status: { not: 'FALSE_POSITIVE' } },
                    data: { status: 'FIXED' },
                });
            });
        }
    }

    return {
        scannerRunId: phase1.runId,
        source,
        scanType,
        outcome,
        findingsIngested: parsed.findings.length,
        controlId: phase1.controlId,
        evidenceId: phase1.evidenceId,
        findingsMaterialized,
        findingsReconciledClosed,
        // `findingsIngested` counts EVERY parsed finding, including
        // below-threshold ones, so on its own it cannot distinguish "400 were
        // below threshold" from "400 were silently discarded". These two make
        // the difference visible: a CI pipeline can compare
        // `findingsMaterialized + findingsTruncated` against
        // `aboveThresholdTotal` and fail its own build when its findings were
        // dropped.
        aboveThresholdTotal,
        findingsTruncated,
    };
}

/** Tenant-scoped read: recent scanner runs (newest first). */
export async function listScannerRuns(ctx: RequestContext, opts?: { source?: string; take?: number }) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        return db.scannerRun.findMany({
            where: { tenantId: ctx.tenantId, ...(opts?.source ? { source: opts.source } : {}) },
            orderBy: { ranAt: 'desc' },
            take: Math.min(opts?.take ?? 100, 200),
        });
    });
}

/** Tenant-scoped read: scanner findings, filterable by status/severity.
 *  Each row is enriched with the CWE → OWASP/SSDF cross-walk so the UI can
 *  show "relates to OWASP A03 / SSDF PW.5" without a second round-trip. */
export async function listScannerFindings(
    ctx: RequestContext,
    opts?: { status?: string; severity?: string; take?: number },
) {
    assertCanRead(ctx);
    const rows = await runInTenantContext(ctx, async (db) => {
        return db.scannerFinding.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(opts?.status ? { status: opts.status } : {}),
                ...(opts?.severity ? { severity: opts.severity } : {}),
            },
            include: { scannerRun: { select: { source: true, scanType: true, ranAt: true } } },
            orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
            take: Math.min(opts?.take ?? 200, 500),
        });
    });
    return rows.map((r) => ({ ...r, frameworks: mapCwes(r.cweIds) }));
}

/** Scanner findings resolved to a given asset (ScannerFinding.assetId) — the
 *  asset detail vuln tab surfaces these alongside the CVE-matched
 *  AssetVulnerability rows, so an asset shows its full vulnerability picture. */
export async function listAssetScannerFindings(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    const rows = await runInTenantContext(ctx, async (db) => {
        return db.scannerFinding.findMany({
            where: { tenantId: ctx.tenantId, assetId },
            include: { scannerRun: { select: { source: true, scanType: true, ranAt: true, repoRef: true } } },
            orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
            take: 200,
        });
    });
    return rows.map((r) => ({ ...r, frameworks: mapCwes(r.cweIds) }));
}

/** The analyst-settable triage states for a scanner finding. Ingestion
 *  preserves these on re-scan (only OPEN/FIXED are auto-managed). */
export const SCANNER_FINDING_STATUSES = ['OPEN', 'TRIAGED', 'FIXED', 'FALSE_POSITIVE', 'ACCEPTED'] as const;
export type ScannerFindingStatus = (typeof SCANNER_FINDING_STATUSES)[number];

/**
 * Triage a scanner finding — set its analyst status (TRIAGED / FALSE_POSITIVE /
 * ACCEPTED / OPEN / FIXED). Mirrors `updateVulnerabilityStatus`: write-gated,
 * validated against the allowed set, audit-logged with the from→to transition.
 * Re-ingestion preserves whatever the analyst set here (see ingestScannerRun's
 * upsert, which keeps the existing status on update).
 */
export async function updateScannerFindingStatus(
    ctx: RequestContext,
    id: string,
    status: string,
) {
    assertCanWrite(ctx);
    if (!SCANNER_FINDING_STATUSES.includes(status as ScannerFindingStatus)) {
        throw badRequest('INVALID_STATUS', `status must be one of ${SCANNER_FINDING_STATUSES.join(', ')}`);
    }
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.scannerFinding.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { id: true, status: true, title: true },
        });
        if (!existing) throw notFound('Scanner finding not found');

        const updated = await db.scannerFinding.update({
            where: { id },
            data: { status },
        });

        await logEvent(db, ctx, {
            action: 'SCANNER_FINDING_TRIAGED',
            entityType: 'ScannerFinding',
            entityId: id,
            details: `Scanner finding status ${existing.status} → ${updated.status}`,
            detailsJson: { category: 'status_change', entityName: 'ScannerFinding', operation: 'updated', summary: 'Scanner finding triaged' },
            metadata: { from: existing.status, to: updated.status },
        });
        return updated;
    });
}
