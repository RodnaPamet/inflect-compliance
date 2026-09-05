/**
 * pipelock CORE action-receipt verification (Apache-2.0 receipt format).
 *
 * pipelock (github.com/luckyPipewrench/pipelock) is an external "AI agent
 * firewall for MCP security" daemon that mediates agent tool calls and emits a
 * mediator-signed **action receipt** per decision. We ingest those receipts as
 * externally-verifiable evidence. The receipt's Ed25519 signature is VERIFIED
 * here, in-app, BEFORE the row is trusted or linked to the audit chain.
 *
 * ── License boundary ──────────────────────────────────────────────────────
 * We use ONLY the Apache-2.0 CORE receipt shape (`action_record` + top-level
 * `signature` / `signer_key` / chain fields). We deliberately do NOT touch the
 * Elastic-License-2.0 "fleet" feature or its `fleet-receipt` DSSE envelope.
 *
 * ── No npm SDK ────────────────────────────────────────────────────────────
 * pipelock ships a Go CLI + WASM verifier — there is no TypeScript verifier on
 * npm. Adding a phantom dependency would be worse than none, so we verify the
 * Ed25519 signature natively with Node's `crypto` (Node supports ed25519 via
 * `crypto.verify(null, message, keyObject, signature)`).
 *
 * ── Canonicalization assumption ───────────────────────────────────────────
 * pipelock's public docs (docs/guides/receipt-verification.md) state the signed
 * content is "SHA-256(canonical JSON of action_record)" but do NOT pin the exact
 * canonical form (key ordering / whitespace). We therefore implement a single,
 * clearly-documented canonical form — recursive **sorted-key, no-whitespace
 * JSON** of `action_record`, hashed with SHA-256 — behind the ONE swappable
 * function `canonicalizeActionRecord()`. If pipelock later publishes an exact
 * spec (or conformance vectors under sdk/conformance/testdata/), swap the body
 * of that one function; nothing else changes. See the implementation note
 * docs/implementation-notes/2026-07-03-agent-action-receipts.md.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'crypto';
import { z } from 'zod';

import { redactSensitiveFields } from '@/lib/audit-redact';
import { canonicalJson } from '@/lib/canonical-json';

// ── Receipt shape (pipelock CORE) ──────────────────────────────────────────

/**
 * The pipelock CORE receipt as posted to our ingest endpoint. `action_record`
 * is the signed decision container; its inner field names are not fully pinned
 * by pipelock docs, so we accept an open object and extract best-effort.
 */
export const PipelockReceiptSchema = z.object({
    /** The signed decision container. Signature covers the canonical form of THIS. */
    action_record: z.record(z.string(), z.unknown()),
    /** Ed25519 signature, `ed25519:<hex>` (or bare hex/base64). */
    signature: z.string().min(1),
    /** Signer PUBLIC key — hex or base64 of the raw 32-byte Ed25519 key. */
    signer_key: z.string().min(1),
    /** Hash-chain sequence (pipelock's own chain — informational here). */
    chain_seq: z.number().int().optional(),
    /** Prior receipt hash in pipelock's chain (informational). */
    chain_prev_hash: z.string().nullish(),
    /** Binds the receipt to a process run (added in later pipelock versions). */
    run_nonce: z.string().optional(),
});

export type PipelockReceipt = z.infer<typeof PipelockReceiptSchema>;

/** Fields extracted from a receipt for storage + display. */
export interface ExtractedReceiptFields {
    toolName: string;
    decisionVerdict: string;
    activePolicy: string | null;
    agentId: string | null;
    occurredAt: Date;
    signature: string;
    signerKey: string;
}

// ── Canonicalization (the single swappable seam) ────────────────────────────

/**
 * Deterministic canonical JSON: recursively sorts object keys, no whitespace.
 * Arrays keep order (order is semantic). This is the documented assumption for
 * pipelock's "canonical JSON of action_record" — see the module header.
 *
 * The body is `canonicalJson` from `@/lib/canonical-json` and not a copy of it,
 * because the tool-manifest pin hashes schemas through the same form. Two
 * implementations that merely look alike drift on the first edit, and the drift
 * would surface here as a receipt signature that stops verifying.
 */
export function canonicalizeActionRecord(actionRecord: unknown): string {
    return canonicalJson(actionRecord);
}

/**
 * The exact byte message the Ed25519 signature is verified against:
 * SHA-256(canonical JSON of action_record). Isolated so the "sign over the
 * digest vs sign over raw bytes" decision lives in ONE place — the in-test
 * signer and this verifier both call it, so they always agree.
 */
export function receiptSignedMessage(actionRecord: unknown): Buffer {
    const canonical = canonicalizeActionRecord(actionRecord);
    return createHash('sha256').update(canonical, 'utf8').digest();
}

// ── Key + signature decoding ────────────────────────────────────────────────

/** ASN.1/DER SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Decode hex or base64 into bytes. Hex is tried first (receipts use hex). */
function decodeKeyMaterial(input: string): Buffer | null {
    const trimmed = input.trim();
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        return Buffer.from(trimmed, 'hex');
    }
    try {
        const b = Buffer.from(trimmed, 'base64');
        if (b.length > 0) return b;
    } catch {
        return null;
    }
    return null;
}

/** Build a Node KeyObject from a raw 32-byte Ed25519 public key (hex/base64). */
export function ed25519PublicKeyFromMaterial(material: string): KeyObject | null {
    const raw = decodeKeyMaterial(material);
    if (!raw || raw.length !== 32) return null;
    try {
        return createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
            format: 'der',
            type: 'spki',
        });
    } catch {
        return null;
    }
}

