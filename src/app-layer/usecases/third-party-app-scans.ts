/**
 * Third-party application scans — the ONLY writer of ThirdPartyAppScan,
 * DiscoveredThirdPartyApp and ThirdPartyAppScanItem.
 *
 * A scanner in the client's environment posts its second signed report,
 * `scanent-integrations/1`: the applications a directory (Entra, Okta, GitHub)
 * has granted access to. The shape is the harness ingest's
 * (`agent-harness-scans.ts`), step for step:
 *
 *   1. reads the scanner keys the tenant trusts (unrevoked rows only) — the
 *      SAME keys that sign harness reports, registered under
 *      `admin.agent_registry`;
 *   2. verifies with the contract package's `verifyAndParseIntegrationsReport`
 *      — size, JSON, a signature BY ONE OF THOSE KEYS, the strict `/1` schema —
 *      and writes NOTHING on a refusal. A harness report given here is a SCHEMA
 *      refusal, as this report is to the harness verifier;
 *   3. holds the signer to its identity: the key belongs to one registered
 *      agent, the report must name that agent as its scanner, and an API key
 *      bound to an agent may submit only that agent's reports;
 *   4. refuses a replay (`scan.id` is unique per tenant);
 *   5. plans what the report means with the contract's planner
 *      (`planIntegrationsScan`) — never a copy of it — over the owner's default
 *      window for "unused" (`DEFAULT_UNUSED_DAYS`);
 *   6. writes the scan, the applications and the items, and reconciles the
 *      findings, in one transaction.
 *
 * ── WHAT A SCAN CLOSES ──────────────────────────────────────────────────────
 *
 * A finding is created when the plan raises it and none is open, and REOPENED
 * when the plan raises one that was closed. It is RESOLVED only on positive
 * evidence, which this ingest reads as all of:
 *
 *   • the application is IN this scan — an application absent from a report is
 *     not concluded gone, unused or clean (the planner's rule, and the harness
 *     ingest's: an agent absent from a scan resolves nothing), so it closes
 *     nothing even when its source was read in full;
 *   • its source was read COMPLETE in this scan;
 *   • the plan neither raised the finding nor recorded it as NOT CONCLUDED for
 *     that application or for its whole source (a grant list read in part, a
 *     publisher not known, owners not read, sign-in not read, a member the
 *     product does not expose).
 *
 * An empty-inventory finding is about a SOURCE, and its subject (the source
 * kind) is the same for every directory of that kind. Its reference is the
 * planner's with the scanner's agent id appended (`…:<kind>@<scannerAgentId>`),
 * so one scanner's complete read of its directory cannot close another
 * scanner's finding about a different one. It closes when the same scanner
 * reads that source COMPLETE and finds an application in it.
 *
 * Findings are written through `FindingRepository` inside the transaction
 * rather than through `createFinding`, for the harness ingest's reason: the
 * principal posting a scan is a scanner whose key carries
 * `integrations_ingest` and nothing else, and `createFinding` asks for general
 * write authority the scanner must not hold. Titles and descriptions are the
 * planner's, built from identifiers and the directory's display names, and are
 * sanitised all the same; every write is audited.
 *
 * `tests/guards/agent-harness-single-write-seam.test.ts` refuses a write to the
 * three tables from any other file.
 */
import { Prisma } from '@prisma/client';
import {
    applicationName,
    INTEGRATIONS_PRODUCT_TITLE,
    IntegrationsReportBodyV1Schema,
    verifyAndParseIntegrationsReport,
    type IntegrationsReportApplication,
    type IntegrationsReportBody,
} from '@rodnapamet/scanent-contract/integrations-contract';
import {
    DEFAULT_UNUSED_DAYS,
    INTEGRATION_FINDING_CODES,
    integrationFindingRef,
    NOT_EXPOSED_BY_PRODUCT,
    planIntegrationsScan,
    type IntegrationFindingCode,
    type IntegrationsPlan,
    type PlannedPermission,
} from '@rodnapamet/scanent-contract/integrations-findings';

