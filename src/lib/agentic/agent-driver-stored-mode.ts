/**
 * THE STORED ENGINE, READ AS TEXT (#4224).
 *
 * `TenantSecuritySettings.agentDriver` is the Prisma enum `AgentDriverMode`,
 * and `coerceStoredDriverMode` exists to turn a value THIS BUILD DOES NOT
 * RECOGNISE into `STATIC` with the reason `UNRECOGNISED_SETTING`. Read through
 * the generated client, that coercer never gets the chance: a Prisma client
 * meeting an enum value it was not generated with fails the whole read, before
 * any of our logic sees the byte. CLAUDE.md records the same behaviour for
 * `AccessReviewScope`, which is why that value shipped in two deploys.
 *
 * So the column is read as TEXT here, through one function both the settings
 * usecase and the run path call. `::text` makes the cast the database's job,
 * every stored byte reaches `coerceStoredDriverMode`, and `UNRECOGNISED_SETTING`
 * becomes reachable instead of being dead code behind a 500.
 *
 * ## When a value this build does not know can exist
 *
 * Only across a ROLLBACK: a later image ships a third mode, writes it, and
 * production is redeployed from an image built before it. The two-deploy rule
 * the roadmap uses prevents it on the way forward; `docs/change-management-policy.md`
 * makes "redeploy the prior image" the ordinary rollback, which is exactly when
 * an owner most needs to narrow the engine.
 *
 * ## Why a client PARAMETER rather than importing prisma
 *
 * The two callers reach the database differently and both must use this one
 * reader or they can disagree about the same stored byte. The settings usecase
 * is inside `runInTenantContext`, so its `db` carries the RLS tenant binding;
 * the run path reads the global client with a tenant id. Taking the client as an
 * argument serves both and keeps `no-direct-prisma` satisfied for the usecase,
 * which may not import the global client.
 *
 * NOT in `agent-driver.ts`, where `coerceStoredDriverMode` lives: that module is
 * imported by `AgentEnginesSection.tsx`, a `'use client'` component. A database
 * reader there would be one refactor away from the browser bundle.
 *
 * ## The enum's second column: `WorkflowRun.driver` (#4241)
 *
 * The same enum records which engine walked each run, and the same rollback
 * poisons it — worse, because a run row is usually read WHOLE. Prisma returns
 * every scalar when a read names no `select`, so a single run stamped with a
 * value this build does not know failed the run store, the run list, the run
 * page, and every `update` that returns the row (which is every `update` that
 * names no `select`, including the one that settles a run FAILED).
 *
 * A text read is the wrong instrument for a row read whole, so the column is
 * kept out of the typed client's results instead: every whole-row read and
 * every record-returning write of `workflowRun` carries `omit: { driver: true }`
 * (`local/no-typed-run-driver-read` holds that), and the readers that need the
 * engine ask {@link readRecordedRunDrivers} for it, as text, coerced by
 * `coerceRecordedRunDriver` — to `UNRECOGNISED`, never to a real engine, for
 * the reason that function's docblock gives.
 */

import { Prisma } from '@prisma/client';

import {
    coerceRecordedRunDriver,
    RUN_DRIVER_UNRECOGNISED,
    type RecordedRunDriver,
} from '@/lib/agentic/agent-driver';

/**
 * The one client method this module calls. Narrow on purpose: an interactive
 * transaction client and the global client both satisfy it.
 */
export interface StoredDriverModeClient {
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * The tenant's stored engine as the bytes the column holds, or `null` when
 * there is no settings row or the column is NULL.
 *
 * Returns a plain `string`, deliberately NOT `AgentDriverMode`: the whole point
 * is that the value may be one this build's union does not contain, and typing
 * it as the union here would hand every caller a lie that `coerceStoredDriverMode`
 * is then asked to fix.
 */
export async function readStoredDriverMode(
    db: StoredDriverModeClient,
    tenantId: string,
): Promise<string | null> {
    // Parameterised, and `::text` rather than a client-side cast — the point is
    // that the client never has to name the value.
    const rows = await db.$queryRaw<Array<{ agentDriver: string | null }>>`
        SELECT "agentDriver"::text AS "agentDriver"
          FROM "TenantSecuritySettings"
         WHERE "tenantId" = ${tenantId}
         LIMIT 1`;

    return rows[0]?.agentDriver ?? null;
}

/**
 * The recorded engine of each named run, READ AS TEXT and coerced (#4241).
 *
 * Returns a lookup rather than a map so a caller cannot forget the absent case:
 * a run the read did not return — deleted between two statements, or never this
 * tenant's — reads `UNRECOGNISED` too, because an engine this build never saw
 * is not one it can name.
 *
 * ONE statement however many runs, so a list pays one round trip rather than
 * one per row; and none at all for an empty list, which `Prisma.join` would
 * refuse anyway. Tenant-filtered in the WHERE as well as by the RLS binding the
 * caller's `db` carries, the same belt and braces every repository read wears.
 */
export async function readRecordedRunDrivers(
    db: StoredDriverModeClient,
    tenantId: string,
    runIds: readonly string[],
): Promise<(runId: string) => RecordedRunDriver> {
    const ids = [...new Set(runIds)];
    if (ids.length === 0) return () => RUN_DRIVER_UNRECOGNISED;

    const rows = await db.$queryRaw<Array<{ id: string; driver: string | null }>>`
        SELECT "id", "driver"::text AS "driver"
          FROM "WorkflowRun"
         WHERE "tenantId" = ${tenantId}
           AND "id" IN (${Prisma.join(ids)})`;

    const byId = new Map(rows.map((r) => [r.id, coerceRecordedRunDriver(r.driver)] as const));
    return (runId) => byId.get(runId) ?? RUN_DRIVER_UNRECOGNISED;
}

/** {@link readRecordedRunDrivers} for one run. */
export async function readRecordedRunDriver(
    db: StoredDriverModeClient,
    tenantId: string,
    runId: string,
): Promise<RecordedRunDriver> {
    return (await readRecordedRunDrivers(db, tenantId, [runId]))(runId);
}
