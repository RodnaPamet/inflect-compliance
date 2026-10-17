/**
 * The wire contract `inflect-agent-harness/1` (#3660).
 *
 * ONE SOURCE OF TRUTH, three readers. `docs/agent-harness-contract.md` is what a
 * scanner is built against, `tests/helpers/agent-harness-fake-scanner.ts` is the
 * executable reference, and these schemas are what the ingest enforces. The suite
 * validates the fake scanner's output against these schemas, so the three cannot
 * drift apart silently. Same arrangement as `src/lib/mcp/client/contract.ts`.
 *
 * ‾‾‾ THE REPORT ARRIVES FROM OUTSIDE ‾‾‾
 *
 * The scanner runs in the CLIENT's environment. Even when it is our code, the
 * bytes cross a network from a machine we do not operate, so every dimension
 * that can grow has a stated maximum and every object is strict: an unknown key
 * is a refusal, not an omission. A field this contract does not define is one
 * the ingest would silently drop, and a scanner relying on it would be reporting
 * something nobody reads.
 *
 * ‾‾‾ VERIFY, THEN PARSE ‾‾‾
 *
 * `verifyAndParseHarnessReport` checks the byte cap, then that the body is JSON,
 * then the SIGNATURE, and only then the schema. Nothing about the report's
 * content is trusted, or even interpreted, before a trusted key has vouched for
 * it. The signed message is SHA-256 over the canonical JSON of the report with
 * its `signature` member removed: the construction `receipt-verification.ts`
 * already uses for mediator receipts, through the same `canonicalJson`.
 *
 * ‾‾‾ WHAT THE REPORT DELIBERATELY CANNOT SAY ‾‾‾
 *
 *   • A LEVEL. The report carries per-criterion verdicts; the ingest derives the
 *     level with `scoreHarness`. A scanner that could state its own conclusion
 *     would be trusted for the one number the product exists to compute.
 *   • A CREDENTIAL. Only a reference — a scheme-prefixed locator such as
 *     `kv://prod/agents/sales-bot` — is accepted, and a value with the shape of
 *     a secret is refused even inside one.
 *   • COMPLETENESS IT DID NOT ESTABLISH. Each source says COMPLETE or
 *     INCOMPLETE; INCOMPLETE must name a reason and COMPLETE may not carry one.
 *     Whether the scan as a whole was complete is derived, never declared.
 *
 * PURE apart from `node:crypto`: no database, no clock, no network.
 */
import { createHash, verify as cryptoVerify } from 'crypto';
import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';
import { ed25519PublicKeyFromMaterial } from '@/lib/mcp/receipt-verification';

import { ALL_HARNESS_CRITERIA, isHarnessCriterionId, type HarnessCriterionId } from './harness-ladder';

export const HARNESS_CONTRACT_ID = 'inflect-agent-harness/1';

// ─── Bounds. Stated here and enforced at the ingest's transport too. ───

/** The whole report, in bytes, before it is parsed. */
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
export const MAX_SOURCES = 50;
export const MAX_AGENTS = 5_000;
export const MAX_CREDENTIALS_PER_AGENT = 100;
export const MAX_TOOLS_PER_AGENT = 500;
export const MAX_SKILLS_PER_AGENT = 100;
export const MAX_FINDINGS = 20_000;
/** Identifiers, names and references. */
export const MAX_ID_CHARS = 256;
/** An evidence pointer: a path, a query, a resource locator. */
export const MAX_EVIDENCE_CHARS = 512;

/** Where the scanner looked. Stable ids: the report and the matrix carry them. */
export const SOURCE_KINDS = [
    'entra-sp',
    'okta-app',
    'vault',
    'mcp',
    'runtime',
    'cicd',
    'inflect-register',
] as const;

/** Why a source could not be read completely. */
export const INCOMPLETE_REASONS = [
    'BYTE_CAP',
    'TIME_BOX',
    'AUTH_FAILED',
    'UNREACHABLE',
    'PAGINATION_TORN',
    'RATE_LIMITED',
] as const;

export const FINDING_CODES = [
    'SHADOW_AGENT',
    'UNPINNED_WRITE_TOOL',
    'ORPHAN_CREDENTIAL',
    'INCOMPLETE_SOURCE',
] as const;

const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;

/**
 * A credential REFERENCE: `scheme://locator`, no whitespace. A raw value has no
 * scheme and fails here before the secret-shape check below ever runs.
 */
const REFERENCE = /^[a-z][a-z0-9+.-]{1,31}:\/\/\S{1,480}$/;

/**
 * Shapes that are a secret wherever they appear, including inside something
 * that otherwise looks like a reference. Deliberately short: a false refusal
 * names itself and costs a scanner fix; a false acceptance puts a credential in
 * a tenant's database.
 */
