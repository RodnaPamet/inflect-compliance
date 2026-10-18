/**
 * The integration passport, week on week (#3672) — the I/O around two pure
 * modules.
 *
 * `src/lib/agentic/integration-passport.ts` builds one connection's passport
 * from stored rows; `integration-passport-drift.ts` decides which difference
 * between two weeks is a finding and whose. This file reads the rows, recovers
 * the previous week's passports, and writes what the planner decided:
 *
 *   tx1 (read)  every `mcp-server` connection and every per-tool row keyed by
 *               its qualified name — one bounded read per table, never one per
 *               connection — the owners' memberships, the target controls, the
 *               newest emission strictly before this week, and the audit entries
 *               in the window since it.
 *   build       decrypt each connection secret ONCE, resolve the grant kind,
 *               drop the secret. No network call: the funnel enforces a moved
 *               definition on every run; the passport records what was accepted.
 *   plan        pure.
 *   tx2 (write) under the tenant's passport lock: emit this week's passports as
 *               Evidence AND reconcile the findings raised against them, in ONE
 *               transaction, so the week's passport and its findings land
 *               together or not at all.
 *   audit       after commit (see `runIntegrationPassportSweep`).
 *
 * ── WHERE LAST WEEK'S PASSPORTS COME FROM ───────────────────────────────────
 *
 * There is no passport table. The previous passport is the newest
 * `INTEGRATION_PASSPORTS` artefact whose period starts STRICTLY BEFORE this
 * week, read out of its `Evidence.content` and verified against the artefact's
 * `sourceDigest`:
 *
 *   • The specification compares with "the last one emitted", and the emitted
 *     artefact is the only stored thing that can answer added / removed /
 *     changed field by field. Findings record only differences, so they cannot
 *     reconstruct a passport.
 *   • `IntegrationExecution.resultJson` is purged by retention and has no
 *     unique key, so next week could neither rely on it nor find it.
 *   • `Evidence.content` is user-editable; `sourceDigest` has no route writer.
 *     Verifying one against the other turns an editable body into a
 *     tamper-evident one, and a body that fails is a HIGH finding, never a
 *     silent baseline.
 *   • STRICTLY earlier makes a re-run inside the same week compare against the
 *     same prior, so the comparison is a function of (last week, now) — which is
 *     what makes the sweep idempotent per week.
 *
 * The cost, stated plainly: a tenant with no target control emits nothing and
 * so never has a prior. That tenant's drift is not compared, and the sweep says
 * so with `PASSPORT_NOT_EVIDENCED:NO_TARGET_CONTROL` rather than looking quiet.
 *
 * ── WHO READS WHAT THIS WRITES ──────────────────────────────────────────────
 *
 * The emitted passport is Evidence, and Evidence is read under `assertCanRead`
 * — READER, EDITOR and AUDITOR as well as the admins — and through the share
 * link of an audit pack that includes it. That is by design: evidence exists to be read by whoever
 * assesses the control. So a passport, and every finding raised from it,
 * carries only what may be read that widely (see the builder's header; P1 is
 * an origin and a keyed digest, never the URL). The OWNER-only view is a
 * placement beside the surfaces that change what it reports, not a
 * confidentiality boundary.
 */
import { logEvent, type AuditEventPayload } from '../events/audit';
import { assertCanWrite } from '../policies/common';
import { FindingRepository } from '../repositories/FindingRepository';
import type { RequestContext } from '../types';
import { MCP_SERVER_PROVIDER_ID } from '../integrations/providers/mcp-server-provider';
import {
    emitPassportArtefactsInTx,
    resolveTargetControls,
    type EmittedArtefact,
} from './agentic-evidence-emission';
import { assertOwnerInTenant } from './vendor-link-targets';

import { ARTEFACT_KIND_PASSPORTS, weeklyPeriod } from '@/lib/agentic/evidence-artefact';
import {
    ENDPOINT_DIGEST_DOMAIN,
    PASSPORT_BUNDLE_MAX_BYTES,
    SECRET_UNREADABLE,
    buildIntegrationPassport,
    buildPassportArtefactBody,
    buildPassportBundle,
    connectionToolPrefix,
    endpointUrlOf,
    extractPassportBundle,
    passportBundleDigest,
    serialisePassportBundle,
    writeDeclarationsOf,
    type IntegrationPassport,
    type PassportConnectionSource,
    type PassportGrantRow,
    type PassportPairingRow,
    type PassportParameterSetRow,
    type PassportPinRow,
    type PassportWriteDeclarations,
} from '@/lib/agentic/integration-passport';
import {
    PASSPORT_CITED_ACTIONS,
    PASSPORT_FINDING_SOURCE_KIND,
    accountableOwners,
    connectionRefPrefix,
    intendedAssignee,
    planPassportFindings,
    reassignedDescription,
    type NotEvidencedReason,
    type PassportAuditEntry,
    type PassportPrior,
    type PassportResolution,
    type PlannedPassportFinding,
    type PriorUnverifiableReason,
} from '@/lib/agentic/integration-passport-drift';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { logger } from '@/lib/observability';
import { decryptField, keyedChangeDigest } from '@/lib/security/encryption';
import { sanitizePlainText } from '@/lib/security/sanitize';

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * The connections one pass reads. Read as cap + 1, so "the population is
 * complete" is a fact the pass holds rather than one it cannot observe — a
 * truncated read would report every connection past the cap as VANISHED.
 */
