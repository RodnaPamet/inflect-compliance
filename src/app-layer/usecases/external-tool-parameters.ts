/**
 * A tenant's SAVED ARGUMENTS for an external tool — and the approval that has
 * to happen before a changed one takes effect.
 *
 * ## The line this file is on the safe side of
 *
 * The agentic spine is `effective = min(key.maxAutonomyLevel,
 * agent.autonomyLevel, tierCap)`, with NO TERM CAN WIDEN stated in six files. A
 * tenant-authored ACTION would be a configuration term that widens, which the
 * model forbids. A tenant-authored ARGUMENT is not one: the grant decides what
 * the agent may call, the server's PINNED schema decides what shape the call
 * may take, and a set here only decides what is asked within that. Nothing in
 * this file can make an agent able to do something it was not granted.
 *
 * ## Why an edit does not take effect when it is saved
 *
 * Editing requires the same authority that granted the tool, and a changed set
 * waits for a human. That is not ceremony: a query string reaching an external
 * system IS the substance of what the agent does, so a silent edit would
 * re-point a live agent with no reviewed moment. The `pending*` columns hold
 * the proposal while the agent keeps dispatching what was approved.
 *
 * `expectedPendingHash` is required on approval for the reason
 * `approveToolManifest` requires its own: an endpoint that took only an id
 * would approve WHATEVER the row says when the request lands, including an edit
 * that changed between the operator reading it and clicking.
 *
 * ## The fine-grained key lives at the ROUTE
 *
 * These usecases assert `assertCanRead` / `assertCanWrite`, exactly as
 * `agent-policy-card.ts` does, and `route-permissions.ts` maps the path to
 * `admin.agent_tool_exposure` — the same key that gates granting the tool,
 * which is what "the same authority" means here.
 */
import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { isExternalToolName } from '@/lib/mcp/external-tool-name';

import { logEvent } from '../events/audit';
import { assertCanRead, assertCanWrite } from '../policies/common';
import type { RequestContext } from '../types';

/**
 * SHA-256 over the parameters, round-tripped through `JSON.stringify` BEFORE
 * canonicalisation.
 *
 * The round trip is not belt-and-braces, and the argument is `hashToolManifest`'s
 * verbatim: `canonicalJson` walks `Object.keys` while `JSON.stringify` honours
 * `toJSON`. A parameter object carrying a `toJSON` would therefore hash as one
 * thing and go OUT ON THE WIRE as another — an approved query that dispatches
 * something else, with a matching hash. Round-tripping first makes the hashed
 * bytes the dispatched bytes by construction.
 */
export function hashParameters(parameters: unknown): string {
    return createHash('sha256')
        .update(canonicalJson(JSON.parse(JSON.stringify(parameters ?? null))), 'utf8')
        .digest('hex');
}

const ParametersSchema = z.record(z.string(), z.unknown());

export const SaveParameterSetSchema = z
    .object({
        toolName: z.string().min(1).max(200),
        label: z.string().min(1).max(120).trim(),
        parameters: ParametersSchema,
    })
    .strict();

export const ProposeParameterChangeSchema = z
    .object({ id: z.string().min(1), parameters: ParametersSchema })
    .strict();

export const ApproveParameterChangeSchema = z
    .object({ id: z.string().min(1), expectedPendingHash: z.string().min(1) })
    .strict();

export interface ParameterSetState {
    id: string;
    toolName: string;
    label: string;
    parameters: unknown;
    parametersHash: string;
    revision: number;
    approvalSource: string;
    approvedByUserId: string | null;
    approvedAt: Date;
    /** The edit waiting for a human, or `null`. NOT in force. */
    pending: {
        parameters: unknown;
        hash: string;
        byUserId: string;
        at: Date;
    } | null;
}

const SELECT = {
    id: true,
    toolName: true,
    label: true,
    parameters: true,
    parametersHash: true,
    revision: true,
    approvalSource: true,
    approvedByUserId: true,
    approvedAt: true,
    pendingParameters: true,
    pendingHash: true,
    pendingByUserId: true,
    pendingAt: true,
} as const;

