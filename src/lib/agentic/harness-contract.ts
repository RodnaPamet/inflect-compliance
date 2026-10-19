/**
 * The wire contract `inflect-agent-harness/2` (#3754), and the refusal of the
 * retired `/1` (#3660, retired by #3686).
 *
 * ONE SOURCE OF TRUTH, three readers. `docs/agent-harness-contract.md` is what a
 * scanner is built against, `tests/helpers/agent-harness-fake-scanner.ts` is the
 * executable reference, and these schemas are what the ingest enforces. The suite
 * validates the fake scanner's output against these schemas, so the three cannot
 * drift apart silently. Same arrangement as `src/lib/mcp/client/contract.ts`.
 *
 * ‾‾‾ ONE ID, AND A RETIRED ONE ‾‾‾
 *
 * `/2` is `/1` plus the `code` source kind, the `UNPARSEABLE` reason, the
 * `unboundCredentials[]` member, and per agent an optional call count on each
 * tool and optional `models[]` endpoints (owner decisions, 2026-10-19). `/1` was
 * accepted beside it while a `/1` scanner could exist, and was retired at the
 * scanner container's release (#3686, owner decision 2026-10-19): a report that
 * names it is a `SCHEMA` refusal, and the ingest writes nothing. Scans already
 * stored from `/1` reports still read, because `/2`'s kinds and reasons
 * contain `/1`'s.
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
 * it — the contract id included: which schema applies is read only after the
 * signature verified. The signed message is SHA-256 over the canonical JSON of
 * the report with its `signature` member removed: the construction
 * `receipt-verification.ts` already uses for mediator receipts, through the
 * same `canonicalJson`.
 *
 * ‾‾‾ WHAT THE REPORT DELIBERATELY CANNOT SAY ‾‾‾
 *
 *   • A LEVEL. The report carries per-criterion verdicts; the ingest derives the
 *     level with `scoreHarness`. A scanner that could state its own conclusion
 *     would be trusted for the one number the product exists to compute.
 *   • A CREDENTIAL. Only a reference — a scheme-prefixed locator such as
 *     `kv://prod/agents/sales-bot` — is accepted, and a value with the shape of
 *     a secret is refused even inside one. That holds for an unbound
 *     credential exactly as for an agent's.
 *   • COMPLETENESS IT DID NOT ESTABLISH. Each source says COMPLETE or
 *     INCOMPLETE; INCOMPLETE must name a reason and COMPLETE may not carry one.
 *     Whether the scan as a whole was complete is derived, never declared.
 *   • A FINDING THE INGEST ACTS ON. `findings[]` is the scanner's own view and
 *     is not acted on. `/2`'s `unboundCredentials[]` is an observation, and the
 *     planner decides whether it is an ORPHAN_CREDENTIAL.
 *
 * PURE apart from `node:crypto`: no database, no clock, no network.
 */
import { createHash, verify as cryptoVerify } from 'crypto';
import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';
import { ed25519PublicKeyFromMaterial } from '@/lib/mcp/receipt-verification';

import {
    HARNESS_CONTRACT_V1,
    HARNESS_CONTRACT_V2,
    isScanComplete,
    looksLikeSecret,
    type HarnessContractId,
} from './harness-contract-rules';
import {
    ALL_HARNESS_CRITERIA,
    isHarnessCriterionId,
    type CriterionVerdict,
    type HarnessCriterionId,
} from './harness-ladder';
import type { HarnessAgentModels, StoredSource } from './harness-read-model';

export {
    HARNESS_CONTRACT_IDS,
    HARNESS_CONTRACT_V1,
    HARNESS_CONTRACT_V2,
    isScanComplete,
    looksLikeSecret,
    type HarnessContractId,
} from './harness-contract-rules';

// ─── Bounds. Stated here and enforced at the ingest's transport too. ───

