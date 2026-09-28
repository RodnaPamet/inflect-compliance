/**
 * Which READ tells us what a WRITE is about to replace (#2861).
 *
 * Owner decision, 2026-09-28. MCP has no generic "read the thing this write will
 * change", so decision 2 — read prior state first, refuse the write if it cannot
 * be read — needs somebody to say which read corresponds to which write. An OWNER
 * nominates one of the same server's read tools; it is called with the write's own
 * arguments immediately before the write goes out, and its result becomes
 * `ExternalWriteJournal.priorStateJson`.
 *
 * A write with no pairing is REFUSED. That refusal is the deliverable, not a gap:
 * it names something an operator can fix, rather than dispatching blind.
 *
 * ## Where the authorization lives
 *
 * OWNER-only, at the ROUTE, via `requirePermission('admin.tenant_lifecycle')` —
 * the same key as the rung itself, because deciding what gets called against a
 * customer's system immediately before it is changed is authority of that class.
 * Not repeated here as an `assertCanAdmin`: a second, weaker gate inside the
 * usecase is how a route ends up looking protected while granting more than it
 * said.
 *
 * `getPriorStateRead` is the exception and deliberately ungated — it is read by
 * the DISPATCH, which runs as an agent and holds no admin permission. It returns
 * one row of tenant-scoped configuration and nothing else.
 */
import { badRequest, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';

import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { listExternalMcpTools } from './external-mcp-tools';

export interface PriorStateReadPairing {
    readonly writeToolName: string;
    readonly readToolName: string;
}

/**
 * The pairing for one write tool, or null.
 *
 * UNGATED, because the dispatch calls it as the agent. A missing row is a refusal
 * at the call site, not here — this function answers "is there a pairing", and
 * conflating that with "may this run" would put the refusal in two places.
 */
export async function getPriorStateRead(
    ctx: RequestContext,
    writeToolName: string,
): Promise<PriorStateReadPairing | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.externalToolPriorStateRead.findFirst({
            where: { tenantId: ctx.tenantId, writeToolName },
            select: { writeToolName: true, readToolName: true },
        }),
    );
    return row ?? null;
}

/** Every pairing on one connection, for the operator surface. */
export async function listPriorStateReads(
    ctx: RequestContext,
    connectionId: string,
): Promise<PriorStateReadPairing[]> {
    return runInTenantContext(ctx, (db) =>
        db.externalToolPriorStateRead.findMany({
            where: { tenantId: ctx.tenantId, writeToolName: { startsWith: `mcp__${connectionId}__` } },
            orderBy: { writeToolName: 'asc' },
            select: { writeToolName: true, readToolName: true },
        }),
    );
}

/**
 * Nominate the read that runs before a write.
 *
 * Four things are checked, and none of them is expressible as a database
 * constraint — which is why they are here rather than in the migration.
 */