type Row = {
    id: string;
    toolName: string;
    label: string;
    parameters: unknown;
    parametersHash: string;
    revision: number;
    approvalSource: string;
    approvedByUserId: string | null;
    approvedAt: Date;
    pendingParameters: unknown;
    pendingHash: string | null;
    pendingByUserId: string | null;
    pendingAt: Date | null;
};

function toState(row: Row): ParameterSetState {
    return {
        id: row.id,
        toolName: row.toolName,
        label: row.label,
        parameters: row.parameters,
        parametersHash: row.parametersHash,
        revision: row.revision,
        approvalSource: row.approvalSource,
        approvedByUserId: row.approvedByUserId,
        approvedAt: row.approvedAt,
        // The four pending columns move together — the database enforces it
        // (`ExternalToolParameterSet_pending_is_whole`) — so one non-null is
        // enough to read the set, and a half-written proposal cannot reach here.
        pending:
            row.pendingHash !== null
                ? {
                      parameters: row.pendingParameters,
                      hash: row.pendingHash,
                      byUserId: row.pendingByUserId as string,
                      at: row.pendingAt as Date,
                  }
                : null,
    };
}

/** Every saved set for this tenant, newest label order, optionally one tool's. */
export async function listParameterSets(
    ctx: RequestContext,
    toolName?: string,
): Promise<ParameterSetState[]> {
    assertCanRead(ctx);
    const rows = await runInTenantContext(ctx, (db) =>
        db.externalToolParameterSet.findMany({
            where: { tenantId: ctx.tenantId, ...(toolName ? { toolName } : {}) },
            orderBy: [{ toolName: 'asc' }, { label: 'asc' }],
            take: 500,
            select: SELECT,
        }),
    );
    return rows.map((r) => toState(r as Row));
}

/**
 * Save a set for the first time — the BASELINE, trust-on-first-use.
 *
 * No approver, by construction: there is no previous wording for a human to
 * have compared it against, which is the same reason `McpToolManifestPin`'s
 * first row carries none. The database enforces that a `BASELINE` row names no
 * approver and displaced nothing.
 */
export async function saveParameterSet(
    ctx: RequestContext,
    input: unknown,
): Promise<ParameterSetState> {
    assertCanWrite(ctx);
    const parsed = SaveParameterSetSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest('Invalid parameter set', parsed.error.flatten());
    }
    const { toolName, label, parameters } = parsed.data;

    // Parameters are for EXTERNAL tools. A built-in tool's arguments come from
    // the model against a schema this build owns; there is nothing for a tenant
    // to save, and allowing it would create a second, unpinned way to influence
    // an internal call.
    if (!isExternalToolName(toolName)) {
        throw badRequest(
            `"${toolName}" is not an external tool. Saved parameters apply only to ` +
                'tools served by an external MCP server.',
        );
    }

    const parametersHash = hashParameters(parameters);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.externalToolParameterSet.findUnique({
            where: { tenantId_toolName_label: { tenantId: ctx.tenantId, toolName, label } },
            select: { id: true },
        });
        if (existing) {
            throw badRequest(
                `A parameter set labelled "${label}" already exists for this tool. ` +
                    'Propose a change to it rather than saving a second one.',
            );
        }

        const row = await db.externalToolParameterSet.create({
            data: {
                tenantId: ctx.tenantId,
                toolName,
                label,
                parameters: parameters as object,
                parametersHash,
                approvalSource: 'BASELINE',
                revision: 1,
            },
            select: SELECT,
        });

        await logEvent(db, ctx, {
            entityType: 'ExternalToolParameterSet',
            entityId: row.id,
            action: 'EXTERNAL_TOOL_PARAMETERS_SAVED',
            details: `Baseline parameter set "${label}" saved for ${toolName}`,
            detailsJson: {
                category: 'custom',
                event: 'external_tool_parameters_saved',
                tool: toolName,
                label,
                // The DIGEST, never the values. A saved query can name hosts,
                // dashboards and filters a tenant considers sensitive, and the
                // audit trail streams to a SIEM.
                parametersHash,
                revision: 1,
            },
        });
        return toState(row as Row);
    });
}

