/**
 * Running the reconciliation engine over a COMPLETE snapshot, and recording what
 * it concluded.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE GATES, AND EACH REFUSES THE WHOLE RUN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **The snapshot must be `COMPLETE`.** A resolution over a population nobody
 *    can vouch for inherits exactly that problem, and the artefact it eventually
 *    feeds would attest coverage of an application rather than of the rows we
 *    happened to read.
 * 2. **The roster must be fresh** — the latest HRIS sync `PASSED` within the
 *    window, or `NO_FRESH_ROSTER`. A stale roster does not degrade gracefully: it
 *    mass-produces false orphans (accounts whose owner was hired after the last
 *    sync) and false leavers (people the feed has not yet re-reported).
 * 3. **The directory bridge must be fresh per link**, with the predicate
 *    `findLeaverCandidates` applies. This one is not a whole-run refusal — a
 *    stale link is simply not crossed, so the account resolves on its other
 *    evidence or not at all.
 *
 * Gates 1 and 2 write NO resolutions. There is no partial run.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DIRECTORY TABLES ARE READ-ONLY HERE, AND THAT IS INVARIANT 1
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `IdentityAccountLink` and `ConnectedIdentityAccount` are read to build the
 * bridge index and never written. `tests/guards/directory-identity-tables-single-write-seam.test.ts`
 * enforces it across a delegate call, a transaction-client call and raw SQL, with
 * the seams listed in that file and nowhere else — a row written by a matcher
 * that guessed would not look wrong, it would look like a sync had found it.
 *
 * The freshness constant comes from `identity-write-target.ts` rather than from
 * `identity-leaver-pass.ts`, following the joiner's precedent. Importing the pass
 * would drag the writer factory, both provider writers and `undici` into this
 * module's graph for one number — and for THIS module that is sharper than graph
 * size: legacy code must never write a directory table, so pulling the writer
 * factory into its import graph is the wrong direction even with no call site.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS STEP ONLY READS ALIASES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LegacyIdentityAlias` is the one thing that can turn an account into a
 * `LINKED` on its own, so a row there is a decision a person made. Step 4b writes
 * them. Nothing here does, and a `create` on that model in this file should fail
 * review on sight.
 *
 * @module app-layer/usecases/legacy-reconcile
 */

import type { LegacyMatchMethod, LegacyResolutionOutcome, Prisma } from '@prisma/client';

import {
    SYNC_BOOKKEEPING_TX_OPTIONS,
    SYNC_WRITE_TX_OPTIONS,
} from '@/app-layer/integrations/sync-transaction';
import { HRIS_PROVIDERS } from '@/app-layer/integrations/providers/hris';
import { LEGACY_MCP_PROVIDER_ID } from '@/app-layer/integrations/providers/legacy-mcp';
import { OBSERVATION_FRESHNESS_MS } from '@/app-layer/usecases/identity-write-target';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import {
    recordLegacyReconcileOutcomes,
    recordLegacyReconcileRefused,
} from '@/lib/observability/integration-metrics';
import {
    reconcile,
    // ALIASED, because `lib/legacy-access/canonical` exports a type of the same
    // name and they are NOT the same thing: this one is the engine's INPUT shape
    // (eight fields, `createdAt` as an ISO string) and that one is 2a's STORAGE
    // shape (seventeen fields, `createdAt` a Date, and the exact shape the payload
    // hash is defined over). Importing both unaliased compiles until one of them
    // gains a field.
    type CanonicalAccount as EngineAccount,
    type ConfirmedAlias,
    type DirectoryAccount,
    type EngineResult,
    type Outcome,
    type Resolution,
    type RosterEmployee,
} from '@/lib/identity/reconcile/engine';
import { step4aExtensions } from '@/lib/identity/reconcile/scorers';
import { CONVENTION_CONFIG_KEY } from './legacy-username-convention';
import { ACCOUNT_SELECT, type StoredAccountRow } from './legacy-access-verify';
import type { RequestContext } from '../types';
import { assertCanAdmin } from '../policies/common';

