/**
 * Agent-action receipts — ingest, VERIFY, link, list, export.
 *
 * Records externally-verifiable evidence of AI/MCP agent actions mediated by an
 * external pipelock daemon (Apache-2.0 CORE receipt format). The trust model:
 *
 *   1. Parse + bound/scrub the receipt (no raw payloads/secrets ever stored).
 *   2. Verify the mediator's Ed25519 signature natively (Node `crypto`) against
 *      the CONFIGURED public key (env.PIPELOCK_PUBLIC_KEY) — see
 *      src/lib/mcp/receipt-verification.ts.
 *   3. VALID  → write a hash-chained AuditLog entry, then persist the receipt
 *               with `verified:true` + `auditLogId` (the durable link between the
 *               signed external evidence and our internal immutable ledger).
 *      INVALID/absent → persist with `verified:false` and NO auditLogId — the
 *               receipt is visible-but-flagged, never silently accepted and
 *               never linked to the audit chain.
 *
 * Signed external receipts COMPLEMENT the internal hash-chain: the chain proves
 * WE recorded the event tamper-evidently; the receipt proves an INDEPENDENT
 * mediator observed + signed it. An auditor can verify the receipt without
 * trusting us (via the export endpoint + pipelock's own verifier).
 *
 * All Prisma access is tenant-scoped through `runInTenantContext` — there is no
 * direct Prisma in the verify path outside this usecase.
 */
import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { appendAuditEntry } from '@/lib/audit';
import { badRequest, notFound } from '@/lib/errors/types';
import { log } from '@/lib/observability';
import {
    PipelockReceiptSchema,
    verifyReceiptSignature,
    extractReceiptFields,
    boundAndScrubSummary,
    type PipelockReceipt,
} from '@/lib/mcp/receipt-verification';
import { env } from '@/env';
import { isKnownMcpTool } from '@/lib/mcp/tool-catalogue';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import {
    TOOL_PROVENANCE_BUILTIN,
    TOOL_PROVENANCE_PIN_MOVED,
    TOOL_PROVENANCE_UNATTESTED,
} from '@/lib/mcp/tool-manifest';
import { assertCanWrite, assertCanRead } from '@/app-layer/policies/common';
import type { RequestContext } from '@/app-layer/types';
import { assertMayReadOversightSurface } from './agent-oversight-settings';

// ── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestReceiptResult {
    id: string;
    verified: boolean;
    auditLogId: string | null;
    /** Machine-readable reason when unverified (never surfaces secrets). */
    reason?: string;
}

/** The tool-provenance columns stamped on one receipt. */
interface ReceiptToolProvenance {
    toolProvenance: string;
    toolDescriptionHash: string | null;
    toolManifestHash: string | null;
    toolManifestRevision: number | null;
}

/**
 * Which tool DESCRIPTION was in force when this action happened (OWASP ASI04).
 *
 * "Which version of which tool description produced this action" is a question
 * an audit asks AFTER a poisoned description has been found, about actions taken
 * months earlier — by which time the description has been fixed and the registry
 * no longer holds the text that caused the harm. A receipt naming only the tool
 * cannot answer it. These four columns can, and they are stamped at INGEST
 * rather than derived at read time for exactly that reason: a value derived
 * later would answer "what does the build say now", which is a different claim.
 *
 * The hash comes from the tenant's PIN, not from the live registry, and that is
 * the load-bearing choice. The pin is what the MCP boundary ENFORCED: a call
 * whose live definition had drifted from the pin was refused, so for any action
 * that actually executed the two agree — and where they do not agree, the pin is
 * the one that describes the regime the action ran under. Reading the live
 * registry instead would attribute an old action to whatever the current deploy
 * happens to say.
 *
 * Three outcomes, and the NULLs are meaningful rather than missing:
 *
 *   • a tool this build defines, WITH a pin → `inflect:builtin` + the hashes.
 *   • a tool this build defines with NO pin yet (a receipt about a call that
 *     never reached our boundary) → `inflect:builtin`, hashes NULL. We know
 *     whose tool it is and we do not know which definition was in front of it;
 *     saying so is the honest record.
 *   • a name this build does not define — an external mediator sees calls to
 *     third-party MCP servers too → `unattested`, hashes NULL. Hashing OUR
 *     registry for a name we do not serve would invent provenance.
 */