export const PASSPORT_CONNECTION_CAP = 200;
/** The per-tool rows of one table one pass reads, across every connection. */
export const PASSPORT_ROW_CAP = 5_000;
/** The audit entries in the citation window. Over it, descriptions say so. */
export const PASSPORT_CITATION_CAP = 1_000;
/** Artefacts read to find the newest prior week. Every row of one week holds the same bundle. */
const PRIOR_ARTEFACT_CAP = 50;
/** Open findings the view lists for one connection. */
const VIEW_FINDINGS_CAP = 200;
/**
 * Open passport findings one pass reads to keep their assignee on the owner.
 * Over it, the first ones by id are moved and the rest wait a week, with a
 * WARN — no completeness claim rests on this read.
 */
export const PASSPORT_OPEN_FINDINGS_CAP = 5_000;

/**
 * The write transaction's budget. Above the 5 s tenant default because one
 * pass writes up to six artefacts (an Evidence body of up to 1 MB each) and a
 * finding per condition for every connection of the tenant — on a first Sunday
 * that is several findings per connection. It is a ceiling, not a target: a
 * pass that needs it is a database in trouble, and failing that tenant loudly
 * (next Sunday is the retry) is better than holding a pooled connection open.
 */
export const PASSPORT_SWEEP_TX_TIMEOUT_MS = 30_000;

/**
 * The tenant's passport lock. NAMESPACED, for the reason
 * `run-concurrency-policy.ts` gives: `appendAuditEntry` locks `hashtext(tenantId)`
 * itself, and sharing that key would queue every audit append of the tenant
 * behind a passport pass.
 */
function passportLockKey(tenantId: string): string {
    return `integration-passport:${tenantId}`;
}

// ── Loading ─────────────────────────────────────────────────────────────────

interface LoadedSources {
    readonly connections: readonly (Omit<PassportConnectionSource, 'secrets' | 'ownerMembershipActive' | 'endpointUrlDigest'> & {
        readonly secretEncrypted: string | null;
    })[];
    readonly activeOwnerIds: ReadonlySet<string>;
    readonly pins: readonly PassportPinRow[];
    readonly grants: readonly PassportGrantRow[];
    readonly pairings: readonly PassportPairingRow[];
    readonly parameterSets: readonly PassportParameterSetRow[];
    /** Which reads hit their cap. Empty means the population is complete. */
    readonly truncated: readonly string[];
}

/**
 * Every row a tenant's passports are built from. One bounded read per table,
 * matched to connections in memory by qualified-name prefix (the builder
 * re-filters by the exact `mcp__<id>__` prefix, so a LIKE that over-matches
 * cannot widen a passport).
 *
 * Every select is explicit and names only what a passport field reads: no
 * `parameters`, `pendingParameters` or `openFields` on a parameter set, no
 * description or schema text on a pin. A column that should not reach a
 * passport is excluded by not being selected.
 */
async function loadPassportSources(
    db: PrismaTx,
    ctx: RequestContext,
    only?: { connectionId: string },
): Promise<LoadedSources> {
    const connectionRows = await db.integrationConnection.findMany({
        where: {
            tenantId: ctx.tenantId,
            provider: MCP_SERVER_PROVIDER_ID,
            ...(only ? { id: only.connectionId } : {}),
        },
        select: {
            id: true,
            name: true,
            isEnabled: true,
            configJson: true,
            secretEncrypted: true,
            externalWriteMode: true,
            externalWriteModeSince: true,
            lastTestedAt: true,
            lastTestStatus: true,
            ownerUserId: true,
        },
        orderBy: { id: 'asc' },
        take: PASSPORT_CONNECTION_CAP + 1,
    });
    const truncated: string[] = [];
    if (connectionRows.length > PASSPORT_CONNECTION_CAP) truncated.push('connections');
    const connections = connectionRows.slice(0, PASSPORT_CONNECTION_CAP);

    if (connections.length === 0) {
        return { connections, activeOwnerIds: new Set(), pins: [], grants: [], pairings: [], parameterSets: [], truncated };
    }

    const prefixes = connections.map((c) => connectionToolPrefix(c.id));
    const byTool = prefixes.map((p) => ({ toolName: { startsWith: p } }));

    const pins = await db.mcpToolManifestPin.findMany({
        where: { tenantId: ctx.tenantId, OR: byTool },
        select: {
            toolName: true,
            descriptionHash: true,
            schemaHash: true,
            manifestHash: true,
            annotationsHash: true,
            revision: true,
            approvalSource: true,
            approvedByUserId: true,
            approvedAt: true,
            previousManifestHash: true,
            declaresWrite: true,
        },
        orderBy: { id: 'asc' },
        take: PASSPORT_ROW_CAP + 1,
    });
    const grants = await db.registeredAgentTool.findMany({
        where: { tenantId: ctx.tenantId, OR: byTool },
        select: { agentId: true, toolName: true, grantedByUserId: true, createdAt: true },
        orderBy: { id: 'asc' },
        take: PASSPORT_ROW_CAP + 1,
    });
    const pairings = await db.externalToolPriorStateRead.findMany({
        where: { tenantId: ctx.tenantId, OR: prefixes.map((p) => ({ writeToolName: { startsWith: p } })) },
        select: { writeToolName: true, readToolName: true, approvedByUserId: true, updatedAt: true },
        orderBy: { id: 'asc' },
        take: PASSPORT_ROW_CAP + 1,
    });
    const parameterSets = await db.externalToolParameterSet.findMany({
        where: { tenantId: ctx.tenantId, OR: byTool },
        select: {
            id: true,
            toolName: true,
            label: true,
            revision: true,
            parametersHash: true,
            approvalSource: true,
            approvedByUserId: true,
            targetPopulation: true,
            pendingHash: true,
        },
        orderBy: { id: 'asc' },
        take: PASSPORT_ROW_CAP + 1,
    });
    for (const [name, rows] of [
        ['pins', pins],
        ['grants', grants],
        ['pairings', pairings],
        ['parameterSets', parameterSets],
    ] as const) {
        if (rows.length > PASSPORT_ROW_CAP) truncated.push(name);
    }

    // P11's `accountable`: the named owner must hold an ACTIVE membership.
    // A named owner who left is no owner.
    const ownerIds = [...new Set(connections.map((c) => c.ownerUserId).filter((id): id is string => id !== null))];
    const memberships =
        ownerIds.length === 0
            ? []
            : await db.tenantMembership.findMany({
                  where: { tenantId: ctx.tenantId, userId: { in: ownerIds }, status: 'ACTIVE' },
                  select: { userId: true },
                  take: ownerIds.length,
              });

    return {
        connections,
        activeOwnerIds: new Set(memberships.map((m) => m.userId)),
        pins: pins.slice(0, PASSPORT_ROW_CAP),
        grants: grants.slice(0, PASSPORT_ROW_CAP),
        pairings: pairings.slice(0, PASSPORT_ROW_CAP),
        parameterSets: parameterSets.slice(0, PASSPORT_ROW_CAP),
        truncated,
    };
}

