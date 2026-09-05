/**
 * Tool-manifest approval — the audited privileged act that clears a refusal.
 *
 * ## What a pin is, and why re-approval is privileged
 *
 * A tool definition is three fields the model reads — name, DESCRIPTION and
 * parameter schema. `McpToolManifestPin` records the definition a tenant has on
 * file for one tool, and the MCP boundary refuses that tool while the build no
 * longer matches. Approving is therefore the act of saying "this new instruction
 * text is legitimate", which is the exact decision an attacker who has managed
 * to change a description needs somebody to make. It carries a permission key,
 * it names the approver in a column, and it writes a hash-chained audit row.
 *
 * ## `expectedManifestHash` is required, and it is not ceremony
 *
 * An approval endpoint that took only a tool name would approve WHATEVER the
 * build says at the moment the request lands — including a definition that
 * changed between the operator reading the diff and clicking the button. The
 * caller must name the hash it is approving, and a mismatch is a 400. The
 * operator approves what they reviewed or nothing.
 *
 * ## Nothing here writes a description anywhere
 *
 * Not to the audit row, not to a log line, not to the response beyond what the
 * caller already sent. The row carries hashes, the tool name, the revision and
 * the approver. An audit trail that quoted the text would make the ledger — and
 * the SIEM it streams to — another place the injected instructions are
 * delivered, and every one of those readers is a model or a person.
 */
import { z } from 'zod';

import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { allToolDefinitions, toolDefinitionByName } from '@/lib/mcp/tool-definitions';
import { hashToolManifest, verifyToolManifest, type ToolManifestStatus } from '@/lib/mcp/tool-manifest';

