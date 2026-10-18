/**
 * Harness scans (#3665, UC1) — the ONLY writer of DiscoveredAgent,
 * AgentHarnessScan and AgentHarnessScanItem.
 *
 * A scanner in the client's environment posts a signed `inflect-agent-harness/1`
 * report. This usecase:
 *
 *   1. reads the scanner keys the tenant trusts (unrevoked rows only);
 *   2. verifies, in the contract's order — size, JSON, signature BY ONE OF
 *      THOSE KEYS, then the strict schema — and writes NOTHING on a refusal;
 *   3. holds the signer to its identity: the key belongs to one registered
 *      agent, the report must name that agent as its scanner, and an API key
 *      bound to an agent may submit only that agent's reports;
 *   4. refuses a replay (`scan.id` is unique per tenant);
 *   5. plans what the report means (`lib/agentic/harness-findings.ts`, pure):
 *      every level derived by the ladder, every register link checked against
 *      the register rather than taken from the report, and an agent the report
 *      links to nothing linked by the registration intake's own record (#3712);
 *   6. writes the scan, the discovered agents and the items, and reconciles the
 *      harness findings, in one transaction.
 *
 * Findings are written through `FindingRepository` inside that transaction
 * rather than through `createFinding`, because the principal posting a scan is
 * a scanner whose key carries `agent_harness_ingest` and nothing else, and
 * `createFinding` asks for general write authority the scanner must not hold.
 * The title and description are built from identifiers and sanitised all the
 * same, and every write is audited.
 *
 * `tests/guards/agent-harness-single-write-seam.test.ts` refuses a write to the
 * three tables from any other file.
 */
import type { Prisma } from '@prisma/client';
import type { PrismaTx } from '@/lib/db-context';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, forbidden } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { recordHarnessScanOutcome } from '@/lib/observability/integration-metrics';
import { FindingRepository } from '../repositories/FindingRepository';
import { invalidateRelinkedConfirmations } from './agent-service-principal-confirmation';
import {
    harnessKeyFingerprint,
    harnessSignedMessage,
    verifyAndParseHarnessReport,
    type HarnessReportBody,
} from '@/lib/agentic/harness-contract';
import {
    firstSecretShapedMember,
    HARNESS_FINDING_SOURCE_KIND,
    intakeClaimsByDiscoveredId,
    planHarnessScan,
    type PlannedFinding,
} from '@/lib/agentic/harness-findings';
import type { HarnessLevel } from '@/lib/agentic/harness-ladder';

/** How many scanner keys a tenant may hold. Far above any real estate. */
const MAX_SCANNER_KEYS = 200;

export interface HarnessIngestResult {
    scanId: string;
    scanRef: string;
    complete: boolean;
    agentCount: number;
    findingsOpened: number;
    findingsReopened: number;
    findingsResolved: number;
}

function assertMayIngest(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_harness_ingest) {
        throw forbidden('Submitting a harness scan requires admin.agent_harness_ingest');
    }
}

/**
 * Reading scans is reading the agent inventory (#3710): the view key, or the
 * register key whose holders always could (`mayReadAgentInventory`).
 */
function assertMayRead(ctx: RequestContext): void {
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        throw forbidden('Reading harness scans requires admin.agent_registry_view');
    }
}