import type { RequestContext } from '../types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, forbidden, internal } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { recordThirdPartyAppScanOutcome } from '@/lib/observability/integration-metrics';
import { FindingRepository } from '../repositories/FindingRepository';
import { harnessKeyFingerprint, harnessSignedMessage } from '@/lib/agentic/harness-contract';
import { firstSecretShapedMember } from '@/lib/agentic/harness-findings';
import {
    thirdPartyScanCompleteness,
    type ThirdPartyAppInventoryView,
    type ThirdPartyAppRow,
    type ThirdPartyAppSourceView,
    type ThirdPartyKnownState,
    type ThirdPartyOpenFinding,
    type ThirdPartyScanSection,
    type ThirdPartyScanView,
} from '@/lib/agentic/third-party-app-read-model';

/** `Finding.sourceKind` of every finding this ingest writes. */
export const THIRD_PARTY_APP_FINDING_SOURCE_KIND = 'THIRD_PARTY_APP';

/** The refusal prefix every refusal carries, for the metric and the caller. */
export const THIRD_PARTY_APP_REFUSAL = 'third_party_app_report_refused';

/** How many scanner keys a tenant may hold. The harness ingest's bound. */
const MAX_SCANNER_KEYS = 200;

/** Scans the inventory reads, newest `asOf` first: the harness matrix's window. */
export const THIRD_PARTY_SCAN_WINDOW = 50;
/** Scanner sections shown, each its latest scan. */
export const MAX_THIRD_PARTY_SECTIONS = 3;
/** Applications shown per section, worst first. */
export const THIRD_PARTY_ROW_CAP = 500;
/** Items read for the shown sections: every application of each latest scan. */
const ITEM_CAP = MAX_THIRD_PARTY_SECTIONS * 5000;
/** Open findings read for the rows. */
const OPEN_FINDING_CAP = 20_000;
/** Key holders read to name a scanner with no scan. */
const KEY_HOLDER_CAP = 200;
/** High-privilege permission names a row carries to the tab. */
export const HIGH_PERMISSIONS_SHOWN = 10;

export interface ThirdPartyAppIngestResult {
    scanId: string;
    scanRef: string;
    complete: boolean;
    applicationCount: number;
    findingsOpened: number;
    findingsReopened: number;
    findingsResolved: number;
}

function assertMayIngest(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.integrations_ingest) {
        throw forbidden('Submitting a third-party application scan requires admin.integrations_ingest');
    }
}

/** Reading the scans is reading the agent inventory, as the harness tab's is (#3710). */
function assertMayRead(ctx: RequestContext): void {
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        throw forbidden('Reading third-party application scans requires admin.agent_registry_view');
    }
}

const refused = (code: string, detail?: string) =>
    badRequest(`${THIRD_PARTY_APP_REFUSAL}: ${code}${detail ? `: ${detail}` : ''}`);