/** The whole report, in bytes, before it is parsed. */
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
export const MAX_SOURCES = 50;
export const MAX_AGENTS = 5_000;
export const MAX_CREDENTIALS_PER_AGENT = 100;
export const MAX_TOOLS_PER_AGENT = 500;
export const MAX_SKILLS_PER_AGENT = 100;
export const MAX_FINDINGS = 20_000;
/** `/2`: credentials seen bound to no agent, across every source. */
export const MAX_UNBOUND_CREDENTIALS = 10_000;
/** `/2`: model endpoints per agent. */
export const MAX_MODELS_PER_AGENT = 50;
/** `/2`: a tool's call count, and the window it is counted over. */
export const MAX_TOOL_CALLS = 1_000_000_000;
export const MAX_WINDOW_DAYS = 366;
/** Identifiers, names and references. */
export const MAX_ID_CHARS = 256;
/** An evidence pointer: a path, a query, a resource locator. */
export const MAX_EVIDENCE_CHARS = 512;

/**
 * Where a scanner looks. Stable ids: the report and the matrix carry them. The
 * last, `code` (agent definitions read from source code and configuration,
 * #3737), is the one `/2` added; the rest were `/1`'s.
 */
export const SOURCE_KINDS_V2 = [
    'entra-sp',
    'okta-app',
    'vault',
    'mcp',
    'runtime',
    'cicd',
    'inflect-register',
    'code',
] as const;

/**
 * Every source kind a report this verifier accepts can carry, which is also
 * every kind a stored scan can hold, `/1` scans included. Stored scans are
 * re-read against it, and an estate may declare exactly these (the database
 * CHECKs the same list).
 */
export const SOURCE_KINDS = SOURCE_KINDS_V2;

/**
 * Why a source could not be read completely. The last, `UNPARSEABLE` (a
 * definition the scanner read but could not resolve), is the one `/2` added.
 */
export const INCOMPLETE_REASONS_V2 = [
    'BYTE_CAP',
    'TIME_BOX',
    'AUTH_FAILED',
    'UNREACHABLE',
    'PAGINATION_TORN',
    'RATE_LIMITED',
    'UNPARSEABLE',
] as const;

/** Every reason an accepted report, or a stored scan, can carry. */
export const INCOMPLETE_REASONS = INCOMPLETE_REASONS_V2;

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


const id = z.string().min(1).max(MAX_ID_CHARS);

const credentialRef = z
    .string()
    .regex(REFERENCE, 'a credential must be a scheme://locator reference, never a value')
    .refine((v) => !looksLikeSecret(v), 'a credential reference must not contain a secret-shaped value');

type Members = readonly [string, ...string[]];