/**
 * How recently the HRIS feed must have reported.
 *
 * The SAME constant as the directory bridge's, deliberately. The design says the
 * roster gate is "modelled on `NO_FRESH_LINKS`", both feeds are nightly (HRIS at
 * 04:00, directory at 03:00), and two days tolerates one missed night. Giving the
 * roster its own number would mean two gates that are supposed to express one
 * idea — "somebody re-observed this recently" — drifting apart silently, and the
 * drift would show up as a reconciliation that trusts a roster the leaver pass
 * has already given up on.
 */
export const ROSTER_FRESHNESS_MS = OBSERVATION_FRESHNESS_MS;

/** Accounts written per transaction. Bounded so a tx budget binds known work. */
const RESOLUTION_WRITE_CHUNK = 500;

export const RECONCILE_REFUSALS = [
    'SNAPSHOT_NOT_FOUND',
    'SNAPSHOT_NOT_COMPLETE',
    'NO_FRESH_ROSTER',
    'EMPTY_SNAPSHOT',
] as const;

export type ReconcileRefusal = (typeof RECONCILE_REFUSALS)[number];

export interface ReconcileResult {
    readonly executionId: string | null;
    readonly snapshotId: string;
    readonly status: 'RESOLVED' | 'REFUSED';
    readonly refusal: ReconcileRefusal | null;
    readonly refusalDetail: string | null;
    readonly byOutcome: Readonly<Record<string, number>>;
    readonly resolved: number;
}

export interface ReconcileInput {
    readonly snapshotId: string;
    readonly triggeredBy?: string;
}

/**
 * Reconcile one snapshot.
 *
 * `assertCanAdmin`: a run decides which legacy accounts are claimed to belong to
 * which people, and a `LINKED` is acted on by later steps without anybody
 * re-reading the evidence.
 */