/**
 * Decrypt one connection's secret, or say it could not be.
 *
 * Once per connection per pass, and the value goes no further than the
 * builder's call to `resolveMcpCredentials`. A secret that does not decrypt is
 * `SECRET_UNREADABLE`, which the builder reports as grant kind `invalid`: the
 * runtime could not mint a token from it either. The WARN names the connection
 * and nothing about the value.
 */
function readSecrets(
    ctx: RequestContext,
    connectionId: string,
    secretEncrypted: string | null,
): PassportConnectionSource['secrets'] {
    if (secretEncrypted === null) return null;
    try {
        const parsed: unknown = JSON.parse(decryptField(secretEncrypted));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return SECRET_UNREADABLE;
        return parsed as Record<string, unknown>;
    } catch {
        logger.warn('integration passport: connection secret did not decrypt; grant kind reported as invalid', {
            component: 'integration-passport',
            tenantId: ctx.tenantId,
            connectionId,
        });
        return SECRET_UNREADABLE;
    }
}

/** Build every loaded connection's passport. Sorted by connection id. */
function buildPassports(ctx: RequestContext, loaded: LoadedSources): IntegrationPassport[] {
    // The ciphertext is taken off the row here and goes nowhere but the one
    // decrypt; the rest of the row is exactly `PassportConnectionSource`'s
    // stored columns, and the builder picks each of those by name.
    return loaded.connections.map(({ secretEncrypted, ...row }) => {
        const url = endpointUrlOf(row.configJson);
        return buildIntegrationPassport({
            connection: {
                ...row,
                // P1 is carried as its origin and this digest, never the URL:
                // a path or query can hold a credential, and a passport is
                // read by every evidence reader.
                endpointUrlDigest: url === null ? null : keyedChangeDigest(ENDPOINT_DIGEST_DOMAIN, url),
                secrets: readSecrets(ctx, row.id, secretEncrypted),
                ownerMembershipActive: row.ownerUserId !== null && loaded.activeOwnerIds.has(row.ownerUserId),
            },
            pins: loaded.pins,
            grants: loaded.grants,
            pairings: loaded.pairings,
            parameterSets: loaded.parameterSets,
        });
    });
}

// ── The prior ───────────────────────────────────────────────────────────────

/**
 * The newest passports emitted, verified — strictly before `before` when it is
 * given (the sweep: last week's), at any period otherwise (the view: the latest
 * there is, this week's included).
 *
 * Every artefact of one week holds the same bundle, so the first copy that
 * verifies is the bundle. A week whose every copy fails is UNVERIFIABLE with
 * the reason the first copy gave — never a silent baseline.
 */
async function loadPassportPrior(db: PrismaTx, ctx: RequestContext, before: Date | null): Promise<PassportPrior> {
    const rows = await db.agenticEvidenceArtefact.findMany({
        where: {
            tenantId: ctx.tenantId,
            kind: ARTEFACT_KIND_PASSPORTS,
            ...(before === null ? {} : { periodStart: { lt: before } }),
        },
        orderBy: [{ periodStart: 'desc' }, { id: 'asc' }],
        select: { id: true, status: true, sourceDigest: true, periodStart: true, lastEmittedAt: true, evidenceId: true },
        take: PRIOR_ARTEFACT_CAP,
    });
    if (rows.length === 0) return { status: 'NONE' };

    const newest = rows[0].periodStart;
    const periodLabel = weeklyPeriod(newest).label;
    const ofWeek = rows.filter((r) => r.periodStart.getTime() === newest.getTime());
    const current = ofWeek.filter((r) => r.status === 'CURRENT');
    if (current.length === 0) {
        // Every copy was withdrawn, and withdrawal REPLACES the body with a
        // notice — there is nothing left to compare with.
        return { status: 'UNVERIFIABLE', periodLabel, reason: 'WITHDRAWN' };
    }

    const bodies = await db.evidence.findMany({
        where: { tenantId: ctx.tenantId, id: { in: current.map((r) => r.evidenceId) }, deletedAt: null },
        select: { id: true, content: true },
        take: current.length,
    });
    const contentById = new Map(bodies.map((b) => [b.id, b.content]));

    let firstFailure: PriorUnverifiableReason | null = null;
    for (const row of current) {
        const content = contentById.get(row.evidenceId);
        if (typeof content !== 'string') {
            firstFailure ??= 'EVIDENCE_MISSING';
            continue;
        }
        const extracted = extractPassportBundle(content, row.sourceDigest, row.periodStart);
        if (extracted.ok) {
            return { status: 'VERIFIED', bundle: extracted.bundle, emittedAt: row.lastEmittedAt };
        }
        firstFailure ??= extracted.reason;
    }
    return { status: 'UNVERIFIABLE', periodLabel, reason: firstFailure ?? 'EVIDENCE_MISSING' };
}