export async function setPriorStateRead(
    ctx: RequestContext,
    input: PriorStateReadPairing,
): Promise<PriorStateReadPairing> {
    const write = parseExternalToolName(input.writeToolName);
    const read = parseExternalToolName(input.readToolName);

    // 1. Both must be EXTERNAL tools. A built-in has no connection and no far end,
    //    so pairing one here would configure a call that cannot be made.
    if (!write || !read) {
        throw badRequest('Both tools must be external MCP tools (mcp__<connectionId>__<tool>)');
    }

    // 2. The SAME connection. A read on a different server tells us the prior
    //    state of a different system — which is not merely useless, it is a
    //    plausible-looking record of the wrong thing, and the journal presents it
    //    as authoritative.
    if (write.connectionId !== read.connectionId) {
        throw badRequest(
            'The prior-state read must be on the same connection as the write it precedes',
        );
    }

    // 3 and 4 need what the SERVER declares, which only the catalogue has. This
    // is a network call inside a setter, and it is the right trade: the same
    // round trip the "Test connection" button makes, spent once at configuration
    // time so the dispatch never has to wonder.
    //
    // `listExternalMcpTools` carries its own `assertCanAdmin`, which is a NARROWER
    // gate than the route's `admin.tenant_lifecycle` rather than a duplicate of
    // it — an ADMIN reaching this line has already been refused upstream.
    const catalogue = await listExternalMcpTools(ctx, write.connectionId);
    const byName = new Map(catalogue.tools.map((t) => [t.toolName, t]));
    const writeTool = byName.get(input.writeToolName);
    const readTool = byName.get(input.readToolName);

    if (!writeTool || !readTool) {
        throw notFound('The server does not advertise both of those tools');
    }

    // 3. The write must actually be a write. Pairing a prior-state read to a tool
    //    that never writes is harmless at dispatch and misleading on the surface:
    //    it implies a governed write path where there is none.
    if (!writeTool.declaresWrite) {
        throw badRequest(
            `"${writeTool.advertisedName}" is declared read-only, so it has no prior state to capture`,
        );
    }

    // 4. The read must actually be a read. This is the one that matters: pairing
    //    a WRITE as the prior-state read would send TWO writes per dispatch, the
    //    first of them unjournalled and unasked-for.
    if (readTool.declaresWrite) {
        throw badRequest(
            `"${readTool.advertisedName}" is not declared read-only. The prior-state read runs `
                + 'before every write to this tool, so nominating something that writes would send '
                + 'two changes per call — the first of them unrecorded.',
        );
    }

    await runInTenantContext(ctx, async (db) => {
        await db.externalToolPriorStateRead.upsert({
            where: {
                tenantId_writeToolName: {
                    tenantId: ctx.tenantId,
                    writeToolName: input.writeToolName,
                },
            },
            create: {
                tenantId: ctx.tenantId,
                writeToolName: input.writeToolName,
                readToolName: input.readToolName,
                approvedByUserId: ctx.userId ?? null,
            },
            update: { readToolName: input.readToolName, approvedByUserId: ctx.userId ?? null },
        });
        await logEvent(db, ctx, {
            action: 'EXTERNAL_PRIOR_STATE_READ_SET',
            entityType: 'IntegrationConnection',
            entityId: write.connectionId,
            details: `Prior-state read for "${writeTool.advertisedName}": ${readTool.advertisedName}`,
            detailsJson: {
                // `access`, not `configuration`: this decides what is called
                // against a customer's system immediately before it is changed.
                category: 'access',
                operation: 'grant',
                summary: `Prior-state read set for ${writeTool.advertisedName}`,
            },
            metadata: { writeToolName: input.writeToolName, readToolName: input.readToolName },
        });
    });

    logger.info('external prior-state read set', {
        component: 'external-prior-state-read',
        tenantId: ctx.tenantId,
        connectionId: write.connectionId,
        writeTool: writeTool.advertisedName,
        readTool: readTool.advertisedName,
    });

    return { writeToolName: input.writeToolName, readToolName: input.readToolName };
}

/**
 * Remove a pairing.
 *
 * Which makes the write undispatchable again — a narrowing, so it is never gated
 * on anything the setter has to satisfy. An operator withdrawing an authority
 * must not be told to wait or to prove something first.
 */
export async function clearPriorStateRead(ctx: RequestContext, writeToolName: string): Promise<void> {
    const res = await runInTenantContext(ctx, (db) =>
        db.externalToolPriorStateRead.deleteMany({ where: { tenantId: ctx.tenantId, writeToolName } }),
    );
    if (res.count === 0) {
        // Counted, not assumed: an RLS-filtered delete removes zero rows and
        // SUCCEEDS, so a caller that trusted the call would believe it had
        // withdrawn something that is still there.
        logger.warn('external prior-state read: nothing to clear', {
            component: 'external-prior-state-read',
            tenantId: ctx.tenantId,
            writeToolName,
        });
    }
}