export async function runLegacyReconcile(
    ctx: RequestContext,
    input: ReconcileInput
): Promise<ReconcileResult> {
    assertCanAdmin(ctx);

    const bookkeeping = <T>(fn: (db: PrismaTx) => Promise<T>): Promise<T> =>
        runInTenantContext(ctx, fn, SYNC_BOOKKEEPING_TX_OPTIONS);

    const now = new Date();
    const staleBefore = new Date(now.getTime() - ROSTER_FRESHNESS_MS);

    // ── Open the run before any gate, so a refusal is visible ──────────────
    // The execution row IS the run. Committed first for the same reason the
    // pull's is: from here on there is a row on disk saying somebody tried, and
    // every refusal below updates it rather than vanishing.
    const opened = await bookkeeping(async (db) => {
        const snapshot = await db.legacyAccessSnapshot.findFirst({
            where: { id: input.snapshotId, tenantId: ctx.tenantId },
            select: { id: true, connectionId: true, status: true, rowCount: true },
        });
        const execution = await db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                connectionId: snapshot?.connectionId,
                provider: LEGACY_MCP_PROVIDER_ID,
                automationKey: `${LEGACY_MCP_PROVIDER_ID}.reconcile`,
                status: 'RUNNING',
                triggeredBy: input.triggeredBy ?? 'manual',
                executedAt: now,
            },
            select: { id: true },
        });
        return { snapshot, executionId: execution.id };
    });

    const { snapshot, executionId } = opened;

    const refuse = async (
        refusal: ReconcileRefusal,
        detail: string
    ): Promise<ReconcileResult> => {
        await bookkeeping((db) =>
            db.integrationExecution.update({
                where: { id: executionId },
                // PARTIAL rather than ERROR: the run reached a VERDICT about
                // whether it was safe to resolve, which is the thing it was asked
                // to do. ERROR would read as "the reconciler is broken" on a
                // surface where "the roster is stale" is the actionable fact.
                data: { status: 'PARTIAL', errorMessage: refusal, completedAt: new Date() },
            })
        );
        recordLegacyReconcileRefused({ provider: LEGACY_MCP_PROVIDER_ID, reason: refusal });
        logger.warn('legacy reconcile refused', {
            component: 'legacy-access',
            snapshotId: input.snapshotId,
            refusal,
        });
        return {
            executionId,
            snapshotId: input.snapshotId,
            status: 'REFUSED',
            refusal,
            refusalDetail: detail,
            byOutcome: {},
            resolved: 0,
        };
    };

    // ── Gate 1: the snapshot ────────────────────────────────────────────────
    if (!snapshot) {
        return refuse('SNAPSHOT_NOT_FOUND', 'no such snapshot for this tenant');
    }
    if (snapshot.status !== 'COMPLETE') {
        return refuse(
            'SNAPSHOT_NOT_COMPLETE',
            `snapshot is ${snapshot.status}; only a COMPLETE snapshot is a population `
            + 'anybody can vouch for'
        );
    }
    if (snapshot.rowCount === 0) {
        // Zero is never complete, one level up. A run over no accounts produces
        // no resolutions and would report success, and the campaign built on it
        // would attest a review of an empty set as a review of the application.
        return refuse('EMPTY_SNAPSHOT', 'the snapshot holds no accounts');
    }

    // ── Gate 2: the roster ──────────────────────────────────────────────────
    const freshHris = await bookkeeping((db) =>
        db.integrationExecution.findFirst({
            where: {
                tenantId: ctx.tenantId,
                provider: { in: [...HRIS_PROVIDERS] },
                status: 'PASSED',
                completedAt: { gte: staleBefore },
            },
            orderBy: { completedAt: 'desc' },
            select: { id: true, provider: true, completedAt: true },
        })
    );
    if (!freshHris) {
        return refuse(
            'NO_FRESH_ROSTER',
            `no HRIS sync has PASSED since ${staleBefore.toISOString()}; a stale roster `
            + 'mass-produces false orphans and false leavers rather than degrading gently'
        );
    }

    // ── Inputs ──────────────────────────────────────────────────────────────
    const accounts = await readAccounts(ctx, snapshot.id);
    const roster = await readRoster(ctx);
    const directory = await readDirectory(ctx, staleBefore);
    const aliases = await readAliases(ctx, snapshot.connectionId);
    const convention = await readConvention(ctx, snapshot.connectionId);

    // Step 4a's scorers and blockers. Passed in rather than imported by the
    // engine, which is what keeps the engine's `LINKED` guarantee a type-level
    // property: a `CandidateScorer` returns `SupportingSignal`, so nothing here
    // can produce a strong signal however it scores.
    const { scorers, blockers } = step4aExtensions(roster, convention);

    const result: EngineResult = reconcile({
        accounts,
        roster,
        directory,
        aliases,
        now: now.toISOString(),
        config: { scorers, blockers },
    });

    // ── Write the run ───────────────────────────────────────────────────────
    for (let i = 0; i < result.resolutions.length; i += RESOLUTION_WRITE_CHUNK) {
        const batch = result.resolutions.slice(i, i + RESOLUTION_WRITE_CHUNK);
        await runInTenantContext(
            ctx,
            (db) =>
                db.legacyAccountResolution.createMany({
                    data: batch.map((r) => toResolutionRow(ctx.tenantId, executionId, snapshot.id, r)),
                }),
            SYNC_WRITE_TX_OPTIONS
        );
    }

    // Counted FROM THE DATABASE, like the pull's row count: the number recorded
    // is the number of rows that exist, not the number we believe we wrote.
    const stored = await bookkeeping((db) =>
        db.legacyAccountResolution.count({ where: { tenantId: ctx.tenantId, executionId } })
    );

    const completedAt = new Date();
    await bookkeeping((db) =>
        db.integrationExecution.update({
            where: { id: executionId },
            data: {
                status: stored === result.resolutions.length ? 'PASSED' : 'ERROR',
                completedAt,
                ...(stored === result.resolutions.length
                    ? {}
                    : { errorMessage: 'resolution count disagreed with the write' }),
            },
        })
    );

    recordLegacyReconcileOutcomes({
        provider: LEGACY_MCP_PROVIDER_ID,
        byOutcome: result.metrics.byOutcome,
    });

    logger.info('legacy reconcile complete', {
        component: 'legacy-access',
        snapshotId: snapshot.id,
        executionId,
        // Counts only. Never an account key, never an employee id.
        accounts: result.metrics.accounts,
        rosterSize: result.metrics.rosterSize,
        comparisons: result.metrics.comparisons,
        resolved: stored,
        hrisProvider: freshHris.provider,
    });

    return {
        executionId,
        snapshotId: snapshot.id,
        status: 'RESOLVED',
        refusal: null,
        refusalDetail: null,
        byOutcome: result.metrics.byOutcome,
        resolved: stored,
    };
}

