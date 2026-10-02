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
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import {
    OpenFieldsSchema,
    refusalForOpenFields,
    type OpenFields,
} from '@/lib/integrations/open-fields';
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

/**
 * The digest of a TEMPLATE — the exact values AND the bounds on the open ones.
 *
 * Why the open fields have to be inside it: `expectedPendingHash` exists so an
 * approver accepts what they reviewed rather than whatever the row says when
 * the request lands. With the constraints outside the digest, an edit that
 * changed only a pattern would hash identically to the one in force — so
 * `proposeParameterChange` would reject it as "already in force", and an edit
 * that changed a value AND a pattern could have its pattern swapped between the
 * review and the click with the hash still matching. Both are the failure the
 * hash exists to prevent.
 *
 * A template with NO open fields hashes to EXACTLY what `hashParameters`
 * produced before #3051, byte for byte, so every row written before this change
 * still matches its stored `parametersHash`. No backfill, and the "already in
 * force" check keeps working on legacy rows.
 *
 * The domain tag is a PREFIX rather than a wrapper key, because any wrapper key
 * is a key a tool could genuinely advertise: hashing `{parameters, openFields}`
 * as an object would let an exact-value set whose arguments happen to be named
 * `parameters` and `openFields` collide with a template. A prefix cannot be
 * forged from inside the JSON.
 */
export function hashParameterSet(parameters: unknown, openFields: unknown): string {
    if (openFields === null || openFields === undefined) return hashParameters(parameters);
    return createHash('sha256')
        .update('external-tool-parameter-template:v1\n', 'utf8')
        .update(
            canonicalJson(
                JSON.parse(JSON.stringify({ openFields, parameters: parameters ?? null })),
            ),
            'utf8',
        )
        .digest('hex');
}

const ParametersSchema = z.record(z.string(), z.unknown());

/**
 * `openFields` is accepted as `unknown` here and refused with its own message
 * below, rather than typed into the schema.
 *
 * `.strict()` would already reject the key — with "Unrecognized key", which
 * tells an operator nothing about WHY a template may not be created in one
 * step. The refusal is the interesting part of this endpoint's contract, so it
 * gets a sentence instead of a parser artefact.
 */
export const SaveParameterSetSchema = z
    .object({
        toolName: z.string().min(1).max(200),
        label: z.string().min(1).max(120).trim(),
        parameters: ParametersSchema,
        openFields: z.unknown().optional(),
    })
    .strict();

export const ProposeParameterChangeSchema = z
    .object({
        id: z.string().min(1),
        parameters: ParametersSchema,
        /**
         * The open fields the template should have AFTER this edit — the whole
         * intended state, never a delta.
         *
         * OMITTED means "leave them as they are", and that default is chosen
         * rather than inherited. The promotion trigger requires the open fields
         * coming into force to be exactly what was pending, so a propose path
         * that treated an absent key as "none" would silently strip a
         * template's bounds whenever somebody edited only its exact values —
         * a widening-shaped diff produced by a caller who touched nothing of
         * the kind. An explicit `null` removes them.
         */
        openFields: z.unknown().optional(),
    })
    .strict();

export const ApproveParameterChangeSchema = z
    .object({ id: z.string().min(1), expectedPendingHash: z.string().min(1) })
    .strict();

/**
 * Signing is its OWN act, separate from approving.
 *
 * It takes the same `expectedPendingHash` as the approval for the same reason,
 * and the database takes it further: the signature row STORES the hash it was
 * against, and the promotion counts only signatures whose hash matches what is
 * pending now. Otherwise one human signs, the proposer replaces the pending
 * edit, a second human signs, and content only one person ever read commits
 * with two signatures behind it.
 */
export const SignParameterChangeSchema = z
    .object({ id: z.string().min(1), expectedPendingHash: z.string().min(1) })
    .strict();

/** One human's signature on one pending template edit. */
export interface ParameterSetSignature {
    approverUserId: string;
    /** The revision the pending edit will become. */
    revision: number;
    /** The digest this signature is against — stale ones do not count. */
    pendingHash: string;
    requiredApprovals: number;
    createdAt: Date;
}