/** The audit entries a finding may cite: everything in the window since the prior was last emitted. */
async function loadCitations(
    db: PrismaTx,
    ctx: RequestContext,
    since: Date,
): Promise<{ citations: PassportAuditEntry[]; truncated: boolean }> {
    const rows = await db.auditLog.findMany({
        where: { tenantId: ctx.tenantId, createdAt: { gt: since }, action: { in: [...PASSPORT_CITED_ACTIONS] } },
        select: {
            id: true,
            action: true,
            entity: true,
            entityId: true,
            userId: true,
            createdAt: true,
            detailsJson: true,
            metadataJson: true,
        },
        orderBy: { createdAt: 'asc' },
        take: PASSPORT_CITATION_CAP + 1,
    });
    return {
        citations: rows.slice(0, PASSPORT_CITATION_CAP),
        truncated: rows.length > PASSPORT_CITATION_CAP,
    };
}

// ── Reconcile ───────────────────────────────────────────────────────────────

/** An audit row queued for after commit. Structured details are REQUIRED, not optional. */
type QueuedAudit = AuditEventPayload & { readonly detailsJson: Record<string, unknown> };

interface ReconcileCounts {
    findingsOpened: number;
    findingsReopened: number;
    findingsResolved: number;
    findingsReassigned: number;
}

/**
 * Apply the plan to stored findings. The harness reconcile's shape, with the
 * two kinds of finding told apart:
 *
 *   no row          → create (assigned per the plan), linked to this week's
 *                     passport Evidence when one was emitted;
 *   row CLOSED      → a STATE finding reopens (the condition came back); an
 *                     EVENT finding stays closed — its key carries the week, so
 *                     a closed one is this week's event, already triaged;
 *   row not CLOSED  → nothing. This is the idempotency.
 *   resolve         → close, on positive evidence only.
 *   then reassign   → every finding about a connection that is still open
 *                     after the above follows the connection's accountable
 *                     owner (rule 3), or the OWNER role while it has none:
 *                     state and event alike, the ones raised this week and the
 *                     ones raised before. Only the description's ownership
 *                     tail is rewritten. A person who reassigns a passport
 *                     finding by hand is overruled at the next sweep — the
 *                     way to hand a connection's findings to somebody is to
 *                     name them its owner.
 *
 * Writes go through `FindingRepository` inside the caller's transaction rather
 * than `createFinding`, as the harness ingest does; the assignee is a user the
 * pass has already seen hold an ACTIVE membership. Audit rows are QUEUED, not
 * written: `logEvent` appends in its own transaction, and an audit row for a
 * finding whose transaction then rolled back would record something that never
 * happened.
 */
