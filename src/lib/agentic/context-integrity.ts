/**
 * Workflow CONTEXT INTEGRITY — OWASP ASI06 (Memory and Context Poisoning).
 *
 * `WorkflowRun.contextJson` is the agent's memory. It accumulates across steps,
 * it survives an arbitrarily long HUMAN_CHECKPOINT pause, and every later step
 * reads it: `args(context)`, `buildItems(context)`, `synthesize(context)` all
 * take their instructions from it. So a value that got in once shapes behaviour
 * long after the interaction that produced it.
 *
 * The column is ENCRYPTED at rest (Epic B manifest). **Encryption is
 * confidentiality, not integrity.** It says nobody read the context; it says
 * nothing about whether the context is the one the previous step wrote. Three
 * distinct failures were all invisible before this module:
 *
 *   1. a blob that no longer has the SHAPE the engine expects (`outputs`
 *      replaced by a string, a step's key pointing at something the next step
 *      will index into) — the executor used to `JSON.parse` it inside a
 *      `try {} catch { return { input: {}, outputs: {} } }`, so a corrupt
 *      context did not stop the run, it silently RESET the agent's memory and
 *      carried on with a context nobody wrote;
 *   2. a blob EDITED between steps — poisoned, or an older snapshot replayed;
 *   3. a blob that simply grew without bound, so the run either blew a token
 *      budget or (worse, had anyone reached for the obvious fix) got truncated,
 *      which turns an oversized context into a plausible-looking small one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CHAIN, AND WHY IT IS SHAPED LIKE THE AUDIT TRAIL'S
 *
 * This is the SAME construction as `src/lib/audit/canonical-hash.ts`, using
 * that module's own `canonicalJsonStringify` — not a second chaining scheme.
 * Each committed context is a link:
 *
 *     hash_n = SHA-256(canonicalJSON({ contextDigest, previousHash: hash_n-1,
 *                                      runId, seq: n, tenantId, version }))
 *
 * and `hash_n` is written to `WorkflowRun.contextHash` in the same statement
 * that writes the context. The envelope persisted inside `contextJson` carries
 * `{ v, seq, prev, input, outputs }` — the two chain inputs the verifier needs
 * to recompute the link, and nothing else.
 *
 * WHY THE HEAD LIVES IN A COLUMN AND NOT IN THE ENVELOPE. If the head were
 * stored inside the blob it protects, anyone who could rewrite the blob could
 * recompute the head, and the chain would certify nothing. The audit trail
 * makes the same split for the same reason — `AuditLog.entryHash` is a column,
 * not a field inside `detailsJson`. What this construction detects is a write
 * to `contextJson` that did not come through `sealContext`; what it does not
 * detect is an attacker who rewrites the context AND the head together, which
 * is exactly the residual the audit trail answers with its immutability trigger
 * and which is stated here rather than implied.
 *
 * `runId` and `tenantId` are IN the payload, so a context lifted from another
 * run — or another tenant's run — fails at `seq` and at the ids rather than
 * being accepted as a well-formed link. `seq` is in the payload so REPLAYING an
 * earlier, genuinely-sealed context from this same run is caught too: it was a
 * valid link at seq 3 and is not one at seq 7.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY FAILURE HALTS. NONE OF THEM REPAIRS.
 *
 * There is no truncation, no coercion, no "drop the bad key and continue", and
 * no trust-on-first-use for an unsealed row. Each of those would leave the run
 * executing on a context nobody wrote, which is the precise condition this
 * module exists to make impossible. `openSealedContext` and `sealContext` throw
 * `ContextIntegrityError`; the executor turns that into a FAILED run carrying
 * the code, and the operator gets a run that stopped instead of a run that
 * quietly changed its mind.
 *
 * NOTHING HERE EVER CARRIES CONTEXT CONTENT. `ContextIntegrityError.detail`
 * holds codes, byte counts and SHA-256 digests only — the same digest-only
 * posture as `computeInputDigest` in `src/app-layer/ai/decision-log`. A halt is
 * reported by naming what failed and how big it was, never by quoting what was
 * in it.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

// The audit chain's own canonical serializer, imported from the leaf module
// rather than the `@/lib/audit` barrel: the barrel pulls `audit-writer`, and
// therefore Prisma, into every consumer of this file. `canonical-hash.ts`
// imports nothing but `node:crypto`.
import { canonicalJsonStringify } from '@/lib/audit/canonical-hash';

import type { WorkflowContext } from './workflow-types';

/**
 * Envelope version. Bumping it invalidates every stored link on purpose — a
 * chain computed under different rules is not the same chain, and silently
 * accepting one would be the bypass this module exists to close.
 */
