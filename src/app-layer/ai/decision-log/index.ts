/**
 * AI decision log — EU AI Act Art 12 record-keeping + AI-ops observability.
 *
 * One row per AI-feature invocation. The row stores a DIGEST of the sanitised
 * input (never the raw prompt/PII) + a bounded, sanitised output summary +
 * latency/cost + the output-guard verdict. Rows are append-only (a DB trigger
 * blocks edits to the core record); the only permitted mutation is a one-way
 * humanOutcome stamp (PENDING → terminal) — the Art 14 human-oversight feedback.
 *
 * PROVENANCE: authored from the Regulation + IC's own Epic E observability
 * patterns. Nothing derives from any third-party (AGPL) source.
 */
import { createHash } from 'node:crypto';
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { recordAiDecisionLogged, recordAiDecisionOutcome } from '@/lib/observability/metrics';

/** Bounded output-summary length — never store large/raw content. */
const SUMMARY_MAX = 500;

export type AiDecisionOutcome = 'ACCEPTED' | 'EDITED' | 'REJECTED';

/**
 * SHA-256 digest of the sanitised provider input. This is what proves "the same
 * question was asked" without ever persisting the prompt or any PII it carried.
 */
export function computeInputDigest(sanitizedInput: unknown): string {
    return 'sha256:' + createHash('sha256').update(JSON.stringify(sanitizedInput ?? null)).digest('hex');
}

export interface LogAiDecisionInput {
    /** The AI feature (e.g. 'risk-suggestions'). */
    feature: string;
    provider: string;
    model?: string | null;
    /** The ALREADY-sanitised provider input — hashed, never stored raw. */
    sanitizedInput: unknown;
    /** A short human-readable summary of the output — sanitised + bounded here. */
    outputSummary?: string | null;
    latencyMs?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    guardVerdict?: string | null;
    guardBlocked?: boolean;
    /** Optional registered AI system this decision belongs to (Art 12 record). */
    aiSystemId?: string | null;
    /** The generating session id — the feedback join key. */
    sessionRef?: string | null;
}

/**
 * Write ONE decision-log row for an AI-feature invocation. Returns the row id.
 * Must run inside the caller's tenant-scoped transaction (`db`).
 */
export async function logAiDecision(
    db: PrismaTx,
    ctx: RequestContext,
    input: LogAiDecisionInput,
): Promise<string> {
    // Privacy: digest the input; sanitise + bound the summary. Neither the raw
    // prompt nor PII is ever persisted.
    const summary = input.outputSummary
        ? sanitizePlainText(input.outputSummary).slice(0, SUMMARY_MAX)
        : null;

    const row = await db.aiDecisionLog.create({
        data: {
            tenantId: ctx.tenantId,
            feature: input.feature,
            aiSystemId: input.aiSystemId ?? null,
            provider: input.provider,
            model: input.model ?? null,
            inputDigest: computeInputDigest(input.sanitizedInput),
            outputSummary: summary,
            latencyMs: input.latencyMs ?? null,
            tokensIn: input.tokensIn ?? null,
            tokensOut: input.tokensOut ?? null,
            guardVerdict: input.guardVerdict ?? null,
            sessionRef: input.sessionRef ?? null,
            userId: ctx.userId,
        },
        select: { id: true },
    });

    recordAiDecisionLogged({
        provider: input.provider,
        feature: input.feature,
        guardBlocked: input.guardBlocked,
    });

    return row.id;
}

/**
 * Record the human-oversight outcome (Art 14) on the decision(s) for a session.
 * One-way: only PENDING rows transition (the DB trigger also enforces this).
 * Returns the number of rows stamped.
 */
export async function recordDecisionOutcome(
    db: PrismaTx,
    ctx: RequestContext,
    sessionRef: string,
    outcome: AiDecisionOutcome,
): Promise<number> {
    const res = await db.aiDecisionLog.updateMany({
        where: { tenantId: ctx.tenantId, sessionRef, humanOutcome: 'PENDING' },
        data: { humanOutcome: outcome },
    });
    if (res.count > 0) recordAiDecisionOutcome({ outcome });
    return res.count;
}

/**
 * The same Art 14 stamp, keyed by the INPUT DIGEST instead of a session.
 *
 * ── WHY A SECOND KEY EXISTS ─────────────────────────────────────────────────
 *
 * `sessionRef` is the right join for the suggestion features, which generate a
 * session and carry its id. The AGENTIC path has no session: `createAgentProposal`
 * writes `sessionRef: input.proposedBySessionRef ?? null`, and that input is
 * optional, so for an ordinary agent proposal the key is NULL. Stamping by
 * session there matches nothing — `updateMany` reports `count: 0`, no error is
 * raised, and the loop looks closed while every agentic decision stays PENDING
 * for ever. A silent zero is the worst available outcome for a record-keeping
 * control, so it is not the key this path uses.
 *
 * `inputDigest` IS always present on that path. `createAgentProposal` hashes the
 * same object into both records — `AiDecisionLog.inputDigest` and
 * `AgentProposal.guardInputDigest` are the same `sha256:<hex>` string, which the
 * proposal usecase already documents as the join that "proves the same content
 * was guarded". This function is that join, used for the purpose it was written
 * for.
 *
 * Identical semantics otherwise: one-way, PENDING rows only, enforced by the
 * same database trigger, and the count is returned so a caller can assert it
 * rather than assume it.
 */
export async function recordDecisionOutcomeForDigest(
    db: PrismaTx,
    ctx: RequestContext,
    inputDigest: string,
    outcome: AiDecisionOutcome,
): Promise<number> {
    const res = await db.aiDecisionLog.updateMany({
        where: { tenantId: ctx.tenantId, inputDigest, humanOutcome: 'PENDING' },
        data: { humanOutcome: outcome },
    });
    if (res.count > 0) recordAiDecisionOutcome({ outcome });
    return res.count;
}