async function reconcilePassportFindings(
    db: PrismaTx,
    ctx: RequestContext,
    week: string,
    assert: readonly PlannedPassportFinding[],
    resolve: readonly PassportResolution[],
    owners: ReadonlyMap<string, string | null>,
    evidenceId: string | null,
    now: Date,
    audits: QueuedAudit[],
): Promise<ReconcileCounts> {
    const asserted = new Map<string, PlannedPassportFinding>();
    for (const f of assert) if (!asserted.has(f.sourceRef)) asserted.set(f.sourceRef, f);
    const resolving = resolve.filter((r) => !asserted.has(r.sourceRef));

    const refs = [...new Set([...asserted.keys(), ...resolving.map((r) => r.sourceRef)])];
    const existing =
        refs.length === 0
            ? []
            : await db.finding.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      sourceKind: PASSPORT_FINDING_SOURCE_KIND,
                      sourceRef: { in: refs },
                      deletedAt: null,
                  },
                  select: { id: true, sourceRef: true, status: true },
                  take: refs.length,
              });
    const byRef = new Map(existing.map((f) => [f.sourceRef as string, f]));

    const counts: ReconcileCounts = {
        findingsOpened: 0,
        findingsReopened: 0,
        findingsResolved: 0,
        findingsReassigned: 0,
    };

    for (const f of asserted.values()) {
        const prior = byRef.get(f.sourceRef);
        if (!prior) {
            const created = await FindingRepository.create(db, ctx, {
                severity: f.severity,
                type: f.type,
                title: sanitizePlainText(f.title),
                description: sanitizePlainText(f.description),
                status: 'OPEN',
                sourceKind: PASSPORT_FINDING_SOURCE_KIND,
                sourceRef: f.sourceRef,
                assigneeUserId: f.assigneeUserId,
            });
            if (evidenceId !== null) {
                // `Finding` has no producing-artefact column; FindingEvidence is
                // the bridge, as for a failed control test or drill.
                await db.findingEvidence.create({
                    data: { tenantId: ctx.tenantId, findingId: created.id, evidenceId },
                });
            }
            counts.findingsOpened += 1;
            audits.push({
                action: 'CREATE',
                entityType: 'Finding',
                entityId: created.id,
                details: `Integration passport sweep ${week} raised ${f.code}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Finding',
                    operation: 'created',
                    after: { code: f.code, sourceRef: f.sourceRef, severity: f.severity, week },
                },
            });
        } else if (prior.status === 'CLOSED' && f.nature === 'STATE') {
            await db.finding.update({
                where: { id: prior.id },
                data: {
                    status: 'OPEN',
                    verificationNotes: sanitizePlainText(`Reopened by integration passport sweep ${week}`),
                },
            });
            counts.findingsReopened += 1;
            audits.push({
                action: 'STATUS_CHANGE',
                entityType: 'Finding',
                entityId: prior.id,
                details: `Integration passport sweep ${week} reopened ${f.code}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Finding',
                    before: { status: 'CLOSED' },
                    after: { status: 'OPEN', sourceRef: f.sourceRef, week },
                },
            });
        }
    }

    for (const r of resolving) {
        const prior = byRef.get(r.sourceRef);
        if (!prior || prior.status === 'CLOSED') continue;
        await db.finding.update({
            where: { id: prior.id },
            data: {
                status: 'CLOSED',
                verifiedAt: now,
                verificationNotes: sanitizePlainText(`Resolved by integration passport sweep ${week}: ${r.because}`),
            },
        });
        counts.findingsResolved += 1;
        audits.push({
            action: 'STATUS_CHANGE',
            entityType: 'Finding',
            entityId: prior.id,
            details: `Integration passport sweep ${week} resolved ${r.sourceRef}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Finding',
                before: { status: prior.status },
                after: { status: 'CLOSED', sourceRef: r.sourceRef, week },
            },
        });
    }

    counts.findingsReassigned = await reassignOpenPassportFindings(db, ctx, week, owners, audits);
    return counts;
}

/**
 * Keep every open passport finding about a connection on that connection's
 * accountable owner — the half of rule 3 that a create-only reconcile misses.
 *
 * Without it, the first Sunday's findings (raised while every connection is
 * unowned, because the owner column starts empty) would stay unassigned after
 * an owner is named, their text still pointing at a CONNECTION_OWNER_MISSING
 * that is now closed; and an owner who left would keep the findings on a
 * connection nobody answers for. Runs after this pass's creates, reopens and
 * closes, inside the same transaction, so it reads exactly what is still open.
 */
async function reassignOpenPassportFindings(
    db: PrismaTx,
    ctx: RequestContext,
    week: string,
    owners: ReadonlyMap<string, string | null>,
    audits: QueuedAudit[],
): Promise<number> {
    if (owners.size === 0) return 0;
    const open = await db.finding.findMany({
        where: {
            tenantId: ctx.tenantId,
            sourceKind: PASSPORT_FINDING_SOURCE_KIND,
            status: { not: 'CLOSED' },
            deletedAt: null,
            OR: [...owners.keys()].map((id) => ({ sourceRef: { startsWith: connectionRefPrefix(id) } })),
        },
        select: { id: true, sourceRef: true, assigneeUserId: true },
        orderBy: { id: 'asc' },
        take: PASSPORT_OPEN_FINDINGS_CAP + 1,
    });
    if (open.length > PASSPORT_OPEN_FINDINGS_CAP) {
        logger.warn('integration passport: open findings over the reassignment cap; the rest move next week', {
            component: 'integration-passport',
            tenantId: ctx.tenantId,
            cap: PASSPORT_OPEN_FINDINGS_CAP,
        });
    }

    const moves = open.slice(0, PASSPORT_OPEN_FINDINGS_CAP).flatMap((f) => {
        const to = intendedAssignee(f.sourceRef ?? '', owners);
        return to === undefined || to === f.assigneeUserId ? [] : [{ ...f, to }];
    });
    if (moves.length === 0) return 0;

    // Descriptions only for the rows that move: every row read is decrypted.
    const bodies = await db.finding.findMany({
        where: { tenantId: ctx.tenantId, id: { in: moves.map((m) => m.id) } },
        select: { id: true, description: true },
        take: moves.length,
    });
    const descriptionById = new Map(bodies.map((b) => [b.id, b.description ?? '']));

    for (const m of moves) {
        await db.finding.update({
            where: { id: m.id },
            data: {
                assigneeUserId: m.to,
                description: sanitizePlainText(
                    reassignedDescription(descriptionById.get(m.id) ?? '', m.assigneeUserId, m.to),
                ),
            },
        });
        audits.push({
            action: 'UPDATE',
            entityType: 'Finding',
            entityId: m.id,
            details: `Integration passport sweep ${week} reassigned ${m.sourceRef} to the connection's accountable owner`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Finding',
                operation: 'updated',
                changedFields: ['assigneeUserId', 'description'],
                before: { assigneeUserId: m.assigneeUserId },
                after: { assigneeUserId: m.to, sourceRef: m.sourceRef, week },
            },
        });
    }
    return moves.length;
}

// ── The sweep: one tenant pass ──────────────────────────────────────────────