export const CONTEXT_ENVELOPE_VERSION = 1;

/**
 * The hard ceiling on a persisted context, in bytes of UTF-8 JSON.
 *
 * 256 KiB. The engine's token budget (`ENGINE_CAPS.MAX_TOKENS`, 200k) bounds
 * what a run may SPEND across all steps; it does not bound what any single
 * persisted context may WEIGH, and those are different failures — a run can sit
 * far inside its token budget while one read tool's output makes the context
 * unreadable, unverifiable and expensive to decrypt on every subsequent step.
 *
 * The number is a size, not a guess about content: it is roughly 64k tokens of
 * accumulated state at the engine's own ~4-chars-per-token estimate, which is
 * more than any canned workflow accumulates and small enough that a context
 * reaching it is a signal rather than a cost.
 */
export const MAX_CONTEXT_BYTES = 262_144;

/**
 * The exact fields that go into a chain link, lexicographically ordered.
 * Mirrors `HASH_FIELDS` in the audit trail — the constant documents the
 * contract so a field cannot be added to the payload without being added here.
 */
export const CONTEXT_LINK_FIELDS = [
    'contextDigest',
    'previousHash',
    'runId',
    'seq',
    'tenantId',
    'version',
] as const;

export type ContextIntegrityCode =
    /** No seal at all: `contextHash` is NULL. A pre-integrity row, or a wipe. */
    | 'CONTEXT_UNSEALED'
    /** The stored blob is not JSON. */
    | 'CONTEXT_UNPARSEABLE'
    /** The stored blob is JSON but not a workflow-context envelope. */
    | 'CONTEXT_SCHEMA_INVALID'
    /** The blob's recomputed link does not equal the stored head. */
    | 'CONTEXT_CHAIN_BROKEN'
    /** The blob is over `MAX_CONTEXT_BYTES`. Reported, never trimmed. */
    | 'CONTEXT_SIZE_CAP_EXCEEDED';

/**
 * Detail carried alongside a halt. Deliberately a closed shape of numbers,
 * codes and digests — there is no field here that could hold context content,
 * so a future caller cannot log one by accident.
 */
export interface ContextIntegrityDetail {
    /** Chain position the failure was observed at, when known. */
    seq?: number;
    /** Observed size of the offending blob, in bytes. */
    bytes?: number;
    /** The cap it was measured against. */
    cap?: number;
    /** The link the stored head claimed. */
    expectedHash?: string;
    /** The link the stored blob actually computes to. */
    observedHash?: string;
    /** SHA-256 of the offending blob — identifies it without quoting it. */
    blobDigest?: string;
    /** How many schema issues were found. */
    issueCount?: number;
    /**
     * Which ENVELOPE fields the schema issues touched. Restricted to the five
     * envelope key names below, so a tenant-controlled key inside `input`
     * cannot ride out of here in a field name.
     */
    issueFields?: string[];
}

/** A context that cannot be trusted. Never carries context content. */
export class ContextIntegrityError extends Error {
    public readonly code: ContextIntegrityCode;
    public readonly detail: ContextIntegrityDetail;

    constructor(code: ContextIntegrityCode, detail: ContextIntegrityDetail = {}) {
        super(`workflow context integrity: ${code}`);
        this.name = 'ContextIntegrityError';
        this.code = code;
        this.detail = detail;
    }
}

/** The five envelope keys — the only names allowed out in `issueFields`. */
const ENVELOPE_KEYS = ['v', 'seq', 'prev', 'input', 'outputs'] as const;