async function resolveToolProvenance(
    db: PrismaTx,
    tenantId: string,
    toolName: string,
    occurredAt: Date,
): Promise<ReceiptToolProvenance> {
    const known = isKnownMcpTool(toolName);
    const provenance = known ? TOOL_PROVENANCE_BUILTIN : TOOL_PROVENANCE_UNATTESTED;
    if (!known) {
        return {
            toolProvenance: provenance,
            toolDescriptionHash: null,
            toolManifestHash: null,
            toolManifestRevision: null,
        };
    }

    const pin = await db.mcpToolManifestPin.findUnique({
        where: { tenantId_toolName: { tenantId, toolName } },
        select: {
            descriptionHash: true,
            manifestHash: true,
            revision: true,
            approvedAt: true,
        },
    });

    // The stamp is captured at INGEST, and ingest is not execution — the
    // mediator is external and late delivery is ordinary. If the pin on file was
    // approved after the action occurred, the definition in front of the agent
    // at the time is not the one we hold, and stamping it would produce evidence
    // that points at the wrong text in exactly the incident where it matters.
    if (pin && pin.approvedAt > occurredAt) {
        return {
            toolProvenance: TOOL_PROVENANCE_PIN_MOVED,
            toolDescriptionHash: null,
            toolManifestHash: null,
            toolManifestRevision: null,
        };
    }

    return {
        toolProvenance: provenance,
        toolDescriptionHash: pin?.descriptionHash ?? null,
        toolManifestHash: pin?.manifestHash ?? null,
        toolManifestRevision: pin?.revision ?? null,
    };
}

/**
 * Ingest a pipelock CORE receipt: bound/scrub, verify the Ed25519 signature,
 * link a verified receipt to a hash-chained AuditLog entry, and persist. A
 * receipt whose signature is invalid/absent is persisted `verified:false` with
 * no audit link (flagged, never trusted).
 */
export async function ingestReceipt(ctx: RequestContext, rawReceipt: unknown): Promise<IngestReceiptResult> {
    assertCanWrite(ctx);

    // 1. Parse the CORE receipt shape.
    const parsed = PipelockReceiptSchema.safeParse(rawReceipt);
    if (!parsed.success) {
        throw badRequest('Malformed pipelock receipt', parsed.error.flatten());
    }
    const receipt: PipelockReceipt = parsed.data;

    // 2. Extract storage fields + bound/scrub the scanned summary (no raw payloads).
    const fields = extractReceiptFields(receipt);
    const scannedSummary = boundAndScrubSummary(receipt.action_record);

    // 3. Verify the mediator's Ed25519 signature against the configured public key.
    const verification = verifyReceiptSignature(receipt, env.PIPELOCK_PUBLIC_KEY);

    // 4. Verified → append the hash-chained audit entry FIRST so we have its id
    //    to link. appendAuditEntry manages its own advisory-locked transaction
    //    (it is the canonical audit writer; usable outside a tenant tx).
    let auditLogId: string | null = null;
    if (verification.valid) {
        const audit = await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            entity: 'AgentActionReceipt',
            entityId: fields.agentId ?? 'agent',
            action: 'AGENT_ACTION_RECEIPT_VERIFIED',
            detailsJson: {
                category: 'custom',
                event: 'agent_action_receipt_verified',
                toolName: fields.toolName,
                decisionVerdict: fields.decisionVerdict,
                activePolicy: fields.activePolicy,
                signingKeyId: verification.signingKeyId,
                occurredAt: fields.occurredAt.toISOString(),
            },
            metadataJson: { mcpKeyId: ctx.apiKeyId ?? null, agentId: fields.agentId },
        });
        auditLogId = audit.id;
    } else {
        log('warn', 'Ingested unverified agent-action receipt', {
            reason: verification.reason,
            toolName: fields.toolName,
            signingKeyId: verification.signingKeyId,
        });
    }

    // 5. Persist the receipt (tenant-scoped write via runInTenantContext),
    //    stamped with the TOOL PROVENANCE in force — see `resolveToolProvenance`.
    const row = await runInTenantContext(ctx, async (db) => {
        const provenance = await resolveToolProvenance(
            db,
            ctx.tenantId,
            fields.toolName,
            fields.occurredAt,
        );
        return db.agentActionReceipt.create({
            data: {
                tenantId: ctx.tenantId,
                mcpKeyId: ctx.apiKeyId ?? null,
                agentId: fields.agentId,
                toolName: fields.toolName,
                decisionVerdict: fields.decisionVerdict,
                activePolicy: fields.activePolicy,
                scannedSummary: scannedSummary as unknown as Prisma.InputJsonValue,
                signature: fields.signature,
                signingKeyId: verification.signingKeyId,
                occurredAt: fields.occurredAt,
                auditLogId,
                verified: verification.valid,
                toolProvenance: provenance.toolProvenance,
                toolDescriptionHash: provenance.toolDescriptionHash,
                toolManifestHash: provenance.toolManifestHash,
                toolManifestRevision: provenance.toolManifestRevision,
            },
            select: { id: true },
        });
    });

    return {
        id: row.id,
        verified: verification.valid,
        auditLogId,
        reason: verification.valid ? undefined : verification.reason,
    };
}