export type PassportSweepOutcome =
    /** Compared with a verified prior; events raised where the passports differ. */
    | 'COMPARED'
    /** Nothing was ever emitted: this week is every connection's baseline. */
    | 'BASELINE'
    /** The newest prior did not verify: raised as HIGH, every connection a baseline. */
    | 'PRIOR_UNVERIFIABLE'
    /** No target control, or the bundle is too large: nothing emitted, nothing compared. */
    | 'NOT_EVIDENCED'
    /** A read reached its cap: its own finding and the read rows' state findings; nothing compared, emitted or closed. */
    | 'TRUNCATED'
    /** No connection now and none in the last emission: nothing to say. */
    | 'NO_CONNECTIONS';

export interface PassportSweepResult {
    readonly outcome: PassportSweepOutcome;
    readonly periodLabel: string;
    readonly connections: number;
    readonly findingsOpened: number;
    readonly findingsReopened: number;
    readonly findingsResolved: number;
    readonly findingsReassigned: number;
    readonly artefacts: readonly EmittedArtefact[];
}

/**
 * One tenant's weekly pass. Idempotent per ISO week, durably rather than by a
 * job id:
 *
 *   1. the comparison is a function of (the newest prior STRICTLY before this
 *      week, now), so a re-run compares against the same prior;
 *   2. the artefact identity `(tenant, control, kind, weekStart)` is a UNIQUE
 *      index, so a re-run updates in place;
 *   3. state finding keys carry no week and event keys carry it, so a re-run
 *      finds the rows it would create;
 *   4. the tenant's passport lock serialises overlapping passes;
 *   5. a week's findings and artefacts are written in one transaction.
 *
 * Event findings are written ONLY by a pass that also emits the passport they
 * were found against. A pass that raised events without emitting would leave
 * the old prior in place, and next week would raise the same events again
 * under next week's key.
 *
 * A pass for a week EARLIER than one this tenant already holds passports for
 * is refused (`conflict`, under the lock, before anything is written). The
 * passports are built from the rows as they are when the pass runs, whatever
 * week it names, and the prior is chosen relative to that week: a pass for
 * W41 run after W43 would rewrite W41's evidence with W43's rows and raise
 * W42's and W43's changes again under W41's key. The job refuses a week that
 * has not begun, so this refusal cannot be provoked by a pass run early.
 */
export async function runIntegrationPassportSweep(
    ctx: RequestContext,
    options: { asOf?: Date; actorUserId: string | null },
): Promise<PassportSweepResult> {
    assertCanWrite(ctx);

    const now = options.asOf ?? new Date();
    const period = weeklyPeriod(now);

    const read = await runInTenantContext(ctx, async (db) => {
        const loaded = await loadPassportSources(db, ctx);
        const targets = (await resolveTargetControls(db, ctx)).byKind.get(ARTEFACT_KIND_PASSPORTS) ?? [];
        const prior = await loadPassportPrior(db, ctx, period.start);
        const window =
            prior.status === 'VERIFIED' ? await loadCitations(db, ctx, prior.emittedAt) : { citations: [], truncated: false };
        return { loaded, targets, prior, ...window };
    });

    // Built even when a read was truncated: the planner raises the state
    // findings of the rows that WERE read, and plans nothing else.
    const passports = buildPassports(ctx, read.loaded);
    const priorHadConnections = read.prior.status === 'VERIFIED' ? read.prior.bundle.connections.length > 0 : read.prior.status === 'UNVERIFIABLE';

    if (read.loaded.truncated.length === 0 && passports.length === 0 && !priorHadConnections) {
        return {
            outcome: 'NO_CONNECTIONS',
            periodLabel: period.label,
            connections: 0,
            findingsOpened: 0,
            findingsReopened: 0,
            findingsResolved: 0,
            findingsReassigned: 0,
            artefacts: [],
        };
    }

    const bundle = buildPassportBundle(period, passports);
    const serialised = serialisePassportBundle(bundle);
    const digest = passportBundleDigest(serialised);

    const notEvidenced: NotEvidencedReason[] = [];
    if (read.loaded.truncated.length > 0) {
        notEvidenced.push('POPULATION_TRUNCATED');
        logger.warn('integration passport: a source read reached its cap; nothing compared, emitted or closed', {
            component: 'integration-passport',
            tenantId: ctx.tenantId,
            period: period.label,
            truncated: read.loaded.truncated,
        });
    } else {
        if (read.targets.length === 0) notEvidenced.push('NO_TARGET_CONTROL');
        if (Buffer.byteLength(serialised, 'utf8') > PASSPORT_BUNDLE_MAX_BYTES) notEvidenced.push('BUNDLE_TOO_LARGE');
    }
    const evidenced = notEvidenced.length === 0;

    const plan = planPassportFindings({
        period,
        current: passports,
        prior: read.prior,
        citations: read.citations,
        citationsTruncated: read.truncated,
        notEvidenced,
    });

    const audits: QueuedAudit[] = [];
    const written = await runInTenantContext(
        ctx,
        async (db) => {
            await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, passportLockKey(ctx.tenantId));
            await assertWeekNotSuperseded(db, ctx, period);

            const artefacts = evidenced
                ? await emitPassportArtefactsInTx(db, ctx, {
                      period,
                      digest,
                      recordCount: passports.length,
                      body: buildPassportArtefactBody(period, bundle, digest),
                      targets: read.targets,
                      actorUserId: options.actorUserId,
                  })
                : [];

            const counts = await reconcilePassportFindings(
                db,
                ctx,
                period.label,
                plan.assert,
                plan.resolve,
                accountableOwners(passports),
                artefacts[0]?.evidenceId ?? null,
                now,
                audits,
            );
            return { artefacts, counts };
        },
        { timeout: PASSPORT_SWEEP_TX_TIMEOUT_MS },
    );

    const outcome: PassportSweepOutcome = read.loaded.truncated.length > 0
        ? 'TRUNCATED'
        : !evidenced
        ? 'NOT_EVIDENCED'
        : read.prior.status === 'UNVERIFIABLE'
        ? 'PRIOR_UNVERIFIABLE'
        : plan.compared
        ? 'COMPARED'
        : 'BASELINE';

    audits.push({
        action: 'INTEGRATION_PASSPORT_SWEPT',
        entityType: 'IntegrationPassport',
        entityId: period.label,
        details: `Integration passport sweep ${period.label}: ${outcome}`,
        detailsJson: {
            category: 'custom',
            event: 'integration_passport_swept',
            period: period.label,
            outcome,
            connections: passports.length,
            findingsOpened: written.counts.findingsOpened,
            findingsReopened: written.counts.findingsReopened,
            findingsResolved: written.counts.findingsResolved,
            findingsReassigned: written.counts.findingsReassigned,
            artefactsCreated: written.artefacts.filter((a) => a.outcome === 'created').length,
            artefactsUpdated: written.artefacts.filter((a) => a.outcome === 'updated').length,
            artefactsUnchanged: written.artefacts.filter((a) => a.outcome === 'unchanged').length,
        },
    });
    await writeAuditsAfterCommit(ctx, audits);

    return {
        outcome,
        periodLabel: period.label,
        connections: passports.length,
        ...written.counts,
        artefacts: written.artefacts,
    };
}

