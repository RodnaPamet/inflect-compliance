/**
 * SEND THE WRITES A HUMAN APPROVED (#2861), and refuse the ones that drifted.
 *
 * `approveAgentProposal` opens an `ExternalWriteJournal` row `PENDING` and sends
 * nothing. This pass is what sends it. The work-list is exactly "PENDING journal
 * rows", which is the sweep `@@index([tenantId, outcome])` was built for.
 *
 * ## The order is the design, again
 *
 *   1. Is the connection still permitted to be written to? No → FAILED.
 *   2. Is there still a prior-state pairing? No → FAILED.
 *   3. Re-read the prior state. Does it match what the approver saw? No → FAILED.
 *   4. Only then, send.
 *
 * Steps 1-3 send nothing, and each records WHY on the row a human can read.
 *
 * ## Why drift is a refusal and not a warning
 *
 * A human approved a specific change to a specific state — "this mailbox says
 * alice, make it bob". If the far end now says carol, the thing they approved is
 * not the thing that would happen. Sending anyway would silently convert a
 * reviewed change into an unreviewed one, which is the whole failure the
 * PROPOSE_ONLY rung exists to prevent. The refusal names the drift and the write
 * goes back to a human, which is the only party that can say whether it still
 * applies.
 *
 * The comparison is over CANONICAL JSON — keys sorted recursively — because two
 * readings of an unchanged record routinely differ in key order, and a refusal
 * that fired on key order would make the rung unusable while looking like a
 * safety feature.
 *
 * ## FAILED versus INDETERMINATE, and why it is not a detail
 *
 * `FAILED` is a POSITIVE claim that the far end changed nothing. Every refusal
 * above earns it honestly: no request was made. A send that THREW is different —
 * the request may have arrived and been applied before the connection broke — so
 * it settles `INDETERMINATE`. Collapsing the two would tell an operator filtering
 * on FAILED that nothing needs checking, about the one case that does.
 */
import { PrismaClient } from '@prisma/client';

import { logger } from '@/lib/observability/logger';
import { decryptField } from '@/lib/security/encryption';
import { callTool } from '@/app-layer/integrations/mcp/client';
import { authorizationFor } from '@/app-layer/integrations/mcp/token';
import { coerceStoredMode } from '@/lib/integrations/external-write-ladder';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { buildSystemContext } from '@/app-layer/context-system';
import { runInTenantContext } from '@/lib/db-context';

import { settleWrite } from './external-write-journal';
import { getPriorStateRead } from './external-prior-state-read';

/** Bound per pass, so one tenant's backlog cannot monopolise a worker. */
const DISPATCH_BATCH_LIMIT = 50;

export interface ExternalWriteDispatchResult {
    /** Rows this pass looked at. */
    scanned: number;
    /** Sent, and the far end accepted. */
    applied: number;
    /** Refused before sending — rung, pairing, or drift. Nothing was sent. */
    refused: number;
    /** Sent, and we do not know what happened. Needs a human. */
    indeterminate: number;
}

/**
 * Recursively key-sorted JSON, so an unchanged record compares equal whatever
 * order the far end serialised it in.
 */
function canonical(value: unknown): string {
    const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        // `Object.prototype.toString` rather than `typeof`: a Date, Map or RegExp
        // is `typeof object` with no own entries, and a walker blind to those
        // silently canonicalises them all to `{}` — which would make two
        // different timestamps compare equal.
        if (v === null || typeof v !== 'object') return v;
        if (Object.prototype.toString.call(v) !== '[object Object]') return String(v);
        const o = v as Record<string, unknown>;
        return Object.fromEntries(Object.keys(o).sort().map((k) => [k, walk(o[k])]));
    };
    return JSON.stringify(walk(value));
}