// ── List ────────────────────────────────────────────────────────────────────

export const ListReceiptsFilterSchema = z.object({
    verified: z.boolean().optional(),
    toolName: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
});
export type ListReceiptsFilter = z.infer<typeof ListReceiptsFilterSchema>;

export interface ReceiptListItem {
    id: string;
    toolName: string;
    decisionVerdict: string;
    activePolicy: string | null;
    agentId: string | null;
    signingKeyId: string;
    verified: boolean;
    auditLogId: string | null;
    occurredAt: Date;
    createdAt: Date;
    /** Tool provenance in force at ingest — see `resolveToolProvenance`. */
    toolProvenance: string | null;
    toolDescriptionHash: string | null;
    toolManifestHash: string | null;
    toolManifestRevision: number | null;
}

/** List receipts for the current tenant, newest first. Bounded (default 100). */
export async function listReceipts(ctx: RequestContext, filter: ListReceiptsFilter = {}): Promise<ReceiptListItem[]> {
    assertCanRead(ctx);
    // The page's own rule, at the API too (#4897): the register key, or the
    // inventory view key while an owner lets Auditors read receipts.
    await assertMayReadOversightSurface(ctx, 'receipts');
    const take = filter.limit ?? 100;

    return runInTenantContext(ctx, (db) =>
        db.agentActionReceipt.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(filter.verified !== undefined ? { verified: filter.verified } : {}),
                ...(filter.toolName ? { toolName: filter.toolName } : {}),
            },
            orderBy: { occurredAt: 'desc' },
            take,
            select: {
                id: true,
                toolName: true,
                decisionVerdict: true,
                activePolicy: true,
                agentId: true,
                signingKeyId: true,
                verified: true,
                auditLogId: true,
                occurredAt: true,
                createdAt: true,
                toolProvenance: true,
                toolDescriptionHash: true,
                toolManifestHash: true,
                toolManifestRevision: true,
            },
        }),
    );
}

// ── The receipts page (#4897) ───────────────────────────────────────────────

/** How many receipts the page shows; it reads one past this to say when it is cut. */
export const RECEIPT_PAGE_SIZE = 100;