// ─── Readers ───────────────────────────────────────────────────────────────

/**
 * The snapshot's accounts, as the engine's canonical shape.
 *
 * Uses `toCanonical` from the verify usecase rather than a second mapping: that
 * one is already the inverse the payload hash is defined over, and a private
 * copy here would be a third place the `createdAt` / `sourceCreatedAt` rename
 * could drift.
 */
async function readAccounts(
    ctx: RequestContext,
    snapshotId: string
): Promise<readonly EngineAccount[]> {
    const rows: readonly StoredAccountRow[] = await runInTenantContext(ctx, (db) =>
        db.legacyAccount.findMany({
            where: { tenantId: ctx.tenantId, snapshotId },
            orderBy: { accountKey: 'asc' },
            select: ACCOUNT_SELECT,
        })
    );
    // Mapped to the ENGINE's shape, not through `toCanonical`. That function
    // produces 2a's storage shape, which exists because the payload hash is
    // defined over it byte for byte; the engine wants eight fields and an ISO
    // string. Two projections of the same columns, for two different jobs — the
    // SELECT is shared, the output is not.
    //
    // `sourceCreatedAt` is the legacy application's own creation date, which is
    // what the temporal veto compares against an employee's `endDate`. The row's
    // own `createdAt` is when WE stored it and would veto nothing.
    return rows.map((r) => ({
        accountKey: r.accountKey,
        displayName: r.displayName,
        email: r.email,
        employeeNumber: r.employeeNumber,
        department: r.department,
        title: r.title,
        createdAt: r.sourceCreatedAt ? r.sourceCreatedAt.toISOString() : null,
        status: r.status,
    }));
}

/**
 * The roster.
 *
 * Only `TERMINATED` maps to the engine's `'TERMINATED'`; `ONBOARDING`,
 * `OFFBOARDING` and `LEAVE` are all `'ACTIVE'`. That matches what the leaver pass
 * treats as terminated, and it is the fail-safe direction here: somebody on leave
 * is still a person who can own an account, and calling them terminated would
 * trip the temporal veto and manufacture an orphan.
 */
async function readRoster(ctx: RequestContext): Promise<readonly RosterEmployee[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.employee.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                id: true, fullName: true, givenName: true, familyName: true,
                workEmail: true, employeeNumber: true, status: true,
                startDate: true, endDate: true, department: true,
            },
        })
    );
    return rows.map((e) => ({
        id: e.id,
        fullName: e.fullName,
        givenName: e.givenName,
        familyName: e.familyName,
        workEmail: e.workEmail,
        employeeNumber: e.employeeNumber,
        status: e.status === 'TERMINATED' ? ('TERMINATED' as const) : ('ACTIVE' as const),
        startDate: e.startDate ? e.startDate.toISOString() : null,
        endDate: e.endDate ? e.endDate.toISOString() : null,
        department: e.department,
    }));
}