/**
 * The persisted shape. `input` / `outputs` are the engine's `WorkflowContext`;
 * `v` / `seq` / `prev` are the chain link's own inputs.
 *
 * `.strict()` is load-bearing: an unknown top-level key is a blob this engine
 * did not write, and accepting it would let a writer smuggle state past a
 * schema that claims to describe the whole envelope.
 */
export const SealedContextSchema = z
    .object({
        v: z.literal(CONTEXT_ENVELOPE_VERSION),
        seq: z.number().int().nonnegative(),
        prev: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        input: z.record(z.string(), z.unknown()),
        outputs: z.record(z.string(), z.unknown()),
    })
    .strict();

export type SealedContext = z.infer<typeof SealedContextSchema>;

/** SHA-256 hex of a UTF-8 string. */
function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Compute one chain link. Deterministic: the same context at the same position
 * of the same run always yields the same hex digest.
 */
export function computeContextLink(input: {
    tenantId: string;
    runId: string;
    seq: number;
    previousHash: string | null;
    context: WorkflowContext;
}): string {
    const contextDigest = sha256(
        canonicalJsonStringify({ input: input.context.input, outputs: input.context.outputs }),
    );
    return sha256(
        canonicalJsonStringify({
            contextDigest,
            previousHash: input.previousHash,
            runId: input.runId,
            seq: input.seq,
            tenantId: input.tenantId,
            version: CONTEXT_ENVELOPE_VERSION,
        }),
    );
}

/** Reduce zod issues to a content-free summary. */
function summariseIssues(issues: ReadonlyArray<{ path: PropertyKey[] }>): Pick<
    ContextIntegrityDetail,
    'issueCount' | 'issueFields'
> {
    const fields = new Set<string>();
    for (const issue of issues) {
        const head = issue.path[0];
        if (typeof head === 'string' && (ENVELOPE_KEYS as readonly string[]).includes(head)) {
            fields.add(head);
        }
    }
    return { issueCount: issues.length, issueFields: [...fields].sort() };
}

export interface SealResult {
    /** The envelope to persist in `contextJson`. */
    json: string;
    /** The chain head to persist in `contextHash`. */
    hash: string;
    /** The position this link occupies. */
    seq: number;
    /** Size of `json` in bytes — for the observability histogram. */
    bytes: number;
}

/**
 * Validate, size-check and seal a context for persistence.
 *
 * Throws `ContextIntegrityError` rather than returning a partial result: a
 * caller that could carry on with `{ json: null }` would be the silent-reset
 * bug in a new place.
 */
export function sealContext(params: {
    tenantId: string;
    runId: string;
    /** The position of the link being written — 0 for a run's first context. */
    seq: number;
    /** The head this link chains onto — null only at seq 0. */
    previousHash: string | null;
    context: WorkflowContext;
}): SealResult {
    const envelope = {
        v: CONTEXT_ENVELOPE_VERSION,
        seq: params.seq,
        prev: params.previousHash,
        input: params.context.input,
        outputs: params.context.outputs,
    };

    // Validate on WRITE as well as on read. A step callback that puts something
    // unrepresentable into `outputs` must fail here, at the step that did it,
    // rather than at whichever later step happens to read it back.
    const parsed = SealedContextSchema.safeParse(envelope);
    if (!parsed.success) {
        throw new ContextIntegrityError('CONTEXT_SCHEMA_INVALID', {
            seq: params.seq,
            ...summariseIssues(parsed.error.issues),
        });
    }

    let json: string;
    try {
        json = JSON.stringify(envelope);
    } catch {
        // Circular / BigInt / otherwise unserialisable. Same halt, no repair.
        throw new ContextIntegrityError('CONTEXT_SCHEMA_INVALID', { seq: params.seq, issueCount: 1 });
    }
    // `JSON.stringify` returns undefined for a value it cannot represent.
    if (typeof json !== 'string') {
        throw new ContextIntegrityError('CONTEXT_SCHEMA_INVALID', { seq: params.seq, issueCount: 1 });
    }

    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_CONTEXT_BYTES) {
        // HALT AND REPORT. Never `json.slice(...)`: a truncated context is a
        // syntactically fine blob that has quietly lost whatever was at the end
        // of it, which is indistinguishable downstream from a context that was
        // always that small. The oversize is the finding.
        throw new ContextIntegrityError('CONTEXT_SIZE_CAP_EXCEEDED', {
            seq: params.seq,
            bytes,
            cap: MAX_CONTEXT_BYTES,
            blobDigest: sha256(json),
        });
    }

    return {
        json,
        hash: computeContextLink({
            tenantId: params.tenantId,
            runId: params.runId,
            seq: params.seq,
            previousHash: params.previousHash,
            context: { input: parsed.data.input, outputs: parsed.data.outputs },
        }),
        seq: params.seq,
        bytes,
    };
}