const SECRET_SHAPES: readonly RegExp[] = [
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /xox[abpors]-[A-Za-z0-9-]{10,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

export function looksLikeSecret(value: string): boolean {
    return SECRET_SHAPES.some((re) => re.test(value));
}

const id = z.string().min(1).max(MAX_ID_CHARS);
const sourceKind = z.enum(SOURCE_KINDS);

const credentialRef = z
    .string()
    .regex(REFERENCE, 'a credential must be a scheme://locator reference, never a value')
    .refine((v) => !looksLikeSecret(v), 'a credential reference must not contain a secret-shaped value');

const SourceSchema = z
    .object({
        kind: sourceKind,
        status: z.enum(['COMPLETE', 'INCOMPLETE']),
        reason: z.enum(INCOMPLETE_REASONS).optional(),
        rows: z.number().int().min(0),
    })
    .strict()
    .superRefine((s, ctx) => {
        if (s.status === 'INCOMPLETE' && s.reason === undefined) {
            ctx.addIssue({ code: 'custom', message: 'an INCOMPLETE source must name its reason', path: ['reason'] });
        }
        if (s.status === 'COMPLETE' && s.reason !== undefined) {
            ctx.addIssue({ code: 'custom', message: 'a COMPLETE source cannot carry an incompleteness reason', path: ['reason'] });
        }
    });

const OwnerSchema = z
    .object({
        kind: z.enum(['user', 'group']),
        id,
        /** Where the scanner read it, e.g. `entra-owner-tag`. */
        source: id,
    })
    .strict();

const CredentialSchema = z
    .object({
        ref: credentialRef,
        ageDays: z.number().int().min(0).nullable(),
        expires: z.boolean().nullable(),
        boundToAgent: z.boolean(),
        /** Whether a named person bounds what the credential can reach. */
        grant: z.enum(['delegated', 'app-only', 'unknown']),
    })
    .strict();

const ToolSchema = z
    .object({
        server: z.string().url().max(MAX_EVIDENCE_CHARS),
        name: id,
        manifestHash: z.string().regex(SHA256_HEX).nullable(),
        pinned: z.boolean(),
        /** As the server declares it. Unknown counts as a write. */
        readOnlyHint: z.boolean().nullable(),
    })
    .strict();

const SkillSchema = z
    .object({
        name: id,
        license: id.nullable(),
        declared: z.boolean(),
    })
    .strict();

const VerdictSchema = z
    .object({
        criterion: z.custom<HarnessCriterionId>(
            (v) => typeof v === 'string' && isHarnessCriterionId(v),
            'not a criterion the harness ladder defines',
        ),
        met: z.boolean(),
        evidence: z.string().min(1).max(MAX_EVIDENCE_CHARS).nullable(),
    })
    .strict();

const AgentSchema = z
    .object({
        discoveredId: id,
        discoveredVia: z.array(sourceKind).min(1).max(SOURCE_KINDS.length),
        registeredAgentId: id.nullable(),
        owner: OwnerSchema.nullable(),
        credentials: z.array(CredentialSchema).max(MAX_CREDENTIALS_PER_AGENT),
        tools: z.array(ToolSchema).max(MAX_TOOLS_PER_AGENT),
        skills: z.array(SkillSchema).max(MAX_SKILLS_PER_AGENT),
        verdicts: z.array(VerdictSchema).max(ALL_HARNESS_CRITERIA.length * 2),
    })
    .strict();

const FindingSchema = z
    .object({
        code: z.enum(FINDING_CODES),
        discoveredId: id.nullable(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        /** A pointer, never prose: what to look at, not what it says. */
        evidence: z.string().min(1).max(MAX_EVIDENCE_CHARS).nullable(),
    })
    .strict();

/** The report body: everything the signature covers. */
export const HarnessReportBodySchema = z
    .object({
        contract: z.literal(HARNESS_CONTRACT_ID),
        scan: z
            .object({
                id,
                asOf: z.string().datetime(),
                scanner: z
                    .object({
                        agentId: id,
                        version: id,
                        manifestHash: z.string().regex(SHA256_HEX),
                    })
                    .strict(),
            })
            .strict(),
        population: z
            .object({ sources: z.array(SourceSchema).min(1).max(MAX_SOURCES) })
            .strict(),
        agents: z.array(AgentSchema).max(MAX_AGENTS),
        findings: z.array(FindingSchema).max(MAX_FINDINGS),
    })
    .strict()
    .superRefine((r, ctx) => {
        const seen = new Set<string>();
        r.agents.forEach((a, i) => {
            if (seen.has(a.discoveredId)) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'discoveredId must be unique within a report',
                    path: ['agents', i, 'discoveredId'],
                });
            }
            seen.add(a.discoveredId);
        });
        const kinds = r.population.sources.map((s) => s.kind);
        if (new Set(kinds).size !== kinds.length) {
            ctx.addIssue({ code: 'custom', message: 'each source kind appears once', path: ['population', 'sources'] });
        }
    });

export const HarnessSignatureSchema = z
    .object({
        alg: z.literal('ed25519'),
        /** The scanner's raw 32-byte public key, hex or base64. */
        signerKey: z.string().min(1).max(MAX_ID_CHARS),
        /** Hex or base64 Ed25519 signature over `harnessSignedMessage(body)`. */
        sig: z.string().min(1).max(MAX_ID_CHARS),
    })
    .strict();

export type HarnessReportBody = z.infer<typeof HarnessReportBodySchema>;
export type HarnessReportAgent = HarnessReportBody['agents'][number];
export type HarnessSignature = z.infer<typeof HarnessSignatureSchema>;