/**
 * The directory bridge index. READ ONLY — invariant 1.
 *
 * `linkFresh` is computed HERE and passed in, because the engine's docblock says
 * so: "Was this link fresh?" is a question about the snapshot, and the caller
 * answers it. The predicate is `findLeaverCandidates`': `lastVerifiedAt` at or
 * after `staleBefore`, `contradictedAt` null.
 *
 * Accounts with NO link are included with `linkFresh: false` and
 * `linkedEmployeeId: null`. That is not padding: the engine needs to know a login
 * exists in the directory in order to tell "this username is ambiguous across
 * connections" from "this username is unknown", and dropping the unlinked ones
 * would make every unlinked login look absent.
 */
async function readDirectory(
    ctx: RequestContext,
    staleBefore: Date
): Promise<readonly DirectoryAccount[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.connectedIdentityAccount.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                connectionId: true,
                email: true,
                samAccountName: true,
                userPrincipalName: true,
                identityLink: {
                    select: { employeeId: true, lastVerifiedAt: true, contradictedAt: true },
                },
            },
        })
    );
    return rows.map((a) => {
        const link = a.identityLink;
        const fresh =
            link !== null
            && link.contradictedAt === null
            && link.lastVerifiedAt.getTime() >= staleBefore.getTime();
        return {
            connectionId: a.connectionId,
            email: a.email,
            samAccountName: a.samAccountName,
            userPrincipalName: a.userPrincipalName,
            linkFresh: fresh,
            // Null unless the link is FRESH. A stale or contradicted link must not
            // be crossable, and leaving the id here with `linkFresh: false` would
            // leave that to whoever reads the pair correctly.
            linkedEmployeeId: fresh ? link!.employeeId : null,
        };
    });
}

/** Active aliases for this connection. READ ONLY in this step — Step 4b writes them. */
async function readAliases(
    ctx: RequestContext,
    connectionId: string
): Promise<readonly ConfirmedAlias[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.legacyIdentityAlias.findMany({
            where: { tenantId: ctx.tenantId, connectionId, status: 'ACTIVE' },
            select: { accountKey: true, employeeId: true },
        })
    );
    return rows;
}

/** The adopted username convention, if the connection has one. */
async function readConvention(
    ctx: RequestContext,
    connectionId: string
): Promise<string | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        })
    );
    const cfg = (row?.configJson ?? {}) as Record<string, unknown>;
    const stored = cfg[CONVENTION_CONFIG_KEY];
    if (!stored || typeof stored !== 'object') return null;
    const template = (stored as Record<string, unknown>).template;
    return typeof template === 'string' && template.trim() !== '' ? template : null;
}

// ─── Writers ───────────────────────────────────────────────────────────────

/**
 * One resolution → one row.
 *
 * The evidence is stored as JSON because its shape is the engine's, not the
 * database's: a signal is `{ kind, score, evidence }` and a candidate carries its
 * own signals and vetoes. Normalising that into tables would fix a shape that
 * Step 4a already extended once and 6b extends again, and the only query anybody
 * runs against it is "show me why this account resolved this way".
 */
function toResolutionRow(
    tenantId: string,
    executionId: string,
    snapshotId: string,
    r: Resolution
): Prisma.LegacyAccountResolutionCreateManyInput {
    return {
        tenantId,
        executionId,
        snapshotId,
        accountKey: r.accountKey,
        outcome: r.outcome as LegacyResolutionOutcome,
        method: r.method as LegacyMatchMethod,
        employeeId: r.employeeId,
        signalsJson: r.signals as unknown as Prisma.InputJsonValue,
        candidatesJson: r.candidates as unknown as Prisma.InputJsonValue,
        vetoesJson: r.vetoes as unknown as Prisma.InputJsonValue,
        note: r.note ?? null,
    };
}

/** Every outcome the engine can report, so a caller can zero-fill a dashboard. */
export const RECONCILE_OUTCOMES: readonly Outcome[] = [
    'LINKED', 'SUGGESTED', 'AMBIGUOUS', 'UNMATCHED', 'NON_PERSON',
];