import { assertCanAdmin, assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';

// ── Read ────────────────────────────────────────────────────────────────────

export interface ToolManifestState {
    toolName: string;
    status: ToolManifestStatus;
    /** The hash of the definition this build carries. */
    liveManifestHash: string;
    liveDescriptionHash: string;
    liveSchemaHash: string;
    /** The hash on file, or `null` when nothing is pinned. */
    approvedManifestHash: string | null;
    approvedDescriptionHash: string | null;
    approvedSchemaHash: string | null;
    approvalSource: string | null;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    revision: number | null;
    /** True while the boundary is refusing this tool. */
    blocked: boolean;
}

/**
 * Every tool this build defines, with its pin state — the list an operator acts
 * on. Driven from the LIVE registries and not from the pin table, so a tool that
 * has never been called still appears: a table-driven list would show only tools
 * somebody had already exercised, which is the wrong half.
 */
export async function listToolManifests(ctx: RequestContext): Promise<ToolManifestState[]> {
    assertCanRead(ctx);

    const defs = allToolDefinitions();
    const pins = await runInTenantContext(ctx, (db) =>
        db.mcpToolManifestPin.findMany({
            where: { tenantId: ctx.tenantId },
            // Bounded by this build's catalogue, which is a dozen rows. `take`
            // is stated anyway so the query shape does not rely on that.
            take: 200,
            select: {
                toolName: true,
                descriptionHash: true,
                schemaHash: true,
                manifestHash: true,
                revision: true,
                approvedByUserId: true,
                approvalSource: true,
                approvedAt: true,
            },
        }),
    );
    const byName = new Map(pins.map((p) => [p.toolName, p]));

    return defs.map((def) => {
        const pin = byName.get(def.name) ?? null;
        const verdict = verifyToolManifest(def, pin);
        return {
            toolName: def.name,
            status: verdict.status,
            liveManifestHash: verdict.live.manifestHash,
            liveDescriptionHash: verdict.live.descriptionHash,
            liveSchemaHash: verdict.live.schemaHash,
            approvedManifestHash: pin?.manifestHash ?? null,
            approvedDescriptionHash: pin?.descriptionHash ?? null,
            approvedSchemaHash: pin?.schemaHash ?? null,
            approvalSource: pin?.approvalSource ?? null,
            approvedByUserId: pin?.approvedByUserId ?? null,
            approvedAt: pin?.approvedAt ?? null,
            revision: pin?.revision ?? null,
            blocked: verdict.mustRefuse,
        };
    });
}

// ── Approve ─────────────────────────────────────────────────────────────────

export const ApproveToolManifestSchema = z
    .object({
        toolName: z.string().min(1).max(200),
        /**
         * The manifest hash the caller reviewed. Required — see the header for
         * why an approval that did not name one would approve the wrong thing.
         */
        expectedManifestHash: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest'),
    })
    .strict();

export type ApproveToolManifestInput = z.infer<typeof ApproveToolManifestSchema>;

export interface ApproveToolManifestResult {
    toolName: string;
    manifestHash: string;
    previousManifestHash: string | null;
    revision: number;
    approvedByUserId: string;
    /** False when the pin already matched — the call was a no-op. */
    changed: boolean;
}

/**
 * Approve the tool definition this build carries, clearing the boundary's
 * refusal and recording WHO accepted it.
 */
export async function approveToolManifest(
    ctx: RequestContext,
    input: unknown,
): Promise<ApproveToolManifestResult> {
    assertCanAdmin(ctx);

    const parsed = ApproveToolManifestSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest('Invalid tool-manifest approval', parsed.error.flatten());
    }
    const { toolName, expectedManifestHash } = parsed.data;

    const def = toolDefinitionByName(toolName);
    if (!def) {
        // A tool this build does not define. NOT an approvable thing: pinning a
        // name with no definition behind it would create a row that clears a
        // refusal for whatever later claims that name.
        throw notFound(`No MCP tool named "${toolName}" exists in this build`);
    }

    const live = hashToolManifest(def);
    if (live.manifestHash !== expectedManifestHash) {
        throw badRequest(
            'The tool definition changed since it was reviewed. Re-read the current ' +
                'definition and approve that hash.',
        );
    }

    // `userId` is what the accountability column exists for; a context without
    // one cannot approve. This is unreachable through the route (a permission
    // gate implies a session) and is checked anyway, because the column's whole
    // value is that it is never null on an APPROVED row.
    if (!ctx.userId) {
        throw badRequest('An approving user is required');
    }
    const approvedByUserId = ctx.userId;

    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await db.mcpToolManifestPin.findUnique({
            where: { tenantId_toolName: { tenantId: ctx.tenantId, toolName } },
            select: { id: true, manifestHash: true, revision: true },
        });

        if (existing && existing.manifestHash === live.manifestHash) {
            return {
                manifestHash: existing.manifestHash,
                previousManifestHash: null,
                revision: existing.revision,
                changed: false,
            };
        }

        const previousManifestHash = existing?.manifestHash ?? null;
        const revision = (existing?.revision ?? 0) + 1;

        if (existing) {
            await db.mcpToolManifestPin.update({
                where: { id: existing.id },
                data: {
                    descriptionHash: live.descriptionHash,
                    schemaHash: live.schemaHash,
                    manifestHash: live.manifestHash,
                    approvalSource: 'APPROVED',
                    approvedByUserId,
                    approvedAt: new Date(),
                    revision,
                    previousManifestHash,
                },
            });
        } else {
            await db.mcpToolManifestPin.create({
                data: {
                    tenantId: ctx.tenantId,
                    toolName,
                    descriptionHash: live.descriptionHash,
                    schemaHash: live.schemaHash,
                    manifestHash: live.manifestHash,
                    approvalSource: 'APPROVED',
                    approvedByUserId,
                    approvedAt: new Date(),
                    revision,
                    previousManifestHash,
                },
            });
        }

        await logEvent(db, ctx, {
            entityType: 'McpToolManifestPin',
            entityId: toolName,
            action: 'MCP_TOOL_MANIFEST_APPROVED',
            details: `Tool manifest approved for "${toolName}" (revision ${revision})`,
            detailsJson: {
                category: 'custom',
                event: 'mcp_tool_manifest_approved',
                tool: toolName,
                // Digests and the approver. Never the description — see header.
                manifestHash: live.manifestHash,
                previousManifestHash,
                descriptionHash: live.descriptionHash,
                schemaHash: live.schemaHash,
                revision,
                approvedByUserId,
            },
        });

        return { manifestHash: live.manifestHash, previousManifestHash, revision, changed: true };
    });

    return {
        toolName,
        manifestHash: result.manifestHash,
        previousManifestHash: result.previousManifestHash,
        revision: result.revision,
        approvedByUserId,
        changed: result.changed,
    };
}