/** One source, over one id's kinds and reasons. */
function sourceSchemaOver<const K extends Members, const R extends Members>(kinds: K, reasons: R) {
    return z
        .object({
            kind: z.enum(kinds),
            status: z.enum(['COMPLETE', 'INCOMPLETE']),
            reason: z.enum(reasons).optional(),
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
}

/**
 * A stored source, re-read against every kind and reason an accepted id can
 * carry. Not a wire schema: a report is held to the schema of its own id.
 */
export const HarnessSourceSchema = sourceSchemaOver(SOURCE_KINDS, INCOMPLETE_REASONS);

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

const toolMembers = {
    server: z.string().url().max(MAX_EVIDENCE_CHARS),
    name: id,
    manifestHash: z.string().regex(SHA256_HEX).nullable(),
    pinned: z.boolean(),
    /** As the server declares it. Unknown counts as a write. */
    readOnlyHint: z.boolean().nullable(),
};

/**
 * A tool: `/1`'s members, plus `/2`'s optional call count over a window (owner
 * decision, 2026-10-19). A count is a number of calls and nothing of what was
 * called with — no input, no output, no prompt. It means something only beside
 * its window, so the two come together or not at all.
 */
const ToolSchemaV2 = z
    .object({
        ...toolMembers,
        /** Calls of this tool by this agent over the last `windowDays`. */
        calls: z.number().int().min(0).max(MAX_TOOL_CALLS).optional(),
        windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).optional(),
    })
    .strict()
    .superRefine((t, ctx) => {
        if ((t.calls === undefined) !== (t.windowDays === undefined)) {
            ctx.addIssue({ code: 'custom', message: 'a call count and its window come together or not at all', path: ['calls'] });
        }
    });

/**
 * An endpoint as `/2` reports it: a `scheme://locator` (`https://api.openai.com/v1`,
 * `env://AZURE_OPENAI_ENDPOINT`) or a bare host, never a credential. A URL that
 * carries any userinfo is refused, not only one whose password has a known
 * shape: a reference to an endpoint has no business naming an account.
 */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;
const endpointRef = z
    .string()
    .min(1)
    .max(MAX_EVIDENCE_CHARS)
    .refine((v) => REFERENCE.test(v) || HOST.test(v), 'an endpoint is a scheme://locator or a host')
    .refine((v) => !/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*@/i.test(v), 'an endpoint reference must not carry userinfo')
    .refine((v) => !looksLikeSecret(v), 'an endpoint reference must not contain a secret-shaped value');

/**
 * `/2`: a model endpoint the agent calls (owner decision, 2026-10-19). A
 * reference and a model id — never a prompt, an input or an output.
 */
const ModelEndpointSchema = z
    .object({
        endpoint: endpointRef,
        /** The model's id at that endpoint, when the scanner knows it. */
        model: id.nullable(),
    })
    .strict();

const SkillSchema = z
    .object({
        name: id,
        license: id.nullable(),
        declared: z.boolean(),
    })
    .strict();

export const HarnessVerdictSchema = z
    .object({
        criterion: z.custom<HarnessCriterionId>(
            (v) => typeof v === 'string' && isHarnessCriterionId(v),
            'not a criterion the harness ladder defines',
        ),
        met: z.boolean(),
        evidence: z.string().min(1).max(MAX_EVIDENCE_CHARS).nullable(),
    })
    .strict();

/** The members every id's agent carries, over that id's kinds and tool. */
function agentMembersOver<const K extends Members, T extends z.ZodType>(kinds: K, tool: T) {
    return {
        discoveredId: id,
        discoveredVia: z.array(z.enum(kinds)).min(1).max(kinds.length),
        registeredAgentId: id.nullable(),
        owner: OwnerSchema.nullable(),
        credentials: z.array(CredentialSchema).max(MAX_CREDENTIALS_PER_AGENT),
        tools: z.array(tool).max(MAX_TOOLS_PER_AGENT),
        skills: z.array(SkillSchema).max(MAX_SKILLS_PER_AGENT),
        verdicts: z.array(HarnessVerdictSchema).max(ALL_HARNESS_CRITERIA.length * 2),
    };
}

/** `/2`'s agent: `/1`'s members over `/2`'s kinds and tool, and the optional `models[]`. */
const AgentSchemaV2 = z
    .object({
        ...agentMembersOver(SOURCE_KINDS_V2, ToolSchemaV2),
        models: z.array(ModelEndpointSchema).max(MAX_MODELS_PER_AGENT).optional(),
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

const ScanSchema = z
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
    .strict();

/** The members every id carries, over that id's kinds, reasons and agent. */
function bodyMembersOver<const C extends string, const K extends Members, const R extends Members, A extends z.ZodType>(
    contract: C,
    kinds: K,
    reasons: R,
    agent: A,
) {
    return {
        contract: z.literal(contract),
        scan: ScanSchema,
        population: z.object({ sources: z.array(sourceSchemaOver(kinds, reasons)).min(1).max(MAX_SOURCES) }).strict(),
        agents: z.array(agent).max(MAX_AGENTS),
        findings: z.array(FindingSchema).max(MAX_FINDINGS),
    };
}

/** The cross-member rules every id holds: one agent per `discoveredId`, one entry per source kind. */
function checkReportInvariants(
    r: {
        readonly agents: readonly { readonly discoveredId: string }[];
        readonly population: { readonly sources: readonly { readonly kind: string }[] };
    },
    ctx: z.RefinementCtx,
): void {
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
}

/**
 * `/2`: a credential the scanner saw bound to NO discovered agent, by
 * reference, with the source kind that saw it. The ingest derives
 * ORPHAN_CREDENTIAL from these; the scanner does not raise it.
 */
const UnboundCredentialSchema = z
    .object({
        ref: credentialRef,
        sourceKind: z.enum(SOURCE_KINDS_V2),
    })
    .strict();

/**
 * The `/2` rules on `unboundCredentials[]`. Each one refuses a report that
 * contradicts itself, because a report that does is no ground for a finding:
 *
 *   • each (source, reference) pair once;
 *   • the source that saw it is one the report lists — a credential seen by a
 *     source the scanner did not report reading is a claim with no read behind it;
 *   • it is held by no agent in the same report — "bound to no agent" and
 *     "this agent's credential" cannot both be true.
 */
function checkUnboundCredentials(
    r: {
        readonly agents: readonly { readonly credentials: readonly { readonly ref: string }[] }[];
        readonly population: { readonly sources: readonly { readonly kind: string }[] };
        readonly unboundCredentials: readonly { readonly ref: string; readonly sourceKind: string }[];
    },
    ctx: z.RefinementCtx,
): void {
    const listed = new Set(r.population.sources.map((s) => s.kind));
    const held = new Set(r.agents.flatMap((a) => a.credentials.map((c) => c.ref)));
    const seen = new Set<string>();
    r.unboundCredentials.forEach((u, i) => {
        const key = `${u.sourceKind}\u0000${u.ref}`;
        if (seen.has(key)) {
            ctx.addIssue({ code: 'custom', message: 'each unbound credential appears once per source', path: ['unboundCredentials', i] });
        }
        seen.add(key);
        if (!listed.has(u.sourceKind)) {
            ctx.addIssue({
                code: 'custom',
                message: 'an unbound credential must name a source the report lists',
                path: ['unboundCredentials', i, 'sourceKind'],
            });
        }
        if (held.has(u.ref)) {
            ctx.addIssue({
                code: 'custom',
                message: 'a credential an agent in this report holds is not unbound',
                path: ['unboundCredentials', i, 'ref'],
            });
        }
    });
}

/** `inflect-agent-harness/2`, everything the signature covers: `/1`'s members over `/2`'s lists, and `unboundCredentials[]`. */
export const HarnessReportBodyV2Schema = z
    .object({
        ...bodyMembersOver(HARNESS_CONTRACT_V2, SOURCE_KINDS_V2, INCOMPLETE_REASONS_V2, AgentSchemaV2),
        unboundCredentials: z.array(UnboundCredentialSchema).max(MAX_UNBOUND_CREDENTIALS),
    })
    .strict()
    .superRefine((r, ctx) => {
        checkReportInvariants(r, ctx);
        checkUnboundCredentials(r, ctx);
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

export type HarnessReportBodyV2 = z.infer<typeof HarnessReportBodyV2Schema>;
/** A verified report. `/2` is the one id the verifier accepts. */
export type HarnessReportBody = HarnessReportBodyV2;
export type HarnessReportAgentV2 = HarnessReportBodyV2['agents'][number];
export type HarnessReportAgent = HarnessReportAgentV2;
export type HarnessUnboundCredential = HarnessReportBodyV2['unboundCredentials'][number];
export type HarnessModelEndpoint = NonNullable<HarnessReportAgentV2['models']>[number];
export type HarnessSignature = z.infer<typeof HarnessSignatureSchema>;

/** The strict schema for each accepted id. A Map, so no prototype key can name one. */
const BODY_SCHEMA_BY_ID: ReadonlyMap<HarnessContractId, z.ZodType<HarnessReportBody>> = new Map<
    HarnessContractId,
    z.ZodType<HarnessReportBody>
>([[HARNESS_CONTRACT_V2, HarnessReportBodyV2Schema]]);

/** The schema for the id a body names, or null when it names none this verifier accepts. */
function bodySchemaFor(body: Record<string, unknown>): z.ZodType<HarnessReportBody> | null {
    const contract = body.contract;
    if (typeof contract !== 'string') return null;
    return BODY_SCHEMA_BY_ID.get(contract as HarnessContractId) ?? null;
}

/** The bytes a scanner signs: SHA-256 over the canonical JSON of the body. */
export function harnessSignedMessage(body: unknown): Buffer {
    return createHash('sha256').update(canonicalJson(body), 'utf8').digest();
}


// ─── Reading back what the ingest stored ───
//
// `sourcesJson` and `verdictsJson` are written by the ingest from a body that
// passed the strict schema, so on the happy path re-parsing them is a no-op. It
// is done anyway because a JSON column is not a type: a row edited by hand, or
// written by an older build, must read as UNREADABLE — and every reader treats
// unreadable as the unfavourable answer (an incomplete scan, an unmet
// criterion) rather than trusting a shape it did not check.

/**
 * A scan's stored sources, re-validated against the contract (strict, each kind
 * once, at least one). The row does not record which id the report spoke, and
 * rows from `/1` reports remain after its retirement, so it is read against
 * `/2`'s kinds and reasons, which contain `/1`'s: either id's scan reads back
 * as written. `null` is "could not
 * be read" — never an empty list, because zero sources would read as a scan
 * that looked nowhere and found it clean.
 */
export function parseStoredHarnessSources(json: unknown): StoredSource[] | null {
    const parsed = z.array(HarnessSourceSchema).min(1).max(MAX_SOURCES).safeParse(json);
    if (!parsed.success) return null;
    const kinds = parsed.data.map((s) => s.kind);
    if (new Set(kinds).size !== kinds.length) return null;
    return parsed.data.map((s) => ({ kind: s.kind, status: s.status, rows: s.rows, reason: s.reason ?? null }));
}

/** One scan item's stored verdicts, re-validated. `null` is "could not be read". */
export function parseStoredHarnessVerdicts(json: unknown): CriterionVerdict[] | null {
    const parsed = z.array(HarnessVerdictSchema).max(ALL_HARNESS_CRITERIA.length * 2).safeParse(json);
    return parsed.success ? parsed.data : null;
}

/**
 * One tool as a scan item stores it: identifiers, a hash, two flags and, from a
 * `/2` report, a call count with its window — never a description.
 */
export type StoredHarnessTool = z.infer<typeof ToolSchemaV2>;

/**
 * One scan item's stored tools, re-validated against `/2`'s tool, which every
 * `/1` tool also is. `null` is "could not be read", never "no tools".
 */
export function parseStoredHarnessTools(json: unknown): StoredHarnessTool[] | null {
    const parsed = z.array(ToolSchemaV2).max(MAX_TOOLS_PER_AGENT).safeParse(json);
    return parsed.success ? parsed.data : null;
}

/**
 * One scan item's stored model endpoints (#3759), re-validated against `/2`'s
 * strict model schema: the endpoint's reference shape, no userinfo, no
 * secret's shape, no member the contract does not define, and at most
 * `MAX_MODELS_PER_AGENT`.
 *
 * `null` — the column's NULL — is NOT_REPORTED: the ingest writes NULL for an
 * agent reported without `models`, and wrote it for every agent of a `/1`
 * scan while that id was accepted. A value that does not
 * re-validate is UNREADABLE, never NOT_REPORTED and never an empty list: an
 * edited row must not read as "this agent calls no model".
 */
export function parseStoredHarnessModels(json: unknown): HarnessAgentModels {
    if (json === null || json === undefined) return { state: 'NOT_REPORTED' };
    const parsed = z.array(ModelEndpointSchema).max(MAX_MODELS_PER_AGENT).safeParse(json);
    if (!parsed.success) return { state: 'UNREADABLE' };
    return { state: 'REPORTED', endpoints: parsed.data.map((m) => ({ endpoint: m.endpoint, model: m.model })) };
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
 * signature by a TRUSTED key, then the strict schema OF THE ID THE REPORT
 * NAMES. `trustedSignerKeys` are the public keys of scanners registered for
 * this tenant; a report signed by any other key is refused even if its
 * signature is mathematically valid. A report naming the retired `/1` passes
 * the first three steps like any other, and is refused at the fourth.
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

    // Which schema applies is itself body content, so it is read only now. An
    // id this verifier does not accept is a SCHEMA refusal that names the
    // member, never the value the signer put there. The retired `/1` is named,
    // because the name is this module's constant rather than the signer's text,
    // and it tells the operator what to do: upgrade the scanner.
    const bodySchema = bodySchemaFor(body);
    if (bodySchema === null) {
        const issue = body.contract === HARNESS_CONTRACT_V1
            ? `contract: ${HARNESS_CONTRACT_V1} is retired; the scanner must speak ${HARNESS_CONTRACT_V2}`
            : 'contract: not a contract id this verifier accepts';
        return { ok: false, reason: 'SCHEMA', issues: [issue] };
    }
    const schema = bodySchema.safeParse(body);
    if (!schema.success) {
        return { ok: false, reason: 'SCHEMA', issues: schema.error.issues.map(describeSchemaIssue) };
    }
    return { ok: true, body: schema.data, signerKey, complete: isScanComplete(schema.data) };
}