/** Verify, plan and record one signed `scanent-integrations/1` report. */
export async function ingestThirdPartyAppReport(ctx: RequestContext, raw: string): Promise<ThirdPartyAppIngestResult> {
    assertMayIngest(ctx);

    try {
        const result = await runInTenantContext(ctx, async (db) => {
            const keys = await db.agentHarnessScannerKey.findMany({
                where: { tenantId: ctx.tenantId, revokedAt: null },
                select: { id: true, agentId: true, publicKey: true, keyFingerprint: true },
                take: MAX_SCANNER_KEYS,
            });

            // Verification first; nothing below reads the body before it has
            // passed a key the tenant trusts and the strict schema.
            const verdict = verifyAndParseIntegrationsReport(raw, keys.map((k) => k.publicKey));
            if (!verdict.ok) {
                throw refused(verdict.reason, verdict.issues ? verdict.issues.slice(0, 20).join('; ') : undefined);
            }
            const body = verdict.body;
            // The schema refuses a secret where a name, a scope or a reference
            // goes; the ingest walks every other string too, as the harness
            // ingest does (DPIA condition 10). Named by path only.
            const secretAt = firstSecretShapedMember(body);
            if (secretAt) throw refused('SECRET_IN_REPORT', secretAt);
            const fingerprint = harnessKeyFingerprint(verdict.signerKey);
            const key = keys.find((k) => k.keyFingerprint === fingerprint);
            if (!key) throw refused('UNTRUSTED_SIGNER');

            if (body.scan.scanner.agentId !== key.agentId) {
                throw refused(
                    'SCANNER_MISMATCH',
                    'the report names a scanner other than the registered agent this signing key belongs to',
                );
            }
            if (ctx.agentId && ctx.agentId !== key.agentId) {
                throw forbidden(
                    `${THIRD_PARTY_APP_REFUSAL}: SUBMITTER_MISMATCH: this credential is bound to a different `
                    + 'agent from the scanner that signed the report',
                );
            }

            const replay = await db.thirdPartyAppScan.findFirst({
                where: { tenantId: ctx.tenantId, scanRef: body.scan.id },
                select: { id: true },
            });
            if (replay) throw conflict(`${THIRD_PARTY_APP_REFUSAL}: REPLAY: scan ${body.scan.id} is already ingested`);

            return record(db, ctx, body, key.id, verdict.complete, raw);
        });
        recordThirdPartyAppScanOutcome({
            outcome: 'ingested',
            complete: result.complete,
            empty: result.applicationCount === 0,
        });
        return result;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = new RegExp(`${THIRD_PARTY_APP_REFUSAL}: ([A-Z_]+)`).exec(message)?.[1] ?? 'ERROR';
        recordThirdPartyAppScanOutcome({ outcome: 'refused', reason });
        // The reason code only: a refused report's content is untrusted.
        logger.warn('third-party application scan refused', { component: 'third-party-app-scans', reason });
        throw err;
    }
}

/** A permission as stored: names and classes only, never a role id. */
function storedPermission(p: PlannedPermission) {
    return { via: p.via, resourceAppId: p.resourceAppId, name: p.name, classes: p.classes };
}

/** Whether the planner could not conclude `code` for `app`, per application or for its whole source. */
function notConcludedFor(plan: IntegrationsPlan) {
    const keys = new Set(
        plan.notConcluded.map((n) => (n.applicationId === null ? `${n.code}|source|${n.sourceKind}` : `${n.code}|app|${n.applicationId}`)),
    );
    return (code: IntegrationFindingCode, app: IntegrationsReportApplication) =>
        keys.has(`${code}|app|${app.id}`) || keys.has(`${code}|source|${app.sourceKind}`);
}

/** A finding about a source is the scanner's: its planner reference, scoped to the scanner. */
export function sourceFindingRef(plannerRef: string, scannerAgentId: string): string {
    return `${plannerRef}@${scannerAgentId}`;
}

/** NONCONFORMITY for what a grant exposes; OBSERVATION for disuse and an empty read. */
function findingTypeOf(code: IntegrationFindingCode): 'NONCONFORMITY' | 'OBSERVATION' {
    return code === 'INTEGRATION_UNUSED' || code === 'INTEGRATION_EMPTY_INVENTORY' ? 'OBSERVATION' : 'NONCONFORMITY';
}

interface PlannedWrite {
    readonly code: IntegrationFindingCode;
    readonly sourceRef: string;
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    readonly title: string;
    readonly description: string;
}