export interface OpenedContext {
    context: WorkflowContext;
    /** The position the stored link occupies. */
    seq: number;
    /** The verified head — what the next link chains onto. */
    hash: string;
}

/**
 * Open a stored context: size-check, parse, schema-validate, then verify the
 * chain link against the stored head. Any failure throws; there is no path
 * through this function that returns a context it could not verify.
 *
 * The checks are ordered cheapest-and-most-fundamental first, and the order is
 * observable in the reported code: an unsealed row reports `CONTEXT_UNSEALED`
 * rather than a chain break, and an oversized blob reports its size rather than
 * whatever else is also wrong with it.
 */
export function openSealedContext(params: {
    tenantId: string;
    runId: string;
    storedJson: string | null;
    storedHash: string | null;
}): OpenedContext {
    if (!params.storedHash || !params.storedJson) {
        // No seal to check against. Fail closed: a run whose context cannot be
        // verified does not get to continue on the strength of it being
        // well-formed. Adopting an unsealed blob would be trust-on-first-use,
        // and anyone able to write the blob can also clear the head.
        throw new ContextIntegrityError('CONTEXT_UNSEALED', {});
    }

    const bytes = Buffer.byteLength(params.storedJson, 'utf8');
    if (bytes > MAX_CONTEXT_BYTES) {
        throw new ContextIntegrityError('CONTEXT_SIZE_CAP_EXCEEDED', {
            bytes,
            cap: MAX_CONTEXT_BYTES,
            blobDigest: sha256(params.storedJson),
        });
    }

    let raw: unknown;
    try {
        raw = JSON.parse(params.storedJson);
    } catch {
        throw new ContextIntegrityError('CONTEXT_UNPARSEABLE', {
            bytes,
            blobDigest: sha256(params.storedJson),
        });
    }

    const parsed = SealedContextSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ContextIntegrityError('CONTEXT_SCHEMA_INVALID', {
            bytes,
            blobDigest: sha256(params.storedJson),
            ...summariseIssues(parsed.error.issues),
        });
    }

    const context: WorkflowContext = { input: parsed.data.input, outputs: parsed.data.outputs };
    const observedHash = computeContextLink({
        tenantId: params.tenantId,
        runId: params.runId,
        seq: parsed.data.seq,
        previousHash: parsed.data.prev,
        context,
    });
    if (observedHash !== params.storedHash) {
        throw new ContextIntegrityError('CONTEXT_CHAIN_BROKEN', {
            seq: parsed.data.seq,
            bytes,
            expectedHash: params.storedHash,
            observedHash,
            blobDigest: sha256(params.storedJson),
        });
    }

    return { context, seq: parsed.data.seq, hash: params.storedHash };
}

/**
 * Render a halt as an operator-facing message. Codes, byte counts and digests
 * only — this string lands in `WorkflowRun.errorMessage` and in an audit row,
 * so it must be safe to read in both.
 */
export function describeContextHalt(err: ContextIntegrityError): string {
    const parts: string[] = [`context integrity halt: ${err.code}`];
    if (err.detail.seq !== undefined) parts.push(`seq=${err.detail.seq}`);
    if (err.detail.bytes !== undefined) parts.push(`bytes=${err.detail.bytes}`);
    if (err.detail.cap !== undefined) parts.push(`cap=${err.detail.cap}`);
    if (err.detail.issueCount !== undefined) parts.push(`issues=${err.detail.issueCount}`);
    if (err.detail.issueFields?.length) parts.push(`fields=${err.detail.issueFields.join('|')}`);
    return parts.join(' ');
}