/** The bytes a scanner signs: SHA-256 over the canonical JSON of the body. */
export function harnessSignedMessage(body: unknown): Buffer {
    return createHash('sha256').update(canonicalJson(body), 'utf8').digest();
}

/** Is the scan complete? Derived from its sources, never declared. */
export function isScanComplete(body: Pick<HarnessReportBody, 'population'>): boolean {
    return body.population.sources.length > 0 && body.population.sources.every((s) => s.status === 'COMPLETE');
}

/** Why a report was refused. Stable codes: the ingest records them. */
export type HarnessRefusal =
    | 'TOO_LARGE'
    | 'NOT_JSON'
    | 'NOT_AN_OBJECT'
    | 'UNSIGNED'
    | 'MALFORMED_SIGNATURE'
    | 'UNTRUSTED_SIGNER'
    | 'BAD_SIGNATURE'
    | 'SCHEMA';

export type HarnessParseResult =
    | { ok: true; body: HarnessReportBody; signerKey: string; complete: boolean }
    | { ok: false; reason: HarnessRefusal; issues?: string[] };

function decodeSignature(sig: string): Buffer | null {
    const t = sig.trim();
    if (/^[0-9a-fA-F]{128}$/.test(t)) return Buffer.from(t, 'hex');
    if (/^[A-Za-z0-9+/]{86}={0,2}$/.test(t)) {
        const b = Buffer.from(t, 'base64');
        return b.length === 64 ? b : null;
    }
    return null;
}

function sameKeyMaterial(a: string, b: string): boolean {
    const ka = ed25519PublicKeyFromMaterial(a);
    const kb = ed25519PublicKeyFromMaterial(b);
    if (!ka || !kb) return false;
    return ka.export({ type: 'spki', format: 'der' }).equals(kb.export({ type: 'spki', format: 'der' }));
}

/**
 * A key's identity independent of its spelling: SHA-256 over its SPKI DER, the
 * same form `sameKeyMaterial` compares. Hex and base64 spellings of one key
 * share a fingerprint, so a tenant cannot register one key twice. Null when the
 * material is not an Ed25519 public key.
 */
export function harnessKeyFingerprint(material: string): string | null {
    const key = ed25519PublicKeyFromMaterial(material);
    if (!key) return null;
    return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

/**
 * One schema issue as refusal text that carries nothing of the body.
 *
 * The refusal reaches the caller and, through the API wrapper, the error log
 * and the trace span, so it must not repeat what the report contained. Zod's
 * message for an unknown key NAMES the key, and a key is body content the
 * signer chose: a secret-shaped name would be logged verbatim. Unknown keys are
 * therefore counted, never named; any other message that still matches a
 * secret shape falls back to the issue code.
 */
function describeSchemaIssue(issue: z.core.$ZodIssue): string {
    const path = issue.path.join('.') || '(root)';
    if (issue.code === 'unrecognized_keys') {
        const n = issue.keys.length;
        return `${path}: ${n} unrecognized key${n === 1 ? '' : 's'}`;
    }
    return looksLikeSecret(issue.message) ? `${path}: ${issue.code}` : `${path}: ${issue.message}`;
}

/**
 * Check a raw report against the contract, in the only safe order: size, JSON,
 * signature by a TRUSTED key, then schema. `trustedSignerKeys` are the public
 * keys of scanners registered for this tenant; a report signed by any other
 * key is refused even if its signature is mathematically valid.
 */
export function verifyAndParseHarnessReport(
    raw: string,
    trustedSignerKeys: readonly string[],
): HarnessParseResult {
    if (Buffer.byteLength(raw, 'utf8') > MAX_REPORT_BYTES) return { ok: false, reason: 'TOO_LARGE' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'NOT_JSON' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'NOT_AN_OBJECT' };
    }

    const { signature, ...body } = parsed as Record<string, unknown>;
    if (signature === undefined) return { ok: false, reason: 'UNSIGNED' };
    const sigParse = HarnessSignatureSchema.safeParse(signature);
    if (!sigParse.success) return { ok: false, reason: 'MALFORMED_SIGNATURE' };
    const { signerKey, sig } = sigParse.data;

    if (!trustedSignerKeys.some((k) => sameKeyMaterial(k, signerKey))) {
        return { ok: false, reason: 'UNTRUSTED_SIGNER' };
    }
    const key = ed25519PublicKeyFromMaterial(signerKey);
    const sigBytes = decodeSignature(sig);
    if (!key || !sigBytes) return { ok: false, reason: 'MALFORMED_SIGNATURE' };

    let valid = false;
    try {
        valid = cryptoVerify(null, harnessSignedMessage(body), key, sigBytes);
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, reason: 'BAD_SIGNATURE' };

    const schema = HarnessReportBodySchema.safeParse(body);
    if (!schema.success) {
        return { ok: false, reason: 'SCHEMA', issues: schema.error.issues.map(describeSchemaIssue) };
    }
    return { ok: true, body: schema.data, signerKey, complete: isScanComplete(schema.data) };
}
