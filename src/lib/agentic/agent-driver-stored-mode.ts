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
 */

/**
 * The one statement this module issues. Narrow on purpose: an interactive
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