export interface ParameterSetState {
    id: string;
    toolName: string;
    label: string;
    parameters: unknown;
    parametersHash: string;
    /**
     * The bounds on the fields the agent may choose, or `null` for an
     * exact-value set — which is a template with zero open fields.
     */
    openFields: unknown;
    revision: number;
    approvalSource: string;
    approvedByUserId: string | null;
    approvedAt: Date;
    /** The edit waiting for a human, or `null`. NOT in force. */
    pending: {
        parameters: unknown;
        openFields: unknown;
        hash: string;
        byUserId: string;
        at: Date;
        /**
         * How many signatures from humans OTHER than the proposer the
         * promotion will require. Computed the way the trigger computes it, and
         * reported so an operator can see the gate before they hit it — the
         * database remains the only thing that enforces it.
         */
        requiredApprovals: number;
    } | null;
    /**
     * Signatures on file for the PENDING edit, newest last. Only those naming
     * the pending digest are listed: a signature against replaced content is
     * not evidence about what is in front of the next approver.
     */
    signatures: ParameterSetSignature[];
}

const SELECT = {
    id: true,
    toolName: true,
    label: true,
    parameters: true,
    parametersHash: true,
    openFields: true,
    revision: true,
    approvalSource: true,
    approvedByUserId: true,
    approvedAt: true,
    pendingParameters: true,
    pendingOpenFields: true,
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
    openFields: unknown;
    revision: number;
    approvalSource: string;
    approvedByUserId: string | null;
    approvedAt: Date;
    pendingParameters: unknown;
    pendingOpenFields: unknown;
    pendingHash: string | null;
    pendingByUserId: string | null;
    pendingAt: Date | null;
};

/**
 * How many independent signatures a promotion of this row needs.
 *
 * EITHER side having open fields makes it two. Reading it as the in-force side
 * alone would let one approver turn an exact-value set INTO a template, which
 * is the transition the whole gate exists for.
 *
 * This is a REPORT of the rule, not the rule. The same expression lives in the
 * promotion trigger, over the same two columns, and that is the one that
 * decides — because a count this layer performs and then acts on is a
 * read-then-write with a window in it.
 */
export function requiredApprovalsFor(row: {
    openFields: unknown;
    pendingOpenFields: unknown;
}): number {
    return row.openFields !== null || row.pendingOpenFields !== null ? 2 : 1;
}

function toState(row: Row, signatures: ParameterSetSignature[] = []): ParameterSetState {
    return {
        id: row.id,
        toolName: row.toolName,
        label: row.label,
        parameters: row.parameters,
        parametersHash: row.parametersHash,
        openFields: row.openFields ?? null,
        revision: row.revision,
        approvalSource: row.approvalSource,
        approvedByUserId: row.approvedByUserId,
        approvedAt: row.approvedAt,
        // The four pending columns move together — the database enforces it
        // (`ExternalToolParameterSet_pending_is_whole`) — so one non-null is
        // enough to read the set, and a half-written proposal cannot reach here.
        // `pendingOpenFields` is deliberately NOT part of that quartet: null
        // beside a real proposal means "and zero open fields afterwards".
        pending:
            row.pendingHash !== null
                ? {
                      parameters: row.pendingParameters,
                      openFields: row.pendingOpenFields ?? null,
                      hash: row.pendingHash,
                      byUserId: row.pendingByUserId as string,
                      at: row.pendingAt as Date,
                      requiredApprovals: requiredApprovalsFor(row),
                  }
                : null,
        signatures,
    };
}

/** Upper bound on signature rows read for one listing. */
const SIGNATURE_READ_LIMIT = 500;

/**
 * Every saved set for this tenant, newest label order, optionally one tool's.
 *
 * The signatures come back with the sets, in a SECOND query rather than a
 * nested include, because an operator deciding whether to approve a template
 * edit has to be able to see who has already signed it — without that, the only
 * way to learn that the gate is not satisfied is to press approve and read a
 * database error. Only signatures naming the CURRENT pending digest are
 * reported: one against replaced content tells the next approver nothing true.
 */