async function record(
    db: PrismaTx,
    ctx: RequestContext,
    body: IntegrationsReportBody,
    scannerKeyId: string,
    complete: boolean,
    raw: string,
): Promise<ThirdPartyAppIngestResult> {
    const now = new Date();
    const scannerAgentId = body.scan.scanner.agentId;
    const plan = planIntegrationsScan(body, { unusedDays: DEFAULT_UNUSED_DAYS });
    const plannedById = new Map(plan.applications.map((a) => [a.id, a]));

    const parsed = JSON.parse(raw) as { signature: { sig: string } };
    const reportDigest = harnessSignedMessage(body).toString('hex');

    const scan = await db.thirdPartyAppScan.create({
        data: {
            tenantId: ctx.tenantId,
            scanRef: body.scan.id,
            scannerAgentId,
            scannerKeyId,
            scannerVersion: body.scan.scanner.version,
            scannerManifestHash: body.scan.scanner.manifestHash,
            asOf: new Date(body.scan.asOf),
            reportDigest,
            signature: parsed.signature.sig,
            complete,
            sourcesJson: body.sources as unknown as Prisma.InputJsonValue,
            applicationCount: body.applications.length,
            unusedDays: plan.unusedDays,
        },
        select: { id: true, scanRef: true, complete: true, reportDigest: true, applicationCount: true },
    });

    // Applications: new ones in one insert; known ones stamped seen in one
    // update, and renamed one by one only where the directory renamed them.
    const ids = body.applications.map((a) => a.id);
    const known = ids.length === 0
        ? []
        : await db.discoveredThirdPartyApp.findMany({
            where: { tenantId: ctx.tenantId, applicationId: { in: ids } },
            select: { id: true, applicationId: true, displayName: true, sourceKind: true },
            take: ids.length,
        });
    const knownByApplicationId = new Map(known.map((k) => [k.applicationId, k]));
    const fresh = body.applications.filter((a) => !knownByApplicationId.has(a.id));
    if (fresh.length > 0) {
        await db.discoveredThirdPartyApp.createMany({
            data: fresh.map((a) => ({
                tenantId: ctx.tenantId,
                applicationId: a.id,
                sourceKind: a.sourceKind,
                displayName: applicationName(a),
                firstSeenScanId: scan.id,
                lastSeenScanId: scan.id,
                firstSeenAt: now,
                lastSeenAt: now,
            })),
        });
    }
    if (known.length > 0) {
        await db.discoveredThirdPartyApp.updateMany({
            where: { tenantId: ctx.tenantId, id: { in: known.map((k) => k.id) } },
            data: { lastSeenScanId: scan.id, lastSeenAt: now },
        });
    }
    for (const a of body.applications) {
        const k = knownByApplicationId.get(a.id);
        const name = applicationName(a);
        if (!k || (k.displayName === name && k.sourceKind === a.sourceKind)) continue;
        await db.discoveredThirdPartyApp.update({
            where: { id: k.id },
            data: { displayName: name, sourceKind: a.sourceKind },
        });
    }
    const rows = ids.length === 0
        ? []
        : await db.discoveredThirdPartyApp.findMany({
            where: { tenantId: ctx.tenantId, applicationId: { in: ids } },
            select: { id: true, applicationId: true },
            take: ids.length,
        });
    const rowId = new Map(rows.map((r) => [r.applicationId, r.id]));

    if (body.applications.length > 0) {
        await db.thirdPartyAppScanItem.createMany({
            data: body.applications.map((a) => {
                const p = plannedById.get(a.id);
                if (!p) throw internal(`the planner did not plan ${a.id}`);
                return {
                    tenantId: ctx.tenantId,
                    scanId: scan.id,
                    appId: rowId.get(a.id) as string,
                    privilege: p.privilege,
                    usage: p.usage,
                    daysSinceSignIn: p.daysSinceSignIn,
                    classes: [...p.classes],
                    grantsJson: {
                        high: p.highPermissions.map(storedPermission),
                        unknown: p.unknownPermissions.map(storedPermission),
                    } as unknown as Prisma.InputJsonValue,
                    // Entra's alone; the other products' APIs have neither member.
                    publisherVerified: a.sourceKind === 'entra-integrations' ? a.publisherVerified : null,
                    ownerCount: a.sourceKind === 'entra-integrations' && a.owners !== null ? a.owners.length : null,
                    anyGrant: p.anyGrant,
                };
            }),
        });
    }

    // ── What this scan asserts, and what it may close ──
    const assert: PlannedWrite[] = plan.findings.map((f) => ({
        code: f.code,
        sourceRef: f.applicationId === null ? sourceFindingRef(f.sourceRef, scannerAgentId) : f.sourceRef,
        severity: f.severity,
        title: f.title,
        description: f.description,
    }));
    const asserted = new Set(assert.map((f) => f.sourceRef));
    const completeSources = new Set(body.sources.filter((s) => s.status === 'COMPLETE').map((s) => s.kind));
    const notConcluded = notConcludedFor(plan);
    const resolve: string[] = [];
    for (const app of body.applications) {
        if (!completeSources.has(app.sourceKind)) continue;
        for (const code of INTEGRATION_FINDING_CODES) {
            if (code === 'INTEGRATION_EMPTY_INVENTORY') continue;
            const ref = integrationFindingRef(code, app.id);
            if (asserted.has(ref) || notConcluded(code, app)) continue;
            resolve.push(ref);
        }
    }
    for (const kind of completeSources) {
        if (!body.applications.some((a) => a.sourceKind === kind)) continue;
        const ref = sourceFindingRef(integrationFindingRef('INTEGRATION_EMPTY_INVENTORY', kind), scannerAgentId);
        if (!asserted.has(ref)) resolve.push(ref);
    }

    const counts = await reconcileFindings(db, ctx, scan, assert, resolve, now);

    await logEvent(db, ctx, {
        action: 'THIRD_PARTY_APP_SCAN_INGESTED',
        entityType: 'ThirdPartyAppScan',
        entityId: scan.id,
        details: `Ingested third-party application scan ${scan.scanRef} (${scan.applicationCount} applications)`,
        detailsJson: {
            category: 'custom',
            entityName: 'ThirdPartyAppScan',
            operation: 'ingested',
            after: {
                scanRef: scan.scanRef,
                scannerAgentId,
                complete: scan.complete,
                applicationCount: scan.applicationCount,
                sourceCount: body.sources.length,
                highPrivilegeCount: plan.applications.filter((a) => a.privilege === 'HIGH').length,
                notConcludedCount: plan.notConcluded.length,
                unknownPermissionNameCount: plan.unknownPermissionNames.length,
                unusedDays: plan.unusedDays,
                reportDigest: scan.reportDigest,
                findingsOpened: counts.findingsOpened,
                findingsReopened: counts.findingsReopened,
                findingsResolved: counts.findingsResolved,
            },
        },
    });

    return {
        scanId: scan.id,
        scanRef: scan.scanRef,
        complete: scan.complete,
        applicationCount: scan.applicationCount,
        ...counts,
    };
}