/** Verify, plan and record one signed harness report. */
export async function ingestHarnessReport(ctx: RequestContext, raw: string): Promise<HarnessIngestResult> {
    assertMayIngest(ctx);

    try {
        const result = await runInTenantContext(ctx, async (db) => {
            const keys = await db.agentHarnessScannerKey.findMany({
                where: { tenantId: ctx.tenantId, revokedAt: null },
                select: { id: true, agentId: true, publicKey: true, keyFingerprint: true },
                take: MAX_SCANNER_KEYS,
            });

            // Verification first, and nothing below reads the body before it
            // has passed: a key the tenant trusts has vouched for it, and the
            // strict schema has accepted it.
            const verdict = verifyAndParseHarnessReport(raw, keys.map((k) => k.publicKey));
            if (!verdict.ok) {
                const issues = verdict.issues ? `: ${verdict.issues.slice(0, 20).join('; ')}` : '';
                throw badRequest(`harness_report_refused: ${verdict.reason}${issues}`);
            }
            const body = verdict.body;
            // The contract checks credential references; the ingest checks
            // every other string (DPIA condition 10). Named by path only.
            const secretAt = firstSecretShapedMember(body);
            if (secretAt) throw badRequest(`harness_report_refused: SECRET_IN_REPORT: ${secretAt}`);
            const fingerprint = harnessKeyFingerprint(verdict.signerKey);
            const key = keys.find((k) => k.keyFingerprint === fingerprint);
            if (!key) throw badRequest('harness_report_refused: UNTRUSTED_SIGNER');

            // The key speaks for one scanner and no other.
            if (body.scan.scanner.agentId !== key.agentId) {
                throw badRequest(
                    'harness_report_refused: SCANNER_MISMATCH: the report names a scanner other than the '
                    + 'registered agent this signing key belongs to',
                );
            }
            // And a credential bound to an agent submits only that agent's reports.
            if (ctx.agentId && ctx.agentId !== key.agentId) {
                throw forbidden(
                    'harness_report_refused: SUBMITTER_MISMATCH: this credential is bound to a different '
                    + 'agent from the scanner that signed the report',
                );
            }

            const replay = await db.agentHarnessScan.findFirst({
                where: { tenantId: ctx.tenantId, scanRef: body.scan.id },
                select: { id: true },
            });
            if (replay) throw conflict(`harness_report_refused: REPLAY: scan ${body.scan.id} is already ingested`);

            return record(db, ctx, body, key.id, verdict.complete, raw);
        });
        recordHarnessScanOutcome({ outcome: 'ingested', complete: result.complete, empty: result.agentCount === 0 });
        return result;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const refusal = { reason: /harness_report_refused: ([A-Z_]+)/.exec(message)?.[1] ?? 'ERROR' };
        recordHarnessScanOutcome({ outcome: 'refused', reason: refusal.reason });
        // The reason code only: the report is untrusted until it has passed,
        // and a refused report's content does not belong in a log line.
        logger.warn('harness scan refused', { component: 'agent-harness', reason: refusal.reason });
        throw err;
    }
}