/** Decode a signature that may carry an `ed25519:` prefix; returns 64 bytes. */
function decodeSignature(signature: string): Buffer | null {
    const stripped = signature.startsWith('ed25519:') ? signature.slice('ed25519:'.length) : signature;
    const sig = decodeKeyMaterial(stripped);
    if (!sig || sig.length !== 64) return null;
    return sig;
}

// ── Verification ────────────────────────────────────────────────────────────

export interface VerifyReceiptResult {
    valid: boolean;
    /** Machine-readable reason on failure (never surfaces secrets). */
    reason?: string;
    /** The signer key identifier we recorded (the receipt's signer_key). */
    signingKeyId: string;
}

/**
 * Verify a pipelock receipt's Ed25519 signature against the CONFIGURED trusted
 * public key. The receipt's own `signer_key` is NOT trusted as the verification
 * key (that would let anyone sign with any key) — it is only cross-checked
 * against the configured key and recorded for the audit trail. If no configured
 * key is supplied, verification fails closed (`no_configured_key`).
 */
export function verifyReceiptSignature(
    receipt: PipelockReceipt,
    configuredPublicKey: string | undefined | null,
): VerifyReceiptResult {
    const signingKeyId = receipt.signer_key;

    if (!configuredPublicKey || configuredPublicKey.trim() === '') {
        return { valid: false, reason: 'no_configured_key', signingKeyId };
    }

    const trustedKey = ed25519PublicKeyFromMaterial(configuredPublicKey);
    if (!trustedKey) {
        return { valid: false, reason: 'invalid_configured_key', signingKeyId };
    }

    // Cross-check: the receipt must claim to be signed by the key we trust.
    const receiptKeyRaw = decodeKeyMaterial(receipt.signer_key);
    const trustedKeyRaw = decodeKeyMaterial(configuredPublicKey);
    if (receiptKeyRaw && trustedKeyRaw && !receiptKeyRaw.equals(trustedKeyRaw)) {
        return { valid: false, reason: 'signer_key_mismatch', signingKeyId };
    }

    const sig = decodeSignature(receipt.signature);
    if (!sig) {
        return { valid: false, reason: 'malformed_signature', signingKeyId };
    }

    let ok = false;
    try {
        ok = cryptoVerify(null, receiptSignedMessage(receipt.action_record), trustedKey, sig);
    } catch {
        return { valid: false, reason: 'verify_threw', signingKeyId };
    }

    return ok
        ? { valid: true, signingKeyId }
        : { valid: false, reason: 'signature_invalid', signingKeyId };
}

// ── scannedSummary bounding + scrubbing ─────────────────────────────────────

/** Hard cap on the serialized scannedSummary (bytes). Anything larger is dropped. */
export const SCANNED_SUMMARY_MAX_BYTES = 8 * 1024;

/**
 * Produce a BOUNDED, scrubbed summary safe to persist: credential/PII field
 * names are redacted (via the shared audit redactor), large blobs summarized,
 * and the whole thing size-capped. NEVER stores raw request/response payloads.
 */
export function boundAndScrubSummary(raw: unknown): Record<string, unknown> {
    const source: Record<string, unknown> =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : { value: raw };

    const scrubbed = redactSensitiveFields(source) ?? {};

    // Size-cap: if the scrubbed object serializes beyond the budget, drop it to
    // a tripwire marker rather than persist an oversized (possibly leaky) blob.
    let serialized: string;
    try {
        serialized = JSON.stringify(scrubbed);
    } catch {
        return { _dropped: true, reason: 'unserializable' };
    }
    if (Buffer.byteLength(serialized, 'utf8') > SCANNED_SUMMARY_MAX_BYTES) {
        return {
            _capped: true,
            reason: 'oversize',
            bytes: Buffer.byteLength(serialized, 'utf8'),
            sha256: createHash('sha256').update(serialized).digest('hex'),
        };
    }
    return scrubbed;
}

// ── Field extraction ────────────────────────────────────────────────────────

function firstString(rec: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
        const v = rec[k];
        if (typeof v === 'string' && v.trim() !== '') return v;
    }
    return null;
}

/**
 * Extract our storage fields from a receipt. Inner `action_record` field names
 * are not fully pinned by pipelock docs, so each field tries a list of plausible
 * names with a safe fallback.
 */
export function extractReceiptFields(receipt: PipelockReceipt): ExtractedReceiptFields {
    const rec = receipt.action_record;
    const toolName = firstString(rec, ['tool', 'tool_name', 'toolName', 'action', 'method']) ?? 'unknown';
    const decisionVerdict = firstString(rec, ['verdict', 'decision', 'action_taken', 'result']) ?? 'unknown';
    const activePolicy = firstString(rec, ['policy', 'active_policy', 'activePolicy', 'policy_hash', 'policy_id']);
    const agentId =
        firstString(rec, ['agent_id', 'agentId', 'run_id', 'runId']) ?? receipt.run_nonce ?? null;

    const tsRaw = firstString(rec, ['timestamp', 'ts', 'occurred_at', 'occurredAt', 'time']);
    const parsed = tsRaw ? new Date(tsRaw) : null;
    const occurredAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();

    return {
        toolName,
        decisionVerdict,
        activePolicy,
        agentId,
        occurredAt,
        signature: receipt.signature,
        signerKey: receipt.signer_key,
    };
}