export interface ReceiptPageRow {
    id: string;
    /** The tool's own name; for an outside tool, its name on its server. */
    toolName: string;
    /** The outside tool's connection, by name, or `null` for a built-in tool. */
    connectionName: string | null;
    decisionVerdict: string;
    activePolicy: string | null;
    verified: boolean;
    occurredAt: string;
    /**
     * The registered agent the SUBMITTING key is bound to — our binding, never
     * the receipt's own claim (CLAUDE.md, "per-agent evidence"). `null` when
     * the key is bound to no agent.
     */
    agent: { id: string; name: string } | null;
    /**
     * What the receipt itself names as its agent, shown only on a VERIFIED
     * receipt and labelled as its claim: on an unverified one it is whatever
     * the sender chose to write.
     */
    claimedAgentId: string | null;
    auditLogId: string | null;
    toolProvenance: string | null;
    toolManifestRevision: number | null;
}

/**
 * The page's read (#4897): the newest window, whether older receipts exist,
 * and the names the rows point at. Same rule as the list — the register key,
 * or the view key while an owner lets Auditors read receipts.
 */
export async function readReceiptPage(
    ctx: RequestContext,
    filter: { verified?: boolean; toolName?: string } = {},
): Promise<{ rows: ReceiptPageRow[]; capped: number | null }> {
    assertCanRead(ctx);
    await assertMayReadOversightSurface(ctx, 'receipts');

    return runInTenantContext(ctx, async (db) => {
        const read = await db.agentActionReceipt.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(filter.verified !== undefined ? { verified: filter.verified } : {}),
                ...(filter.toolName ? { toolName: filter.toolName } : {}),
            },
            orderBy: { occurredAt: 'desc' },
            take: RECEIPT_PAGE_SIZE + 1,
            select: {
                id: true,
                mcpKeyId: true,
                toolName: true,
                decisionVerdict: true,
                activePolicy: true,
                agentId: true,
                verified: true,
                auditLogId: true,
                occurredAt: true,
                toolProvenance: true,
                toolManifestRevision: true,
            },
        });
        const rows = read.slice(0, RECEIPT_PAGE_SIZE);

        const keyIds = [...new Set(rows.flatMap((r) => (r.mcpKeyId ? [r.mcpKeyId] : [])))];
        const keys = keyIds.length
            ? await db.tenantApiKey.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: keyIds } },
                  select: { id: true, agentId: true },
                  take: keyIds.length,
              })
            : [];
        const agentOfKey = new Map(keys.map((k) => [k.id, k.agentId]));
        const agentIds = [...new Set(keys.flatMap((k) => (k.agentId ? [k.agentId] : [])))];
        const refs = rows.map((r) => parseExternalToolName(r.toolName));
        const connectionIds = [...new Set(refs.flatMap((ref) => (ref ? [ref.connectionId] : [])))];
        const [agents, connections] = await Promise.all([
            agentIds.length
                ? db.registeredAgent.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: agentIds } },
                      select: { id: true, name: true },
                      take: agentIds.length,
                  })
                : Promise.resolve([] as { id: string; name: string }[]),
            connectionIds.length
                ? db.integrationConnection.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: connectionIds } },
                      select: { id: true, name: true },
                      take: connectionIds.length,
                  })
                : Promise.resolve([] as { id: string; name: string }[]),
        ]);
        const agentName = new Map(agents.map((a) => [a.id, a.name]));
        const connectionName = new Map(connections.map((c) => [c.id, c.name]));

        return {
            rows: rows.map((r, i) => {
                const ref = refs[i];
                const boundAgentId = r.mcpKeyId ? (agentOfKey.get(r.mcpKeyId) ?? null) : null;
                return {
                    id: r.id,
                    toolName: ref ? ref.toolName : r.toolName,
                    connectionName: ref ? (connectionName.get(ref.connectionId) ?? null) : null,
                    decisionVerdict: r.decisionVerdict,
                    activePolicy: r.activePolicy,
                    verified: r.verified,
                    occurredAt: r.occurredAt.toISOString(),
                    agent:
                        boundAgentId && agentName.has(boundAgentId)
                            ? { id: boundAgentId, name: agentName.get(boundAgentId)! }
                            : null,
                    claimedAgentId: r.verified ? r.agentId : null,
                    auditLogId: r.auditLogId,
                    toolProvenance: r.toolProvenance,
                    toolManifestRevision: r.toolManifestRevision,
                };
            }),
            capped: read.length > RECEIPT_PAGE_SIZE ? RECEIPT_PAGE_SIZE : null,
        };
    });
}