export async function listParameterSets(
    ctx: RequestContext,
    toolName?: string,
): Promise<ParameterSetState[]> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.externalToolParameterSet.findMany({
            where: { tenantId: ctx.tenantId, ...(toolName ? { toolName } : {}) },
            orderBy: [{ toolName: 'asc' }, { label: 'asc' }],
            take: 500,
            select: SELECT,
        });

        const pendingIds = rows.filter((r) => r.pendingHash !== null).map((r) => r.id);
        const signatures = pendingIds.length
            ? await db.externalToolParameterSetApproval.findMany({
                  where: { tenantId: ctx.tenantId, parameterSetId: { in: pendingIds } },
                  orderBy: { createdAt: 'asc' },
                  take: SIGNATURE_READ_LIMIT,
                  select: {
                      parameterSetId: true,
                      approverUserId: true,
                      revision: true,
                      pendingHash: true,
                      requiredApprovals: true,
                      createdAt: true,
                  },
              })
            : [];

        const bySet = new Map<string, ParameterSetSignature[]>();
        for (const s of signatures) {
            const list = bySet.get(s.parameterSetId) ?? [];
            list.push({
                approverUserId: s.approverUserId,
                revision: s.revision,
                pendingHash: s.pendingHash,
                requiredApprovals: s.requiredApprovals,
                createdAt: s.createdAt,
            });
            bySet.set(s.parameterSetId, list);
        }

        return rows.map((r) => {
            const row = r as Row;
            const live = (bySet.get(row.id) ?? []).filter(
                (s) => s.pendingHash === row.pendingHash && s.revision === row.revision + 1,
            );
            return toState(row, live);
        });
    });
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

    // ── A BASELINE MAY NOT BE A TEMPLATE ────────────────────────────────────
    //
    // A first save is trust-on-first-use: no approver, nothing it displaced,
    // nothing for a human to have compared it against. Exact values written
    // that way are safe because a person typed the bytes that will be sent. A
    // PREDICATE written that way is the one thing step 5b exists to prevent —
    // the predicate review is the only gate on an open field, and a baseline
    // has no reviewed moment to hold it.
    //
    // Allowing it would also make the four-eyes requirement optional: delete
    // the set, save it again with the bounds you wanted, done. So a template is
    // reachable only through propose → signatures → approve.
    //
    // The same refusal is in the database (`..._NOT_ON_BASELINE` on INSERT), so
    // this is the message rather than the control.
    if (parsed.data.openFields !== undefined && parsed.data.openFields !== null) {
        throw badRequest(
            'A new parameter set cannot be saved with open fields. A first save is ' +
                'trust-on-first-use — no approver, and nothing for anybody to have compared ' +
                'it against — so a bounded template created that way is a predicate nobody ' +
                'reviewed. Save the exact values, then propose the open fields; promoting ' +
                'them needs two approvers who did not propose them.',
        );
    }

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

/**
 * Propose a change. Saved as PENDING; the agent keeps running what is approved.
 *
 * An edit that touches the OPEN FIELDS — adding them, changing a bound, or
 * removing them — needs two approving signatures from humans other than the
 * proposer before it can be promoted. So does an edit to the exact values of a
 * row that already has open fields. The database decides that, not this
 * function; `pending.requiredApprovals` in the returned state reports it.
 */
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

    // Read the KEY from the raw input rather than the parsed object: absent and
    // explicitly-null mean different things here (carry forward vs remove), and
    // `z.unknown().optional()` collapses them once parsed.
    const openFieldsGiven =
        typeof input === 'object' && input !== null && 'openFields' in input;

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.externalToolParameterSet.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: {
                id: true,
                toolName: true,
                label: true,
                parametersHash: true,
                openFields: true,
            },
        });
        if (!existing) throw notFound('Parameter set not found');

        // The full intended state after this edit. Omitting the key carries the
        // row's current bounds forward — see the schema for why that is the
        // safe default.
        const openFields: unknown = openFieldsGiven
            ? (parsed.data.openFields ?? null)
            : (existing.openFields ?? null);

        if (openFields !== null) {
            const shape = OpenFieldsSchema.safeParse(openFields);
            if (!shape.success) {
                throw badRequest('Invalid open fields', shape.error.flatten());
            }
            // `refusalForConstraint`, per field, through the shared composer —
            // and with the approved exact values beside it, so a field opened
            // under the name of an approved value is refused rather than
            // silently overriding it at dispatch.
            const refusal = refusalForOpenFields(
                shape.data as OpenFields,
                Object.keys(parameters),
            );
            if (refusal) throw badRequest(`${refusal.code}: ${refusal.detail}`);
        }

        const pendingHash = hashParameterSet(parameters, openFields);

        if (existing.parametersHash === pendingHash) {
            throw badRequest(
                'These parameters and bounds are already in force; there is nothing to approve.',
            );
        }

        const row = await db.externalToolParameterSet.update({
            where: { id },
            data: {
                pendingParameters: parameters as object,
                // `Prisma.DbNull` rather than `null`/`undefined` for the same
                // reason the approval path uses it: `undefined` means "leave it
                // alone" on a nullable Json column, so proposing the removal of
                // a template's bounds would leave them pending.
                pendingOpenFields:
                    openFields === null ? Prisma.DbNull : (openFields as object),
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
                // The FIELD NAMES and nothing about the bounds. A name is what
                // an incident reviewer needs to know was opened; a pattern can
                // name hosts and filters a tenant considers sensitive, and the
                // audit trail streams to a SIEM.
                openFieldNames:
                    openFields === null
                        ? []
                        : Object.keys(openFields as Record<string, unknown>).sort(),
                requiredApprovals: requiredApprovalsFor({
                    openFields: existing.openFields ?? null,
                    pendingOpenFields: openFields,
                }),
            },
        });
        return toState(row as Row);
    });
}