async function record(
    db: PrismaTx,
    ctx: RequestContext,
    body: HarnessReportBody,
    scannerKeyId: string,
    complete: boolean,
    raw: string,
): Promise<HarnessIngestResult> {
    const now = new Date();
    const ids = body.agents.map((a) => a.discoveredId);

    // What the tenant already knows, read once each.
    const known = await db.discoveredAgent.findMany({
        where: { tenantId: ctx.tenantId, discoveredId: { in: ids } },
        select: { id: true, discoveredId: true, lastLevel: true, registeredAgentId: true },
        take: ids.length,
    });
    const claimed = [...new Set(body.agents.map((a) => a.registeredAgentId).filter((v): v is string => v !== null))];
    const registered = claimed.length === 0
        ? []
        : await db.registeredAgent.findMany({
            where: { tenantId: ctx.tenantId, id: { in: claimed }, deletedAt: null },
            select: { id: true },
            take: claimed.length,
        });
    const accepted = known.length === 0
        ? []
        : await db.agentHarnessAcceptance.findMany({
            where: {
                tenantId: ctx.tenantId,
                discoveredAgentId: { in: known.map((k) => k.id) },
                revokedAt: null,
                expiresAt: { gt: now },
            },
            select: { discoveredAgentId: true },
            take: known.length * 4,
        });
    // The register's own record of which discovered agent each intake row was
    // registered from (#3712). The planner decides what it may link.
    const intake = known.length === 0
        ? []
        : await db.registeredAgent.findMany({
            where: { tenantId: ctx.tenantId, intakeDiscoveredAgentId: { in: known.map((k) => k.id) } },
            select: { id: true, status: true, deletedAt: true, intakeDiscoveredAgentId: true },
            take: known.length,
        });
    const knownById = new Map(known.map((k) => [k.id, k]));

    const plan = planHarnessScan(body, {
        previousLevels: new Map(known.map((k) => [k.discoveredId, k.lastLevel as HarnessLevel])),
        registeredAgentIds: new Set(registered.map((r) => r.id)),
        acceptedShortfalls: new Set(
            accepted.map((a) => knownById.get(a.discoveredAgentId)?.discoveredId).filter((v): v is string => !!v),
        ),
        intakeClaims: intakeClaimsByDiscoveredId(known, intake),
    });

    // The signed body, without its signature, is what the signature covers.
    const parsed = JSON.parse(raw) as { signature: { sig: string } };
    const reportDigest = harnessSignedMessage(body).toString('hex');

    const scan = await db.agentHarnessScan.create({
        data: {
            tenantId: ctx.tenantId,
            scanRef: body.scan.id,
            scannerAgentId: body.scan.scanner.agentId,
            scannerKeyId,
            scannerVersion: body.scan.scanner.version,
            scannerManifestHash: body.scan.scanner.manifestHash,
            asOf: new Date(body.scan.asOf),
            reportDigest,
            signature: parsed.signature.sig,
            complete,
            sourcesJson: body.population.sources as unknown as Prisma.InputJsonValue,
            agentCount: body.agents.length,
        },
        select: { id: true, scanRef: true, complete: true, reportDigest: true, agentCount: true },
    });

    // Discovered agents: new ones in one insert, known ones updated in place.
    const knownByDiscoveredId = new Map(known.map((k) => [k.discoveredId, k]));
    const fresh = plan.agents.filter((a) => !knownByDiscoveredId.has(a.discoveredId));
    if (fresh.length > 0) {
        await db.discoveredAgent.createMany({
            data: fresh.map((a) => ({
                tenantId: ctx.tenantId,
                discoveredId: a.discoveredId,
                discoveredVia: [...a.discoveredVia],
                registeredAgentId: a.registeredAgentId,
                ownerKind: a.ownerKind,
                ownerRef: a.ownerRef,
                firstSeenAt: now,
                lastSeenAt: now,
                lastScanId: scan.id,
                lastLevel: a.level,
                lastReach: a.reach,
            })),
        });
    }
    for (const a of plan.agents) {
        const k = knownByDiscoveredId.get(a.discoveredId);
        if (!k) continue;
        await db.discoveredAgent.update({
            where: { id: k.id },
            data: {
                discoveredVia: [...a.discoveredVia],
                registeredAgentId: a.registeredAgentId,
                ownerKind: a.ownerKind,
                ownerRef: a.ownerRef,
                lastSeenAt: now,
                lastScanId: scan.id,
                lastLevel: a.level,
                lastReach: a.reach,
            },
        });
    }
    const rows = ids.length === 0
        ? []
        : await db.discoveredAgent.findMany({
            where: { tenantId: ctx.tenantId, discoveredId: { in: ids } },
            select: { id: true, discoveredId: true },
            take: ids.length,
        });
    const rowId = new Map(rows.map((r) => [r.discoveredId, r.id]));

    // A CONFIRMED SERVICE-PRINCIPAL LINK THIS SCAN MOVED STOPS COUNTING (#3671).
    // A person confirmed "this principal is that agent's"; a scan that now says
    // otherwise — of the principal, or of the agent — invalidates it, in this
    // transaction, and a person confirms the new link afresh. Never re-pointed.
    await invalidateRelinkedConfirmations(
        db,
        ctx,
        scan,
        plan.agents.flatMap((a) => {
            const id = rowId.get(a.discoveredId);
            if (!id) return [];
            return [
                {
                    discoveredAgentId: id,
                    discoveredId: a.discoveredId,
                    previousAgentId: knownByDiscoveredId.get(a.discoveredId)?.registeredAgentId ?? null,
                    nextAgentId: a.registeredAgentId,
                },
            ];
        }),
        now,
    );

    if (plan.agents.length > 0) {
        await db.agentHarnessScanItem.createMany({
            data: plan.agents.map((a) => ({
                tenantId: ctx.tenantId,
                scanId: scan.id,
                discoveredAgentId: rowId.get(a.discoveredId) as string,
                level: a.level,
                reach: a.reach,
                verdictsJson: a.verdicts as unknown as Prisma.InputJsonValue,
                blockingNextRung: [...a.blockingNextRung],
                toolsJson: a.tools as unknown as Prisma.InputJsonValue,
            })),
        });
    }

    const counts = await reconcileFindings(db, ctx, scan, plan.assert, plan.resolve, now);

    // A report linked an agent to a live register row other than the intake's:
    // the report's link stands, and the intake row's own history says so.
    for (const c of plan.intakeConflicts) {
        await logEvent(db, ctx, {
            action: 'AGENT_INTAKE_LINK_CONFLICT',
            entityType: 'RegisteredAgent',
            entityId: c.intakeRegisteredAgentId,
            details: `Harness scan ${scan.scanRef} linked ${c.discoveredId} to another register row`,
            detailsJson: {
                category: 'custom',
                entityName: 'RegisteredAgent',
                operation: 'intake_link_conflict',
                after: {
                    discoveredId: c.discoveredId,
                    reportedRegisteredAgentId: c.reportedRegisteredAgentId,
                    intakeRegisteredAgentId: c.intakeRegisteredAgentId,
                    scanRef: scan.scanRef,
                },
            },
        });
    }

    await logEvent(db, ctx, {
        action: 'AGENT_HARNESS_SCAN_INGESTED',
        entityType: 'AgentHarnessScan',
        entityId: scan.id,
        details: `Ingested harness scan ${scan.scanRef} (${scan.agentCount} agents)`,
        detailsJson: {
            category: 'custom',
            entityName: 'AgentHarnessScan',
            operation: 'ingested',
            after: {
                scanRef: scan.scanRef,
                scannerAgentId: body.scan.scanner.agentId,
                complete: scan.complete,
                agentCount: scan.agentCount,
                reportDigest: scan.reportDigest,
                findingsOpened: counts.findingsOpened,
                findingsReopened: counts.findingsReopened,
                findingsResolved: counts.findingsResolved,
            },
        },
    });

    return { scanId: scan.id, scanRef: scan.scanRef, complete: scan.complete, agentCount: scan.agentCount, ...counts };
}