/**
 * Refuse a pass for a week earlier than the newest one this tenant already
 * holds passports for — any status, a withdrawn week included, because a
 * withdrawn week was still swept. See `runIntegrationPassportSweep`.
 */
async function assertWeekNotSuperseded(
    db: PrismaTx,
    ctx: RequestContext,
    period: { readonly start: Date; readonly label: string },
): Promise<void> {
    const later = await db.agenticEvidenceArtefact.findFirst({
        where: { tenantId: ctx.tenantId, kind: ARTEFACT_KIND_PASSPORTS, periodStart: { gt: period.start } },
        select: { periodStart: true },
        orderBy: { periodStart: 'desc' },
    });
    if (later) {
        throw conflict(
            `Integration passports for ${weeklyPeriod(later.periodStart).label} are already emitted; a pass for the `
                + `earlier week ${period.label} would rebuild that week's evidence from the rows as they are now and `
                + 'raise later changes again under its key.',
        );
    }
}

/**
 * The pass's audit rows, after its write transaction committed.
 *
 * `logEvent` appends through `appendAuditEntry`, which runs in a transaction of
 * its own under the tenant's chain lock. Written inside the write transaction,
 * an audit row would commit even when the findings it describes rolled back.
 * A failure here is logged, not thrown: the findings are committed, and
 * failing the pass would make next Sunday's retry find nothing to do.
 */