async function reconcileFindings(
    db: PrismaTx,
    ctx: RequestContext,
    scan: { scanRef: string },
    assert: readonly PlannedWrite[],
    resolve: readonly string[],
    now: Date,
): Promise<{ findingsOpened: number; findingsReopened: number; findingsResolved: number }> {
    const refs = [...new Set([...assert.map((f) => f.sourceRef), ...resolve])];
    const existing = refs.length === 0
        ? []
        : await db.finding.findMany({
            where: {
                tenantId: ctx.tenantId,
                sourceKind: THIRD_PARTY_APP_FINDING_SOURCE_KIND,
                sourceRef: { in: refs },
                deletedAt: null,
            },
            select: { id: true, sourceRef: true, status: true },
            orderBy: { createdAt: 'asc' },
            take: refs.length,
        });
    const byRef = new Map<string, (typeof existing)[number]>();
    for (const f of existing) if (f.sourceRef && !byRef.has(f.sourceRef)) byRef.set(f.sourceRef, f);

    let findingsOpened = 0;
    let findingsReopened = 0;
    let findingsResolved = 0;

    for (const f of assert) {
        const prior = byRef.get(f.sourceRef);
        if (!prior) {
            const created = await FindingRepository.create(db, ctx, {
                severity: f.severity,
                type: findingTypeOf(f.code),
                title: sanitizePlainText(f.title),
                description: sanitizePlainText(f.description),
                status: 'OPEN',
                sourceKind: THIRD_PARTY_APP_FINDING_SOURCE_KIND,
                sourceRef: f.sourceRef,
            });
            findingsOpened += 1;
            await logEvent(db, ctx, {
                action: 'CREATE',
                entityType: 'Finding',
                entityId: created.id,
                details: `Third-party application scan ${scan.scanRef} raised ${f.code}`,
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
                data: {
                    status: 'OPEN',
                    verificationNotes: sanitizePlainText(`Reopened by third-party application scan ${scan.scanRef}`),
                },
            });
            findingsReopened += 1;
            await logEvent(db, ctx, {
                action: 'STATUS_CHANGE',
                entityType: 'Finding',
                entityId: prior.id,
                details: `Third-party application scan ${scan.scanRef} reopened ${f.code}`,
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
                verificationNotes: sanitizePlainText(`Resolved by third-party application scan ${scan.scanRef}`),
            },
        });
        findingsResolved += 1;
        await logEvent(db, ctx, {
            action: 'STATUS_CHANGE',
            entityType: 'Finding',
            entityId: prior.id,
            details: `Third-party application scan ${scan.scanRef} resolved ${ref}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Finding',
                before: { status: prior.status },
                after: { status: 'CLOSED', sourceRef: ref, scanRef: scan.scanRef },
            },
        });
    }

    return { findingsOpened, findingsReopened, findingsResolved };
}

const SCAN_ORDER = [{ asOf: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * The most recent scans, newest first BY THE MOMENT THEY DESCRIBE (`asOf`), then
 * arrival, then id — the harness list's order, so "the latest scan" is one row
 * however often the page is read and a backfilled report never poses as current.
 */
export async function listThirdPartyAppScans(ctx: RequestContext, opts: { take?: number } = {}) {
    assertMayRead(ctx);
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    return runInTenantContext(ctx, (db) =>
        db.thirdPartyAppScan.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: SCAN_ORDER,
            take,
            select: {
                id: true,
                scanRef: true,
                scannerAgentId: true,
                scannerVersion: true,
                asOf: true,
                complete: true,
                applicationCount: true,
                unusedDays: true,
                sourcesJson: true,
                createdAt: true,
            },
        }),
    );
}

// ─── The inventory read ─────────────────────────────────────────────────────

const SourcesSchema = IntegrationsReportBodyV1Schema.shape.sources;

const PRIVILEGE_ORDER: Record<string, number> = { HIGH: 0, NOT_CONCLUDED: 1, NOT_HIGH: 2 };

function productOf(kind: string): string {
    return (INTEGRATIONS_PRODUCT_TITLE as Record<string, string>)[kind] ?? kind;
}

/** Whether `kind`'s product API has no such member at all (`NOT_EXPOSED_BY_PRODUCT`). */
function notExposed(kind: string, code: IntegrationFindingCode): boolean {
    const list = (NOT_EXPOSED_BY_PRODUCT as Record<string, readonly { code: IntegrationFindingCode }[]>)[kind] ?? [];
    return list.some((n) => n.code === code);
}

function knownState(kind: string, code: IntegrationFindingCode, read: boolean): ThirdPartyKnownState {
    if (notExposed(kind, code)) return 'NOT_EXPOSED';
    return read ? 'READ' : 'NOT_KNOWN';
}

/** `CODE:subject[@scanner]` → the code and the subject. */
function splitRef(ref: string): { code: string; subject: string } | null {
    const colon = ref.indexOf(':');
    if (colon <= 0) return null;
    return { code: ref.slice(0, colon), subject: ref.slice(colon + 1) };
}

function namesOf(json: unknown): string[] {
    const high = (json as { high?: unknown } | null)?.high;
    if (!Array.isArray(high)) return [];
    return high
        .map((p) => (p && typeof p === 'object' ? (p as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === 'string');
}

function unknownCountOf(json: unknown): number {
    const unknown = (json as { unknown?: unknown } | null)?.unknown;
    return Array.isArray(unknown) ? unknown.length : 0;
}

/**
 * The Integrations tab's read: each trusted scanner's LATEST scan (by `asOf`,
 * then arrival, then id), its source coverage, and its applications as the
 * planner concluded them, with the open findings about each.
 *
 * Read under the inventory rule, as the harness tab is. Writes nothing.
 * An empty population is never rendered as an empty state: no scan, an EMPTY
 * scan and a trusted scanner with no scan are each a stated condition.
 */
export async function getThirdPartyAppInventory(
    ctx: RequestContext,
    opts: { scanWindow?: number; rowCap?: number } = {},
): Promise<ThirdPartyAppInventoryView> {
    assertMayRead(ctx);
    const window = Math.min(Math.max(opts.scanWindow ?? THIRD_PARTY_SCAN_WINDOW, 1), THIRD_PARTY_SCAN_WINDOW);
    const rowCap = Math.min(Math.max(opts.rowCap ?? THIRD_PARTY_ROW_CAP, 1), THIRD_PARTY_ROW_CAP);

    return runInTenantContext(ctx, async (db) => {
        const listed = await db.thirdPartyAppScan.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: SCAN_ORDER,
            take: window + 1,
            select: {
                id: true,
                scanRef: true,
                scannerAgentId: true,
                scannerVersion: true,
                asOf: true,
                complete: true,
                applicationCount: true,
                unusedDays: true,
                sourcesJson: true,
                createdAt: true,
            },
        });
        const scansTruncated = listed.length > window;
        const scanned = listed.slice(0, window);

        // The latest scan per scanner, in the order of the scans themselves.
        const latestByScanner = new Map<string, (typeof scanned)[number]>();
        for (const s of scanned) if (!latestByScanner.has(s.scannerAgentId)) latestByScanner.set(s.scannerAgentId, s);
        const shown = [...latestByScanner.values()].slice(0, MAX_THIRD_PARTY_SECTIONS);
        const scannersNotShown = latestByScanner.size - shown.length;

        const keyHolders = await db.agentHarnessScannerKey.findMany({
            where: { tenantId: ctx.tenantId, revokedAt: null },
            select: { agentId: true },
            distinct: ['agentId'],
            orderBy: { agentId: 'asc' },
            take: KEY_HOLDER_CAP + 1,
        });
        const withoutScanIds = keyHolders
            .slice(0, KEY_HOLDER_CAP)
            .map((k) => k.agentId)
            .filter((id) => !latestByScanner.has(id));

        const agentIds = [...new Set([...shown.map((s) => s.scannerAgentId), ...withoutScanIds])];
        const agents = agentIds.length === 0
            ? []
            : await db.registeredAgent.findMany({
                where: { tenantId: ctx.tenantId, id: { in: agentIds } },
                select: { id: true, name: true, deletedAt: true },
                take: agentIds.length,
            });
        const nameOf = new Map(agents.map((a) => [a.id, a.deletedAt === null ? a.name : null]));

        const items = shown.length === 0
            ? []
            : await db.thirdPartyAppScanItem.findMany({
                where: { tenantId: ctx.tenantId, scanId: { in: shown.map((s) => s.id) } },
                select: {
                    scanId: true,
                    appId: true,
                    privilege: true,
                    usage: true,
                    daysSinceSignIn: true,
                    classes: true,
                    grantsJson: true,
                    publisherVerified: true,
                    ownerCount: true,
                    app: { select: { applicationId: true, sourceKind: true, displayName: true } },
                },
                orderBy: [{ scanId: 'asc' }, { appId: 'asc' }],
                take: ITEM_CAP + 1,
            });
        const itemsUnread = items.length > ITEM_CAP;

        const openFindings = shown.length === 0
            ? []
            : await db.finding.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    sourceKind: THIRD_PARTY_APP_FINDING_SOURCE_KIND,
                    status: { not: 'CLOSED' },
                    deletedAt: null,
                },
                select: { id: true, sourceRef: true, severity: true },
                orderBy: { createdAt: 'asc' },
                take: OPEN_FINDING_CAP + 1,
            });
        const findingsTruncated = openFindings.length > OPEN_FINDING_CAP;
        const findingsBySubject = new Map<string, ThirdPartyOpenFinding[]>();
        for (const f of openFindings.slice(0, OPEN_FINDING_CAP)) {
            const split = f.sourceRef ? splitRef(f.sourceRef) : null;
            if (!split) continue;
            const list = findingsBySubject.get(split.subject) ?? [];
            list.push({ code: split.code, findingId: f.id, severity: f.severity });
            findingsBySubject.set(split.subject, list);
        }

        const sections: ThirdPartyScanSection[] = shown.map((s) => {
            const parsedSources = SourcesSchema.safeParse(s.sourcesJson);
            const sources: ThirdPartyAppSourceView[] | null = parsedSources.success
                ? parsedSources.data.map((src) => ({
                    kind: src.kind,
                    product: productOf(src.kind),
                    status: src.status,
                    reason: src.reason ?? null,
                    rows: src.rows,
                    signIn: src.signInActivity.status,
                    signInReason: src.signInActivity.status === 'INCOMPLETE' ? src.signInActivity.reason : null,
                    openFindings: findingsBySubject.get(`${src.kind}@${s.scannerAgentId}`) ?? [],
                }))
                : null;
            const scan: ThirdPartyScanView = {
                id: s.id,
                scanRef: s.scanRef,
                scannerAgentId: s.scannerAgentId,
                scannerName: nameOf.get(s.scannerAgentId) ?? null,
                scannerVersion: s.scannerVersion,
                asOf: s.asOf.toISOString(),
                ingestedAt: s.createdAt.toISOString(),
                completeness: thirdPartyScanCompleteness({
                    complete: s.complete,
                    applicationCount: s.applicationCount,
                    sourcesReadable: sources !== null,
                }),
                applicationCount: s.applicationCount,
                unusedDays: s.unusedDays,
            };
            if (itemsUnread) return { scan, sources, rows: [], rowsTruncated: false, rowsUnread: true };

            const rows: ThirdPartyAppRow[] = items
                .filter((i) => i.scanId === s.id)
                .map((i) => {
                    const kind = i.app.sourceKind;
                    const names = namesOf(i.grantsJson);
                    return {
                        appId: i.appId,
                        applicationId: i.app.applicationId,
                        sourceKind: kind,
                        product: productOf(kind),
                        name: i.app.displayName,
                        privilege: i.privilege as ThirdPartyAppRow['privilege'],
                        classes: [...i.classes],
                        highPermissions: names.slice(0, HIGH_PERMISSIONS_SHOWN),
                        highPermissionCount: names.length,
                        unknownPermissionCount: unknownCountOf(i.grantsJson),
                        publisher: {
                            state: knownState(kind, 'INTEGRATION_UNVERIFIED_PUBLISHER', i.publisherVerified !== null),
                            verified: i.publisherVerified,
                        },
                        owners: {
                            state: knownState(kind, 'INTEGRATION_NO_OWNER', i.ownerCount !== null),
                            count: i.ownerCount,
                        },
                        usage: i.usage as ThirdPartyAppRow['usage'],
                        signIn: knownState(kind, 'INTEGRATION_UNUSED', i.usage !== 'NOT_CONCLUDED'),
                        daysSinceSignIn: i.daysSinceSignIn,
                        openFindings: findingsBySubject.get(i.app.applicationId) ?? [],
                    };
                })
                .sort(
                    (a, b) =>
                        b.openFindings.length - a.openFindings.length
                        || (PRIVILEGE_ORDER[a.privilege] ?? 9) - (PRIVILEGE_ORDER[b.privilege] ?? 9)
                        || (a.applicationId < b.applicationId ? -1 : a.applicationId > b.applicationId ? 1 : 0),
                );
            return {
                scan,
                sources,
                rows: rows.slice(0, rowCap),
                rowsTruncated: rows.length > rowCap,
                rowsUnread: false,
            };
        });

        return {
            sections,
            scannersNotShown,
            scannersWithoutScan: {
                rows: withoutScanIds.map((agentId) => ({ agentId, name: nameOf.get(agentId) ?? null })),
                truncated: keyHolders.length > KEY_HOLDER_CAP,
            },
            scanWindow: window,
            scansTruncated,
            findingsTruncated,
        };
    });
}