async function reconcileFindings(
    db: PrismaTx,
    ctx: RequestContext,
    scan: { scanRef: string },
    assert: readonly PlannedFinding[],
    resolve: readonly string[],
    now: Date,
): Promise<{ findingsOpened: number; findingsReopened: number; findingsResolved: number }> {
    const refs = [...new Set([...assert.map((f) => f.sourceRef), ...resolve])];
    const existing = refs.length === 0
        ? []
        : await db.finding.findMany({
            where: { tenantId: ctx.tenantId, sourceKind: HARNESS_FINDING_SOURCE_KIND, sourceRef: { in: refs }, deletedAt: null },
            select: { id: true, sourceRef: true, status: true },
            take: refs.length,
        });
    const byRef = new Map(existing.map((f) => [f.sourceRef as string, f]));

    let findingsOpened = 0;
    let findingsReopened = 0;
    let findingsResolved = 0;

    for (const f of assert) {
        const prior = byRef.get(f.sourceRef);
        if (!prior) {
            const created = await FindingRepository.create(db, ctx, {
                severity: f.severity,
                type: f.type,
                title: sanitizePlainText(f.title),
                description: sanitizePlainText(f.description),
                status: 'OPEN',
                sourceKind: HARNESS_FINDING_SOURCE_KIND,
                sourceRef: f.sourceRef,
            });
            findingsOpened += 1;
            await logEvent(db, ctx, {
                action: 'CREATE',
                entityType: 'Finding',
                entityId: created.id,
                details: `Harness scan ${scan.scanRef} raised ${f.code}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Finding',
                    operation: 'created',
                    after: { code: f.code, sourceRef: f.sourceRef, severity: f.severity, scanRef: scan.scanRef },
                },
            });
        } else if (prior.status === 'CLOSED') {
            await db.finding.update({
                where: { id: prior.id },
                data: { status: 'OPEN', verificationNotes: sanitizePlainText(`Reopened by harness scan ${scan.scanRef}`) },
            });
            findingsReopened += 1;
            await logEvent(db, ctx, {
                action: 'STATUS_CHANGE',
                entityType: 'Finding',
                entityId: prior.id,
                details: `Harness scan ${scan.scanRef} reopened ${f.code}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Finding',
                    before: { status: 'CLOSED' },
                    after: { status: 'OPEN', sourceRef: f.sourceRef, scanRef: scan.scanRef },
                },
            });
        }
    }

    for (const ref of resolve) {
        const prior = byRef.get(ref);
        if (!prior || prior.status === 'CLOSED') continue;
        await db.finding.update({
            where: { id: prior.id },
            data: {
                status: 'CLOSED',
                verifiedAt: now,
                verificationNotes: sanitizePlainText(`Resolved by harness scan ${scan.scanRef}`),
            },
        });
        findingsResolved += 1;
        await logEvent(db, ctx, {
            action: 'STATUS_CHANGE',
            entityType: 'Finding',
            entityId: prior.id,
            details: `Harness scan ${scan.scanRef} resolved ${prior.sourceRef}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Finding',
                before: { status: prior.status },
                after: { status: 'CLOSED', sourceRef: prior.sourceRef, scanRef: scan.scanRef },
            },
        });
    }

    return { findingsOpened, findingsReopened, findingsResolved };
}

/**
 * The most recent scans, newest first BY THE MOMENT THEY DESCRIBE (`asOf`), not
 * by when they arrived: a backfilled older report must not pose as the current
 * one. Ties break on arrival and then id, so "the latest scan" is one row
 * however often the page is read.
 */
export async function listHarnessScans(ctx: RequestContext, opts: { take?: number } = {}) {
    assertMayRead(ctx);
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    return runInTenantContext(ctx, (db) =>
        db.agentHarnessScan.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
                id: true,
                scanRef: true,
                scannerAgentId: true,
                scannerVersion: true,
                asOf: true,
                complete: true,
                agentCount: true,
                sourcesJson: true,
                createdAt: true,
            },
        }),
    );
}