/**
 * Record ONE human's signature on the pending edit.
 *
 * This is not the approval. It says "I have read this edit and I accept it";
 * promotion is a separate act, and the database refuses it until the signatures
 * are there. Keeping them separate is what makes two reviewers possible at all:
 * a single endpoint that signed-and-promoted would make the first caller the
 * last one.
 *
 * Every refusal below is ALSO a database refusal. These are the messages, not
 * the controls — see the migration's trigger for the reasoning, and
 * `fourEyesRefusal` for what is mapped back from it.
 */
export async function signParameterChange(
    ctx: RequestContext,
    input: unknown,
): Promise<ParameterSetState> {
    assertCanWrite(ctx);
    const parsed = SignParameterChangeSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest('Invalid parameter approval signature', parsed.error.flatten());
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
                revision: true,
                openFields: true,
                pendingOpenFields: true,
                pendingHash: true,
                pendingByUserId: true,
            },
        });
        if (!existing) throw notFound('Parameter set not found');
        if (!existing.pendingHash) {
            throw badRequest('There is no pending change on this parameter set to approve.');
        }
        if (existing.pendingHash !== expectedPendingHash) {
            throw badRequest(
                'The proposed parameters changed since they were reviewed. Re-read the ' +
                    'pending change and approve that hash.',
            );
        }

        const requiredApprovals = requiredApprovalsFor({
            openFields: existing.openFields ?? null,
            pendingOpenFields: existing.pendingOpenFields ?? null,
        });

        try {
            await db.externalToolParameterSetApproval.create({
                data: {
                    tenantId: ctx.tenantId,
                    parameterSetId: id,
                    approverUserId: ctx.userId as string,
                    revision: existing.revision + 1,
                    pendingHash: existing.pendingHash,
                    requiredApprovals,
                },
                select: { id: true },
            });
        } catch (err) {
            const refusal = fourEyesRefusal(err);
            if (!refusal) throw err;
            throw badRequest(refusal);
        }

        await logEvent(db, ctx, {
            entityType: 'ExternalToolParameterSet',
            entityId: id,
            action: 'EXTERNAL_TOOL_PARAMETERS_SIGNED',
            details: `Parameter set "${existing.label}" edit signed for revision ${
                existing.revision + 1
            }`,
            detailsJson: {
                category: 'custom',
                event: 'external_tool_parameters_signed',
                tool: existing.toolName,
                label: existing.label,
                pendingHash: existing.pendingHash,
                revision: existing.revision + 1,
                approvedByUserId: ctx.userId,
                requiredApprovals,
            },
        });

        return readOne(db, ctx.tenantId, id);
    });
}

/**
 * One set with its live signatures, read inside an ALREADY-OPEN tenant context.
 *
 * Takes `db` rather than calling `runInTenantContext` itself: nesting that
 * would open a second transaction inside the first, on a pooled connection, to
 * read a row the caller is already holding.
 */
async function readOne(
    db: PrismaTx,
    tenantId: string,
    id: string,
): Promise<ParameterSetState> {
    const fresh = (await db.externalToolParameterSet.findFirst({
        where: { id, tenantId },
        select: SELECT,
    })) as Row | null;
    if (!fresh) throw notFound('Parameter set not found');

    const signatures = fresh.pendingHash
        ? await db.externalToolParameterSetApproval.findMany({
              where: {
                  tenantId,
                  parameterSetId: id,
                  revision: fresh.revision + 1,
                  pendingHash: fresh.pendingHash,
              },
              orderBy: { createdAt: 'asc' },
              take: SIGNATURE_READ_LIMIT,
              select: {
                  approverUserId: true,
                  revision: true,
                  pendingHash: true,
                  requiredApprovals: true,
                  createdAt: true,
              },
          })
        : [];

    return toState(fresh, signatures);
}

/**
 * Which four-eyes refusal fired, as the DATABASE reported it.
 *
 * `null` means the failure was something else and must be rethrown. Swallowing
 * an unrelated error here would turn a broken database into a silent four-eyes
 * refusal, which reads to an operator as the control working — the mistake
 * `agent-proposals.ts` records the same way.
 */