export async function runExternalWriteDispatch(input: {
    tenantId: string;
    limit?: number;
}): Promise<ExternalWriteDispatchResult> {
    // `context-system`, never `context` — the latter reaches @/lib/auth -> @/auth
    // and dies in the worker, which has no Next request to hang a session on.
    // SYSTEM rather than delegated: the human's decision is already recorded on
    // the row as `actorUserId`, written when approval opened it.
    const ctx = buildSystemContext({ tenantId: input.tenantId, job: 'external-write-dispatch' });
    const take = input.limit ?? DISPATCH_BATCH_LIMIT;

    const due = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.findMany({
            where: { tenantId: input.tenantId, outcome: 'PENDING' },
            orderBy: { attemptedAt: 'asc' },
            take,
        }),
    );

    // ONE read for every connection this batch touches, not one per row. The
    // batch is bounded at DISPATCH_BATCH_LIMIT and routinely covers the same
    // connection many times over, so the per-row `findFirst` this replaces was
    // an N+1 in the most literal sense.
    const connectionIds = [...new Set(due.map((r) => r.connectionId).filter((v): v is string => !!v))];
    const connections = new Map(
        (
            await runInTenantContext(ctx, (db) =>
                db.integrationConnection.findMany({
                    where: {
                        id: { in: connectionIds },
                        tenantId: input.tenantId,
                        provider: MCP_SERVER_PROVIDER_ID,
                    },
                    select: {
                        id: true,
                        isEnabled: true,
                        configJson: true,
                        secretEncrypted: true,
                        externalWriteMode: true,
                    },
                }),
            )
        ).map((c) => [c.id, c] as const),
    );

    const result: ExternalWriteDispatchResult = {
        scanned: due.length,
        applied: 0,
        refused: 0,
        indeterminate: 0,
    };
    if (due.length === 0) return result;

    for (const row of due) {
        const refuse = async (detail: string) => {
            await settleWrite(ctx, row.id, 'FAILED', detail);
            result.refused += 1;
            logger.warn('external write refused before sending', {
                component: 'external-write-dispatch',
                tenantId: input.tenantId,
                journalId: row.id,
                tool: row.toolName,
                reason: detail,
            });
        };

        if (!row.connectionId) {
            await refuse('The connection was deleted after this write was approved.');
            continue;
        }

        const connection = connections.get(row.connectionId);
        if (!connection || !connection.isEnabled) {
            await refuse('The connection is gone or disabled, so nothing was sent.');
            continue;
        }

        // Re-checked HERE as well as at approval. An operator can narrow the rung
        // in the window between the two, and narrowing must take effect at the
        // last possible moment rather than at the first.
        const rung = coerceStoredMode(connection.externalWriteMode);
        if (rung === 'DISABLED' || rung === 'DRY_RUN') {
            await refuse(`The connection is now at ${rung}, so the write was not sent.`);
            continue;
        }

        const url = ((connection.configJson ?? {}) as { url?: unknown }).url;
        if (typeof url !== 'string' || !url.trim()) {
            await refuse('The connection has no URL configured.');
            continue;
        }

        let authorization: string | undefined;
        try {
            const secrets = connection.secretEncrypted
                ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
                : {};
            // The SHARED resolver, so this pass and the "Test connection" button
            // agree about what a credential means. Its own docstring is explicit
            // that a second one is the shape where the button is green and the
            // runtime is broken.
            authorization = await authorizationFor(
                connection.id,
                (connection.configJson ?? {}) as Record<string, unknown>,
                secrets,
            );
        } catch {
            await refuse('The connection credentials are unusable, so nothing was sent.');
            continue;
        }
        const transport = { url: url.trim(), authorization };

        const pairing = await getPriorStateRead(ctx, row.toolName);
        if (!pairing) {
            // The pairing was cleared after approval. That is an operator
            // withdrawing the thing that makes this write accountable, and the
            // dispatch honours it rather than sending unaccountably.
            await refuse('The prior-state read pairing was removed after this was approved.');
            continue;
        }
        const read = parseExternalToolName(pairing.readToolName);
        if (!read) {
            await refuse('The paired prior-state read is not a usable external tool name.');
            continue;
        }

        const args = JSON.parse(row.argumentsJson) as Record<string, unknown>;

        let current: unknown;
        try {
            current = await callTool(transport, read.toolName, args);
        } catch {
            // The READ failed. Nothing was sent, so this is a clean FAILED —
            // decision 2 makes unreadable prior state a refusal, not a warning.
            await refuse('The prior-state read could not be run, so the write was not sent.');
            continue;
        }

        if (canonical(current) !== canonical(JSON.parse(row.priorStateJson))) {
            await refuse(
                'The record changed after this write was approved, so what a human reviewed is '
                    + 'no longer what would happen. Nothing was sent; re-propose it against the '
                    + 'current state.',
            );
            continue;
        }

        try {
            await callTool(transport, row.advertisedToolName, args);
        } catch (err) {
            // INDETERMINATE, not FAILED. The request may have arrived and been
            // applied before the connection broke, and FAILED is a positive claim
            // that the far end changed nothing — which nobody here can make.
            await settleWrite(
                ctx,
                row.id,
                'INDETERMINATE',
                `The write was sent and no answer came back: ${(err as Error).message}`,
            );
            result.indeterminate += 1;
            continue;
        }

        await settleWrite(ctx, row.id, 'APPLIED', null);
        result.applied += 1;
    }

    logger.info('external write dispatch complete', {
        component: 'external-write-dispatch',
        tenantId: input.tenantId,
        scanned: result.scanned,
        applied: result.applied,
        refused: result.refused,
        indeterminate: result.indeterminate,
    });
    return result;
}

/** Every tenant holding a PENDING external write, for the fan-out. */
export async function tenantsWithPendingExternalWrites(db: PrismaClient): Promise<string[]> {
    const rows = await db.externalWriteJournal.groupBy({
        by: ['tenantId'],
        where: { outcome: 'PENDING' },
    });
    return rows.map((r) => r.tenantId);
}