async function writeAuditsAfterCommit(ctx: RequestContext, audits: readonly QueuedAudit[]): Promise<void> {
    try {
        await runInTenantContext(
            ctx,
            async (db) => {
                for (const a of audits) await logEvent(db, ctx, { ...a, detailsJson: a.detailsJson });
            },
            { timeout: PASSPORT_SWEEP_TX_TIMEOUT_MS },
        );
    } catch (err) {
        logger.error('integration passport: audit rows after commit failed', {
            component: 'integration-passport',
            tenantId: ctx.tenantId,
            audits: audits.length,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── The view: one connection, live ──────────────────────────────────────────

export interface IntegrationPassportView {
    readonly current: IntegrationPassport;
    readonly writeDeclarations: PassportWriteDeclarations;
    /** The newest emission of any week, this week's included. */
    readonly lastEmitted: {
        readonly periodLabel: string;
        readonly verified: boolean;
        readonly reason: string | null;
        /** This connection's passport in that emission has the current digest. */
        readonly unchangedSince: boolean;
    } | null;
    /** What the next sweep would raise against that emission. A preview: nothing is written. */
    readonly changes: readonly {
        readonly code: string;
        readonly severity: string;
        readonly field: string | null;
        readonly item: string | null;
    }[];
    /** This connection's passport findings that are not CLOSED. */
    readonly openFindings: readonly {
        readonly id: string;
        readonly title: string;
        readonly severity: string;
        readonly status: string;
        readonly sourceRef: string;
        readonly assigneeUserId: string | null;
    }[];
    /** For display only; never part of the passport. */
    readonly owner: { readonly userId: string; readonly name: string | null; readonly email: string | null } | null;
}

/**
 * One connection's passport, built live from the same rows the sweep reads,
 * with what the last emission said and what the next sweep would raise.
 *
 * UNGATED HERE, and that is the external-write-policy precedent: the route
 * holds `requirePermission('admin.tenant_lifecycle')`, because the passport
 * shows the write rung and the prior-state pairings, which are OWNER reads. A
 * second, weaker check inside the usecase is how a route comes to look
 * protected while granting more than it says. A connection that is not
 * `mcp-server` has no passport and is a 404.
 */
export async function getIntegrationPassportView(
    ctx: RequestContext,
    connectionId: string,
): Promise<IntegrationPassportView> {
    const period = weeklyPeriod(new Date());
    const read = await runInTenantContext(ctx, async (db) => {
        const loaded = await loadPassportSources(db, ctx, { connectionId });
        if (loaded.connections.length === 0) throw notFound('No external agent connection with that id');
        const prior = await loadPassportPrior(db, ctx, null);
        const findings = await db.finding.findMany({
            where: {
                tenantId: ctx.tenantId,
                sourceKind: PASSPORT_FINDING_SOURCE_KIND,
                sourceRef: { startsWith: connectionRefPrefix(connectionId) },
                status: { not: 'CLOSED' },
                deletedAt: null,
            },
            select: { id: true, title: true, severity: true, status: true, sourceRef: true, assigneeUserId: true },
            orderBy: { createdAt: 'desc' },
            take: VIEW_FINDINGS_CAP,
        });
        const ownerUserId = loaded.connections[0].ownerUserId;
        const owner =
            ownerUserId === null
                ? null
                : await db.user.findFirst({
                      where: { id: ownerUserId, tenantMemberships: { some: { tenantId: ctx.tenantId } } },
                      select: { id: true, name: true, email: true },
                  });
        return { loaded, prior, findings, owner };
    });

    const [current] = buildPassports(ctx, read.loaded);
    const priorPassport =
        read.prior.status === 'VERIFIED'
            ? read.prior.bundle.connections.find((p) => p.connectionId === connectionId) ?? null
            : null;

    // The planner against the last verified emission, narrowed to this one
    // connection on both sides so another connection's absence is not this
    // one's VANISHED. Events only: state conditions are the open findings.
    const preview =
        read.prior.status === 'VERIFIED'
            ? planPassportFindings({
                  period,
                  current: [current],
                  prior: {
                      status: 'VERIFIED',
                      emittedAt: read.prior.emittedAt,
                      bundle: { ...read.prior.bundle, connections: priorPassport ? [priorPassport] : [] },
                  },
                  citations: [],
                  citationsTruncated: false,
                  notEvidenced: [],
              }).assert.filter((f) => f.nature === 'EVENT')
            : [];

    return {
        current,
        writeDeclarations: writeDeclarationsOf(current),
        lastEmitted:
            read.prior.status === 'NONE'
                ? null
                : {
                      periodLabel: read.prior.status === 'VERIFIED' ? read.prior.bundle.periodLabel : read.prior.periodLabel,
                      verified: read.prior.status === 'VERIFIED',
                      reason: read.prior.status === 'UNVERIFIABLE' ? read.prior.reason : null,
                      unchangedSince: priorPassport !== null && priorPassport.digest === current.digest,
                  },
        changes: preview.map((f) => ({ code: f.code, severity: f.severity, field: f.field, item: f.item })),
        openFindings: read.findings.map((f) => ({
            id: f.id,
            title: f.title,
            severity: f.severity,
            status: f.status,
            sourceRef: f.sourceRef ?? '',
            assigneeUserId: f.assigneeUserId,
        })),
        owner: read.owner ? { userId: read.owner.id, name: read.owner.name, email: read.owner.email } : null,
    };
}

// ── P11: who answers for a connection ───────────────────────────────────────

export interface SetConnectionOwnerResult {
    readonly connectionId: string;
    readonly ownerUserId: string | null;
    readonly changed: boolean;
}

/**
 * Name (or clear) the person accountable for an external agent connection —
 * the source of passport field P11.
 *
 * `admin.manage` at the route, the connection-write permission, and the
 * upsert's own `canAdmin` floor here. Its own path rather than a field on the
 * connection upsert for two reasons: the upsert computes `isEnabled ?? true`,
 * so an edit that omitted it would RE-ENABLE a disabled connection as a side
 * effect of naming its owner; and an owner change is audited as itself, which
 * is the entry the passport's OWNER_CHANGED finding cites.
 *
 * Only for `mcp-server` connections, the population that has a passport.
 * A non-null owner must hold an ACTIVE membership of this tenant, checked
 * here rather than left to the foreign key, which would accept any user of
 * any tenant. `null` clears the owner, and the next sweep raises
 * CONNECTION_OWNER_MISSING.
 */
export async function setIntegrationConnectionOwner(
    ctx: RequestContext,
    connectionId: string,
    ownerUserId: string | null,
): Promise<SetConnectionOwnerResult> {
    if (!ctx.permissions?.canAdmin) throw forbidden('Admin only');
    if (ownerUserId !== null && ownerUserId.trim() === '') throw badRequest('ownerUserId must be a user id or null');

    return runInTenantContext(ctx, async (db) => {
        const connection = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, provider: MCP_SERVER_PROVIDER_ID },
            select: { id: true, ownerUserId: true },
        });
        if (!connection) throw notFound('No external agent connection with that id');

        if (ownerUserId !== null) await assertOwnerInTenant(db, ctx, ownerUserId);

        if (connection.ownerUserId === ownerUserId) {
            return { connectionId, ownerUserId, changed: false };
        }

        // `ownerUserId` ONLY. Nothing else on the row moves — in particular
        // not `isEnabled`.
        await db.integrationConnection.update({
            where: { id: connection.id },
            data: { ownerUserId },
        });
        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_OWNER_SET',
            entityType: 'IntegrationConnection',
            entityId: connectionId,
            details: ownerUserId === null ? 'Connection owner cleared' : 'Connection owner set',
            detailsJson: {
                category: 'custom',
                event: 'integration_connection_owner_set',
                from: connection.ownerUserId,
                to: ownerUserId,
            },
        });
        return { connectionId, ownerUserId, changed: true };
    });
}