function fourEyesRefusal(err: unknown): string | null {
    const text = err instanceof Error ? err.message : '';
    if ((err as { code?: unknown } | null)?.code === 'P2002') {
        return 'You have already approved this edit. The second approval has to come from a different person.';
    }
    if (text.includes('EXTERNAL_TOOL_PARAMETER_APPROVAL_PROPOSER_SELF_REVIEW')) {
        return 'You proposed this edit, so you cannot also be one of its approvers. Opening a field widens every future invocation; the second pair of eyes has to be a different pair.';
    }
    if (text.includes('EXTERNAL_TOOL_PARAMETER_APPROVAL_STALE_HASH')) {
        return 'The pending edit changed since it was reviewed. Re-read it and approve the digest now on file.';
    }
    if (text.includes('EXTERNAL_TOOL_PARAMETER_APPROVAL_NOTHING_PENDING')) {
        return 'There is no pending change on this parameter set to approve.';
    }
    if (text.includes('EXTERNAL_TOOL_PARAMETER_APPROVAL_WRONG_REVISION')) {
        return 'This parameter set moved while the edit was being reviewed. Re-read it and approve again.';
    }
    if (text.includes('EXTERNAL_TOOL_PARAMETER_APPROVAL_NO_SET')) {
        return 'Parameter set not found.';
    }
    if (text.includes('EXTERNAL_TOOL_OPEN_FIELDS_FOUR_EYES')) {
        return 'This edit changes the bounds on an open field, so it needs two approving signatures from humans other than the one who proposed it. Collect them before approving.';
    }
    if (text.includes('EXTERNAL_TOOL_OPEN_FIELDS_NOT_PROMOTED')) {
        return 'The open fields in force can only change by approving the pending edit that proposed them.';
    }
    if (text.includes('EXTERNAL_TOOL_OPEN_FIELDS_NOT_ON_BASELINE')) {
        return 'A parameter set cannot be created with open fields. Save the exact values, then propose the bounds.';
    }
    return null;
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
                pendingOpenFields: true,
                pendingHash: true,
                openFields: true,
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
        let row: unknown;
        try {
            row = await db.externalToolParameterSet.update({
                where: { id },
                data: {
                    parameters: existing.pendingParameters as object,
                    parametersHash: existing.pendingHash,
                    previousHash: existing.parametersHash,
                    revision,
                    approvalSource: 'APPROVED',
                    approvedByUserId: ctx.userId as string,
                    approvedAt: new Date(),
                    // THE PROMOTION the trigger gates. The open fields coming
                    // into force must be EXACTLY what was pending — the trigger
                    // compares them — so this is a copy and never a merge.
                    openFields:
                        existing.pendingOpenFields === null
                            ? Prisma.DbNull
                            : (existing.pendingOpenFields as object),
                    // `Prisma.DbNull`, not `undefined` and not `JsonNull`. On a
                    // nullable Json column `undefined` means "leave it alone", so
                    // the superseded proposal would SURVIVE its own approval — and
                    // the row would then violate `pending_is_whole`, since the hash
                    // beside it is being nulled. `JsonNull` is wrong in the other
                    // direction: it stores a JSON `null` AS the pending value,
                    // which reads back as a proposal whose content is null.
                    pendingParameters: Prisma.DbNull,
                    pendingOpenFields: Prisma.DbNull,
                    pendingHash: null,
                    pendingByUserId: null,
                    pendingAt: null,
                },
                select: SELECT,
            });
        } catch (err) {
            // The four-eyes count lives in the trigger, so THIS is where an
            // under-signed template edit is refused. Mapped to its message
            // rather than surfacing as a raw P0001, and rethrown untouched when
            // it is not one of ours — a broken database must not read as the
            // control working.
            const refusal = fourEyesRefusal(err);
            if (!refusal) throw err;
            throw badRequest(refusal);
        }

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
                // Field NAMES only — see the propose event for why the bounds
                // themselves stay out of a trail that streams to a SIEM.
                openFieldNames:
                    existing.pendingOpenFields === null
                        ? []
                        : Object.keys(
                              existing.pendingOpenFields as Record<string, unknown>,
                          ).sort(),
                requiredApprovals: requiredApprovalsFor({
                    openFields: existing.openFields ?? null,
                    pendingOpenFields: existing.pendingOpenFields ?? null,
                }),
            },
        });
        // The promoted row has no pending edit, so it has no live signatures.
        return toState(row as Row);
    });
}