/** Propose a change. Saved as PENDING; the agent keeps running what is approved. */
export async function proposeParameterChange(
    ctx: RequestContext,
    input: unknown,
): Promise<ParameterSetState> {
    assertCanWrite(ctx);
    const parsed = ProposeParameterChangeSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest('Invalid parameter change', parsed.error.flatten());
    }
    if (!ctx.userId) throw badRequest('A proposing user is required');

    const { id, parameters } = parsed.data;
    const pendingHash = hashParameters(parameters);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.externalToolParameterSet.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { id: true, toolName: true, label: true, parametersHash: true },
        });
        if (!existing) throw notFound('Parameter set not found');

        if (existing.parametersHash === pendingHash) {
            throw badRequest('These parameters are already in force; there is nothing to approve.');
        }

        const row = await db.externalToolParameterSet.update({
            where: { id },
            data: {
                pendingParameters: parameters as object,
                pendingHash,
                pendingByUserId: ctx.userId as string,
                pendingAt: new Date(),
            },
            select: SELECT,
        });

        await logEvent(db, ctx, {
            entityType: 'ExternalToolParameterSet',
            entityId: id,
            action: 'EXTERNAL_TOOL_PARAMETERS_PROPOSED',
            details: `Change proposed to parameter set "${existing.label}"`,
            detailsJson: {
                category: 'custom',
                event: 'external_tool_parameters_proposed',
                tool: existing.toolName,
                label: existing.label,
                pendingHash,
                proposedByUserId: ctx.userId,
            },
        });
        return toState(row as Row);
    });
}

/**
 * Accept a pending change. The approver names the hash they reviewed.
 *
 * On acceptance the pending values become the ones in force, the revision
 * advances, and the displaced digest is kept so an incident review can tell
 * what was replaced without reconstructing it from the trail.
 */
export async function approveParameterChange(
    ctx: RequestContext,
    input: unknown,
): Promise<ParameterSetState> {
    assertCanWrite(ctx);
    const parsed = ApproveParameterChangeSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest('Invalid parameter approval', parsed.error.flatten());
    }
    if (!ctx.userId) throw badRequest('An approving user is required');

    const { id, expectedPendingHash } = parsed.data;

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.externalToolParameterSet.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: {
                id: true,
                toolName: true,
                label: true,
                parametersHash: true,
                revision: true,
                pendingParameters: true,
                pendingHash: true,
            },
        });
        if (!existing) throw notFound('Parameter set not found');
        if (!existing.pendingHash) {
            throw badRequest('There is no pending change on this parameter set.');
        }
        if (existing.pendingHash !== expectedPendingHash) {
            throw badRequest(
                'The proposed parameters changed since they were reviewed. Re-read the ' +
                    'pending change and approve that hash.',
            );
        }

        const revision = existing.revision + 1;
        const row = await db.externalToolParameterSet.update({
            where: { id },
            data: {
                parameters: existing.pendingParameters as object,
                parametersHash: existing.pendingHash,
                previousHash: existing.parametersHash,
                revision,
                approvalSource: 'APPROVED',
                approvedByUserId: ctx.userId as string,
                approvedAt: new Date(),
                // `Prisma.DbNull`, not `undefined` and not `JsonNull`. On a
                // nullable Json column `undefined` means "leave it alone", so
                // the superseded proposal would SURVIVE its own approval — and
                // the row would then violate `pending_is_whole`, since the hash
                // beside it is being nulled. `JsonNull` is wrong in the other
                // direction: it stores a JSON `null` AS the pending value,
                // which reads back as a proposal whose content is null.
                pendingParameters: Prisma.DbNull,
                pendingHash: null,
                pendingByUserId: null,
                pendingAt: null,
            },
            select: SELECT,
        });

        await logEvent(db, ctx, {
            entityType: 'ExternalToolParameterSet',
            entityId: id,
            action: 'EXTERNAL_TOOL_PARAMETERS_APPROVED',
            details: `Parameter set "${existing.label}" approved at revision ${revision}`,
            detailsJson: {
                category: 'custom',
                event: 'external_tool_parameters_approved',
                tool: existing.toolName,
                label: existing.label,
                parametersHash: existing.pendingHash,
                previousHash: existing.parametersHash,
                revision,
                approvedByUserId: ctx.userId,
            },
        });
        return toState(row as Row);
    });
}