// ── Export (external auditor verification) ──────────────────────────────────

export interface ReceiptExport {
    id: string;
    toolName: string;
    decisionVerdict: string;
    activePolicy: string | null;
    agentId: string | null;
    /** The signed decision container — canonicalize + hash to reproduce the message. */
    scannedSummary: unknown;
    signature: string;
    signingKeyId: string;
    verified: boolean;
    auditLogId: string | null;
    occurredAt: string;
    /**
     * Which tool DESCRIPTION was in force when the action happened. The question
     * an auditor asks once a poisoned description has been found and the
     * registry no longer holds the text that caused the harm.
     */
    toolProvenance: string | null;
    toolDescriptionHash: string | null;
    toolManifestHash: string | null;
    toolManifestRevision: number | null;
    /**
     * How to verify independently. The signature is Ed25519 over
     * SHA-256(canonical-json(action_record)). We store only a SCRUBBED, bounded
     * `scannedSummary` (never the raw payload), so full re-verification is done
     * against pipelock's OWN original evidence (the mediator's `evidence.jsonl`)
     * using this `signature` + `signingKeyId` and the pipelock verifier CLI —
     * NO trust in this system required. `signingKeyMatchesConfigured` records
     * whether the receipt's signer matched our configured trusted key at ingest.
     */
    verification: {
        algorithm: 'ed25519';
        messageDerivation: 'sha256(canonical-json(action_record))';
        canonicalForm: 'sorted-key, no-whitespace JSON';
        note: string;
    };
}

/**
 * Return the full receipt + signature so an EXTERNAL auditor can verify it with
 * pipelock's own verifier CLI WITHOUT trusting us. We include the canonicalized
 * action_record we hashed so the auditor can reproduce the signed message.
 */
export async function getReceiptForExport(ctx: RequestContext, id: string): Promise<ReceiptExport> {
    assertCanRead(ctx);
    await assertMayReadOversightSurface(ctx, 'receipts');

    const row = await runInTenantContext(ctx, (db) =>
        db.agentActionReceipt.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: {
                id: true,
                toolName: true,
                decisionVerdict: true,
                activePolicy: true,
                agentId: true,
                scannedSummary: true,
                signature: true,
                signingKeyId: true,
                verified: true,
                auditLogId: true,
                occurredAt: true,
                toolProvenance: true,
                toolDescriptionHash: true,
                toolManifestHash: true,
                toolManifestRevision: true,
            },
        }),
    );

    if (!row) {
        throw notFound('Agent action receipt not found');
    }

    return {
        id: row.id,
        toolName: row.toolName,
        decisionVerdict: row.decisionVerdict,
        activePolicy: row.activePolicy,
        agentId: row.agentId,
        scannedSummary: row.scannedSummary,
        signature: row.signature,
        signingKeyId: row.signingKeyId,
        verified: row.verified,
        auditLogId: row.auditLogId,
        occurredAt: row.occurredAt.toISOString(),
        toolProvenance: row.toolProvenance,
        toolDescriptionHash: row.toolDescriptionHash,
        toolManifestHash: row.toolManifestHash,
        toolManifestRevision: row.toolManifestRevision,
        verification: {
            algorithm: 'ed25519',
            messageDerivation: 'sha256(canonical-json(action_record))',
            canonicalForm: 'sorted-key, no-whitespace JSON',
            note:
                'Re-verify against pipelock\'s original evidence.jsonl using the pipelock verifier CLI with this signature + signingKeyId. ' +
                'The stored scannedSummary is scrubbed/bounded and is NOT the signed payload.',
        },
    };
}
