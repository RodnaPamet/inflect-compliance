/**
 * THE INTEGRATION PASSPORT (#3672) — one record per external agent connection,
 * built from rows the product already stores.
 *
 * `docs/integration-passport.md` is the specification: which connections have a
 * passport (`mcp-server` ones, enabled or not), the twelve fields and where each
 * is read from, and what a passport never contains. This module is the builder
 * over exactly those fields, the canonical form two weeks are compared in, and
 * the evidence body a week's passports are emitted as. The drift rules live
 * beside it in `integration-passport-drift.ts`.
 *
 * PURE: no clock, no I/O, no Prisma. The usecase reads the rows, decrypts the
 * connection secret once and hands both in; everything here is a function of
 * its arguments, so a passport emitted in October re-derives byte for byte when
 * an auditor reads it in March.
 *
 * ── WHAT LEAVES THE BUILDER ─────────────────────────────────────────────────
 *
 * The decrypted secret goes into `resolveMcpCredentials`, the resolver the
 * runtime and the Test button use, and only the resolved KIND comes out. The
 * resolver's return value carries the client secret and the refresh token; it
 * is read for `.kind` and dropped in the same expression. No secret value, and
 * no hash of one, enters a passport.
 *
 * ── WHO READS A PASSPORT, AND SO WHAT IT MAY HOLD ───────────────────────────
 *
 * A week's passports are Evidence, readable by every role that reads evidence
 * (READER and AUDITOR included) and through the share link of an audit pack
 * that includes it. That is the
 * point of evidence, and it is why a passport carries identifiers and hashes
 * and nothing that would be a secret in other hands. The endpoint (P1) is the
 * one field where that took a decision: a URL can carry a credential in its
 * path or query (`https://mcp.vendor.com/s/<key>/mcp`), and `configJson.url`
 * is otherwise read only under `admin.manage`. So the passport holds the URL's
 * ORIGIN — where the stored credential is presented — and a keyed digest of
 * the whole URL (`keyedChangeDigest`, computed by the usecase), which detects
 * any change without holding the value or letting a reader test a guess.
 *
 * Every row type below is the COMPLETE set of fields the builder may read. The
 * parameter-set row has no `parameters`, `pendingParameters` or `openFields`,
 * and the pin row has no description or schema text: a field that should not
 * be in a passport is excluded by not being declared here. The builder also
 * picks each field by name rather than spreading a row, so a caller that passes
 * a wider object (a Prisma row selected too generously) still cannot widen the
 * passport.
 *
 * ── WHY EVERY TIMESTAMP IS A STRING AND EVERY LIST IS SORTED ────────────────
 *
 * `canonicalJson` serialises a `Date` as `{}` — it walks `Object.keys`, and a
 * Date has none — so two passports that differ only in a timestamp would digest
 * alike. Every instant is converted to an ISO string here, before the digest.
 * Lists are sorted by code unit (never `localeCompare`, whose answer depends on
 * the machine's locale) because the database's row order is not a fact about a
 * connection, and a digest that moved with it would report drift every week.
 *
 * ── HOW A WEEK'S PASSPORTS ARE STORED, AND READ BACK ────────────────────────
 *
 * There is no passport table. A week's passports are one canonical JSON bundle
 * embedded in the evidence body, between two marker lines, and the artefact's
 * `sourceDigest` is the SHA-256 of that embedded text. `Evidence.content` is
 * user-editable; `sourceDigest` has no route writer. So reading the bundle back
 * through `extractPassportBundle` turns an editable body into a tamper-evident
 * one: a body somebody edited fails the digest and is reported as such, never
 * compared against.
 *
 * The embedded text escapes `<`, `>`, `&`, U+2028 and U+2029 as JSON `\u`
 * escapes. Values stay EXACT — `JSON.parse` restores every character — so two
 * tool names that differ only in an angle bracket cannot collide the way a
 * lossy sanitiser would make them, and no HTML-active byte reaches the widest
 * surface in the product (PDF export, audit-pack share link).
 */
import { createHash } from 'crypto';

import { ENTRA_MCP_SCOPE, resolveMcpCredentials } from '@/app-layer/integrations/mcp/token';
import { canonicalJson } from '@/lib/canonical-json';
import {
    LADDER,
    coerceStoredMode,
    type ExternalWriteMode,
} from '@/lib/integrations/external-write-ladder';
import { EXTERNAL_TOOL_PREFIX } from '@/lib/mcp/external-tool-name';
import { sanitizePlainText } from '@/lib/security/sanitize';

import type { ArtefactBody, ArtefactPeriod } from './evidence-artefact';

/** The format tag every bundle carries. Bump it when the passport's shape changes. */
export const PASSPORT_FORMAT = 'inflect-integration-passport/1';

/**
 * The five grant kinds the specification names (P3), and no sixth.
 *
 * A secret that cannot be decrypted maps to `invalid`: the runtime could not
 * mint a token from it either, so "this connection cannot authenticate as
 * configured" is the true statement, and a sixth value would be a field the
 * specification does not define.
 */
export const PASSPORT_GRANT_KINDS = ['delegated', 'app-only', 'static-header', 'none', 'invalid'] as const;
export type PassportGrantKind = (typeof PASSPORT_GRANT_KINDS)[number];

/** Handed in, in place of the secrets, when `secretEncrypted` did not decrypt. */
export const SECRET_UNREADABLE: unique symbol = Symbol('integration-passport.secret-unreadable');

/** The longest a stored value the passport repeats as a label may be. */
const UNRECOGNISED_RUNG_MAX = 64;
/** `lastTestStatus` is written as `ok` or `error`; anything else is bounded. */
const TEST_STATUS_MAX = 16;
/** The longest an externally supplied label may be in an evidence body or title. */
const DISPLAY_LABEL_MAX = 120;

// ── Builder input ───────────────────────────────────────────────────────────

/** One `IntegrationConnection`, as the builder reads it. Never serialised. */
export interface PassportConnectionSource {
    readonly id: string;
    readonly name: string;
    readonly isEnabled: boolean;
    readonly configJson: unknown;
    /**
     * `keyedChangeDigest(ENDPOINT_DIGEST_DOMAIN, endpointUrlOf(configJson))`,
     * or null when there is no URL. Computed by the caller because the key is
     * deployment state and this module is pure.
     */
    readonly endpointUrlDigest: string | null;
    /**
     * The decrypted `secretEncrypted`; `null` when the row holds none;
     * `SECRET_UNREADABLE` when it holds one that did not decrypt.
     */
    readonly secrets: Readonly<Record<string, unknown>> | typeof SECRET_UNREADABLE | null;
    readonly externalWriteMode: string | null;
    readonly externalWriteModeSince: Date | null;
    readonly lastTestedAt: Date | null;
    readonly lastTestStatus: string | null;
    /** P11. */
    readonly ownerUserId: string | null;
    /** Does `ownerUserId` hold an ACTIVE membership of this tenant? */
    readonly ownerMembershipActive: boolean;
}

/** One `McpToolManifestPin`. No description or schema text: the hashes stand for it. */
export interface PassportPinRow {
    readonly toolName: string;
    readonly descriptionHash: string;
    readonly schemaHash: string;
    readonly manifestHash: string;
    readonly annotationsHash: string | null;
    readonly revision: number;
    readonly approvalSource: string;
    readonly approvedByUserId: string | null;
    readonly approvedAt: Date;
    readonly previousManifestHash: string | null;
    /**
     * Whether the definition a person accepted declares a write. Null on a
     * BASELINE pin, a built-in's pin, and a pin approved before the
     * declaration was stored.
     */
    readonly declaresWrite: boolean | null;
}

/** One `RegisteredAgentTool`. */
export interface PassportGrantRow {
    readonly agentId: string;
    readonly toolName: string;
    readonly grantedByUserId: string;
    readonly createdAt: Date;
}

/** One `ExternalToolPriorStateRead`. */
export interface PassportPairingRow {
    readonly writeToolName: string;
    readonly readToolName: string;
    readonly approvedByUserId: string | null;
    readonly updatedAt: Date;
}

/**
 * One `ExternalToolParameterSet`. No `parameters`, `pendingParameters`,
 * `openFields` or `pendingOpenFields`: `parametersHash` stands for the values,
 * and only whether `pendingHash` is set is reported.
 */
export interface PassportParameterSetRow {
    readonly id: string;
    readonly toolName: string;
    readonly label: string;
    readonly revision: number;
    readonly parametersHash: string;
    readonly approvalSource: string;
    readonly approvedByUserId: string | null;
    readonly targetPopulation: string | null;
    readonly pendingHash: string | null;
}

/**
 * What one passport is built from. The per-tool rows may be the tenant's whole
 * set: the builder keeps only those whose qualified name names THIS connection.
 */
export interface PassportSources {
    readonly connection: PassportConnectionSource;
    readonly pins: readonly PassportPinRow[];
    readonly grants: readonly PassportGrantRow[];
    readonly pairings: readonly PassportPairingRow[];
    readonly parameterSets: readonly PassportParameterSetRow[];
}

// ── The passport ────────────────────────────────────────────────────────────

export interface PassportPin {
    readonly toolName: string;
    readonly descriptionHash: string;
    readonly schemaHash: string;
    readonly manifestHash: string;
    readonly annotationsHash: string | null;
    readonly revision: number;
    readonly approvalSource: string;
    readonly approvedByUserId: string | null;
    readonly approvedAt: string;
    readonly previousManifestHash: string | null;
    readonly declaresWrite: boolean | null;
}

export interface PassportGrant {
    readonly agentId: string;
    readonly toolName: string;
    readonly grantedByUserId: string;
    readonly createdAt: string;
}

export interface PassportPairing {
    readonly writeToolName: string;
    readonly readToolName: string;
    readonly approvedByUserId: string | null;
    readonly updatedAt: string;
}

export interface PassportParameterSet {
    readonly id: string;
    readonly toolName: string;
    readonly label: string;
    readonly revision: number;
    readonly parametersHash: string;
    readonly approvalSource: string;
    readonly approvedByUserId: string | null;
    readonly targetPopulation: string | null;
    /** An edit awaiting four eyes. Reported, not drift: it is not in force. */
    readonly pending: boolean;
}

export interface IntegrationPassport {
    readonly connectionId: string;
    /** Carried for readability. Not drift: renaming changes no grant. */
    readonly name: string;
    /**
     * P1 — from `configJson.url`, trimmed. `origin` is its scheme, host and
     * port (null when there is no URL, or it is not an absolute http(s) URL);
     * `urlDigest` is the keyed digest of the whole URL. The URL itself is never
     * carried: its path or query can hold a credential.
     */
    readonly endpoint: { readonly origin: string | null; readonly urlDigest: string | null };
    /** P2 */
    readonly enabled: boolean;
    /** P3 */
    readonly grantKind: PassportGrantKind;
    /**
     * P4. `stored` is `configJson.scope` as saved; `effective` is the scope a
     * token is minted with, and is what drift compares. Null for a grant that
     * mints no token (`static-header`, `none`, `invalid`).
     */
    readonly scope: {
        readonly stored: string | null;
        readonly effective: string | null;
        readonly defaulted: boolean;
    };
    /** P5 — the resources the effective scope names, or `unknown`. */
    readonly audience: readonly string[] | 'unknown';
    /** P6, sorted by tool name. */
    readonly pinnedTools: readonly PassportPin[];
    /** P7, sorted by (tool name, agent id). */
    readonly grantedAgents: readonly PassportGrant[];
    /**
     * P8. `mode` is the stored value read through `coerceStoredMode`.
     * `storedUnrecognised` is the stored value when `coerceStoredMode` had to
     * translate it (anything that is not a rung of `LADDER`), else null.
     */
    readonly writeRung: {
        readonly mode: ExternalWriteMode;
        readonly storedUnrecognised: string | null;
        readonly since: string | null;
    };
    /** P9, sorted by write tool name. */
    readonly priorStatePairings: readonly PassportPairing[];
    /** P10, sorted by id. */
    readonly parameterSets: readonly PassportParameterSet[];
    /**
     * P11. `accountable` is true only when the named user holds an ACTIVE
     * membership of the tenant; a named owner who left is no owner.
     */
    readonly owner: { readonly userId: string | null; readonly accountable: boolean };
    /** P12 — as the Test button last wrote it. */
    readonly lastValidated: { readonly at: string | null; readonly status: string | null };
    /** SHA-256 hex of the canonical JSON of every other member. */
    readonly digest: string;
}

/** The members of a passport, in no particular order. Used to refuse an unknown shape. */
const PASSPORT_KEYS: readonly (keyof IntegrationPassport)[] = [
    'connectionId',
    'name',
    'endpoint',
    'enabled',
    'grantKind',
    'scope',
    'audience',
    'pinnedTools',
    'grantedAgents',
    'writeRung',
    'priorStatePairings',
    'parameterSets',
    'owner',
    'lastValidated',
    'digest',
];

// ── Small pure helpers ──────────────────────────────────────────────────────

/** Code-unit order. Never `localeCompare`: a digest must not depend on the machine. */
export function byCodeUnit(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function iso(d: Date): string {
    return d.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function trimmedOrNull(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const t = value.trim();
    return t === '' ? null : t;
}

/**
 * One externally supplied label made safe to put on a line of an evidence body
 * or in a finding title: HTML stripped, every run of whitespace (newlines
 * included) collapsed to one space, bounded. Newlines matter as much as tags
 * here: the embedded bundle is found by its marker LINES, and a connection name
 * carrying a line break could otherwise forge one.
 */
export function displayLabel(value: string | null | undefined, max: number = DISPLAY_LABEL_MAX): string {
    const clean = sanitizePlainText(value ?? '').replace(/[\s\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
    if (clean.length === 0) return 'unknown';
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The qualified-name prefix of every per-tool row of one connection. */
export function connectionToolPrefix(connectionId: string): string {
    // The trailing `__` is load-bearing: without it `ck1` would claim `ck12`'s rows.
    return `${EXTERNAL_TOOL_PREFIX}${connectionId}__`;
}

/** The tool name as the server advertises it, from a qualified name of this connection. */
export function bareToolName(connectionId: string, qualified: string): string {
    const prefix = connectionToolPrefix(connectionId);
    return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified;
}

// ── P1 ──────────────────────────────────────────────────────────────────────

/** The `keyedChangeDigest` domain of P1's `urlDigest`. Changing it re-keys every passport's endpoint. */
export const ENDPOINT_DIGEST_DOMAIN = 'inflect-integration-passport/endpoint-url';

/** The endpoint URL a passport is built from: `configJson.url`, trimmed; null when absent or empty. */
export function endpointUrlOf(configJson: unknown): string | null {
    return trimmedOrNull(asRecord(configJson).url);
}

/**
 * Scheme, host and port — where the stored credential is presented — and
 * nothing after them. Null for a value that is not an absolute http(s) URL:
 * such a value cannot be split into a public part and a possibly-secret one,
 * so none of it is carried.
 */
export function endpointOriginOf(url: string | null): string | null {
    if (url === null) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    // `URL.origin` never carries userinfo, a path, a query or a fragment.
    return parsed.origin;
}

// ── P3, P4, P5 ──────────────────────────────────────────────────────────────

/**
 * P3, with the resolver the runtime uses. Only the kind leaves.
 *
 * Order matters and is the runtime's own: the OAuth resolver first, a static
 * header only when it returns null (`authorizationFor` in
 * `src/app-layer/integrations/mcp/token.ts`). A row holding a partial OAuth
 * configuration beside a static header therefore resolves to `invalid`, exactly
 * as the runtime refuses it.
 */
export function grantKindOf(
    config: Record<string, unknown>,
    secrets: PassportConnectionSource['secrets'],
): PassportGrantKind {
    if (secrets === SECRET_UNREADABLE) return 'invalid';
    const s: Readonly<Record<string, unknown>> = secrets ?? {};
    let kind: 'delegated' | 'app-only' | null;
    try {
        kind = resolveMcpCredentials(config, s)?.kind ?? null;
    } catch {
        return 'invalid';
    }
    if (kind !== null) return kind;
    return trimmedOrNull(s.authorization) !== null ? 'static-header' : 'none';
}

function scopeOf(
    grantKind: PassportGrantKind,
    config: Record<string, unknown>,
): IntegrationPassport['scope'] {
    const stored = trimmedOrNull(config.scope);
    if (grantKind === 'delegated') {
        return { stored, effective: stored ?? ENTRA_MCP_SCOPE, defaulted: stored === null };
    }
    if (grantKind === 'app-only') {
        // The resolver refuses an app-only configuration with no scope, so a
        // resolved `app-only` always has one.
        return { stored, effective: stored, defaulted: false };
    }
    // No token is minted with the stored value, so nothing is effective.
    return { stored, effective: null, defaulted: false };
}

const DEFAULT_SUFFIX = '/.default';

/** P5: each entry of the effective scope except `offline_access`, `/.default` removed. */
export function audienceOf(effectiveScope: string | null): readonly string[] | 'unknown' {
    if (effectiveScope === null) return 'unknown';
    const out = new Set<string>();
    for (const entry of effectiveScope.split(/\s+/)) {
        if (entry === '' || entry === 'offline_access') continue;
        const resource = entry.endsWith(DEFAULT_SUFFIX) ? entry.slice(0, -DEFAULT_SUFFIX.length) : entry;
        if (resource !== '') out.add(resource);
    }
    return [...out].sort(byCodeUnit);
}

// ── P8 ──────────────────────────────────────────────────────────────────────

function writeRungOf(raw: string | null, since: Date | null): IntegrationPassport['writeRung'] {
    // `LADDER.includes`, because `isLadderRung` is not exported and the
    // question is exactly "would `coerceStoredMode` have to translate this":
    // an empty string, a retired rung and an unknown value all would.
    const recognised = raw === null || (LADDER as readonly string[]).includes(raw);
    return {
        mode: coerceStoredMode(raw),
        // An empty or blank value is reported as empty rather than labelled.
        storedUnrecognised: recognised ? null : raw.trim() === '' ? '' : displayLabel(raw, UNRECOGNISED_RUNG_MAX),
        since: since === null ? null : iso(since),
    };
}

// ── The builder ─────────────────────────────────────────────────────────────

/** The digest of a passport: SHA-256 over the canonical JSON of every member but `digest`. */
export function passportDigest(passport: Omit<IntegrationPassport, 'digest'>): string {
    // `digest` removed rather than trusted absent, so recomputing the digest of
    // a passport read back from a bundle is the same call.
    const rest: Record<string, unknown> = { ...passport };
    delete rest.digest;
    return sha256(canonicalJson(rest));
}

/** Build one connection's passport from stored rows. Pure. */
export function buildIntegrationPassport(sources: PassportSources): IntegrationPassport {
    const c = sources.connection;
    const config = asRecord(c.configJson);
    const prefix = connectionToolPrefix(c.id);
    const mine = (toolName: string) => toolName.startsWith(prefix);

    const grantKind = grantKindOf(config, c.secrets);
    const scope = scopeOf(grantKind, config);

    const pinnedTools: PassportPin[] = sources.pins
        .filter((p) => mine(p.toolName))
        .map((p) => ({
            toolName: p.toolName,
            descriptionHash: p.descriptionHash,
            schemaHash: p.schemaHash,
            manifestHash: p.manifestHash,
            annotationsHash: p.annotationsHash ?? null,
            revision: p.revision,
            approvalSource: p.approvalSource,
            approvedByUserId: p.approvedByUserId ?? null,
            approvedAt: iso(p.approvedAt),
            previousManifestHash: p.previousManifestHash ?? null,
            declaresWrite: p.declaresWrite ?? null,
        }))
        .sort((a, b) => byCodeUnit(a.toolName, b.toolName));

    const grantedAgents: PassportGrant[] = sources.grants
        .filter((g) => mine(g.toolName))
        .map((g) => ({
            agentId: g.agentId,
            toolName: g.toolName,
            grantedByUserId: g.grantedByUserId,
            createdAt: iso(g.createdAt),
        }))
        .sort((a, b) => byCodeUnit(a.toolName, b.toolName) || byCodeUnit(a.agentId, b.agentId));

    const priorStatePairings: PassportPairing[] = sources.pairings
        .filter((p) => mine(p.writeToolName))
        .map((p) => ({
            writeToolName: p.writeToolName,
            readToolName: p.readToolName,
            approvedByUserId: p.approvedByUserId ?? null,
            updatedAt: iso(p.updatedAt),
        }))
        .sort((a, b) => byCodeUnit(a.writeToolName, b.writeToolName));

    const parameterSets: PassportParameterSet[] = sources.parameterSets
        .filter((s) => mine(s.toolName))
        .map((s) => ({
            id: s.id,
            toolName: s.toolName,
            label: s.label,
            revision: s.revision,
            parametersHash: s.parametersHash,
            approvalSource: s.approvalSource,
            approvedByUserId: s.approvedByUserId ?? null,
            targetPopulation: s.targetPopulation ?? null,
            pending: s.pendingHash !== null && s.pendingHash !== undefined,
        }))
        .sort((a, b) => byCodeUnit(a.id, b.id));

    const status = c.lastTestStatus === null ? null : c.lastTestStatus.slice(0, TEST_STATUS_MAX);

    const url = endpointUrlOf(c.configJson);
    const body: Omit<IntegrationPassport, 'digest'> = {
        connectionId: c.id,
        name: c.name,
        endpoint: { origin: endpointOriginOf(url), urlDigest: url === null ? null : c.endpointUrlDigest },
        enabled: c.isEnabled,
        grantKind,
        scope,
        audience: audienceOf(scope.effective),
        pinnedTools,
        grantedAgents,
        writeRung: writeRungOf(c.externalWriteMode, c.externalWriteModeSince),
        priorStatePairings,
        parameterSets,
        owner: {
            userId: c.ownerUserId,
            accountable: c.ownerUserId !== null && c.ownerMembershipActive,
        },
        lastValidated: {
            at: c.lastTestedAt === null ? null : iso(c.lastTestedAt),
            status,
        },
    };
    return { ...body, digest: passportDigest(body) };
}

// ── Write declarations (closes the specification's second gap) ──────────────

export interface PassportWriteDeclarations {
    /** Pinned tools whose accepted definition declares a write, and whether each is paired. */
    readonly declaredWrite: readonly { readonly toolName: string; readonly hasPairing: boolean }[];
    /** Pinned tools whose declaration was not recorded at approval. */
    readonly declarationNotRecorded: readonly string[];
}

/**
 * Which pinned tools declare a write, which of those have no prior-state
 * pairing, and which pins carry no recorded declaration. A join of P6 and P9,
 * reported rather than raised: the specification defines no rule for a write
 * tool without a pairing, and dispatch already refuses such a write.
 */
export function writeDeclarationsOf(passport: IntegrationPassport): PassportWriteDeclarations {
    const paired = new Set(passport.priorStatePairings.map((p) => p.writeToolName));
    return {
        declaredWrite: passport.pinnedTools
            .filter((p) => p.declaresWrite === true)
            .map((p) => ({ toolName: p.toolName, hasPairing: paired.has(p.toolName) })),
        declarationNotRecorded: passport.pinnedTools
            .filter((p) => p.declaresWrite === null)
            .map((p) => p.toolName),
    };
}

// ── The bundle: one week's passports, canonical ─────────────────────────────

export interface PassportBundle {
    readonly format: typeof PASSPORT_FORMAT;
    /** ISO instant — the period's inclusive start. */
    readonly periodStart: string;
    readonly periodLabel: string;
    /** Sorted by connection id. */
    readonly connections: readonly IntegrationPassport[];
}

/** The largest embedded bundle an artefact may carry, in UTF-8 bytes. */
export const PASSPORT_BUNDLE_MAX_BYTES = 1_000_000;

export function buildPassportBundle(
    period: ArtefactPeriod,
    passports: readonly IntegrationPassport[],
): PassportBundle {
    const connections = [...passports].sort((a, b) => byCodeUnit(a.connectionId, b.connectionId));
    for (let i = 1; i < connections.length; i++) {
        if (connections[i].connectionId === connections[i - 1].connectionId) {
            // Two passports for one id is a caller defect, and a bundle carrying
            // both would make "the prior passport of X" ambiguous for ever.
            throw new Error(`buildPassportBundle: connection ${connections[i].connectionId} appears twice`);
        }
    }
    return {
        format: PASSPORT_FORMAT,
        periodStart: iso(period.start),
        periodLabel: period.label,
        connections,
    };
}

const EMBED_ESCAPES: Readonly<Record<string, string>> = {
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
};

/**
 * The canonical text of a bundle, safe to embed in a text body.
 *
 * `<`, `>` and `&` can occur in JSON only inside a string, where a `\u` escape
 * means the same character, so the replacement is exact and `JSON.parse`
 * restores every value. `canonicalJson` (through `JSON.stringify`) already
 * escapes every other control character, so the text is ONE line.
 */
export function serialisePassportBundle(bundle: PassportBundle): string {
    return embed(bundle);
}

/** The artefact's `sourceDigest`: SHA-256 of the embedded text. */
export function passportBundleDigest(serialised: string): string {
    return sha256(serialised);
}

export const PASSPORT_BLOCK_BEGIN = '-----BEGIN INTEGRATION PASSPORT BUNDLE-----';
export const PASSPORT_BLOCK_END = '-----END INTEGRATION PASSPORT BUNDLE-----';

export const PASSPORT_EXTRACTION_FAILURES = [
    'BLOCK_MISSING',
    'DIGEST_MISMATCH',
    'NOT_CANONICAL',
    'FORMAT_UNKNOWN',
    'PERIOD_MISMATCH',
    'PASSPORT_DIGEST_MISMATCH',
] as const;
export type PassportExtractionFailure = (typeof PASSPORT_EXTRACTION_FAILURES)[number];

export type PassportBundleExtraction =
    | { readonly ok: true; readonly bundle: PassportBundle }
    | { readonly ok: false; readonly reason: PassportExtractionFailure };

/** The canonical text of any value, escaped for embedding. */
function embed(value: unknown): string {
    return canonicalJson(value).replace(/[<>&\u2028\u2029]/g, (ch) => EMBED_ESCAPES[ch]);
}

const BUNDLE_KEYS = ['connections', 'format', 'periodLabel', 'periodStart'];
const SORTED_PASSPORT_KEYS = [...PASSPORT_KEYS].sort(byCodeUnit);

function hasExactly(value: unknown, sortedKeys: readonly string[]): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort(byCodeUnit);
    return keys.length === sortedKeys.length && keys.every((k, i) => k === sortedKeys[i]);
}

/** Is this parsed value a bundle of this format, with exactly the members a passport has? */
function isBundleOfThisFormat(value: unknown): value is PassportBundle {
    if (!hasExactly(value, BUNDLE_KEYS)) return false;
    if (value.format !== PASSPORT_FORMAT) return false;
    if (typeof value.periodStart !== 'string' || typeof value.periodLabel !== 'string') return false;
    if (!Array.isArray(value.connections)) return false;
    return value.connections.every(
        (p) =>
            hasExactly(p, SORTED_PASSPORT_KEYS)
            && typeof p.connectionId === 'string'
            && typeof p.digest === 'string',
    );
}

/**
 * Read a week's passports back out of an evidence body, or say why not.
 *
 * Checked in this order, each a named refusal: the block is present; its
 * SHA-256 is the artefact's `sourceDigest`; it is the canonical serialisation
 * of what it parses to; the format is this build's, with exactly the members a
 * passport has; it is the period the artefact says; and every passport's own
 * digest recomputes.
 *
 * The LAST begin-marker line is the block: the builder writes it last, and a
 * marker forged into an earlier line (a connection name is collapsed onto one
 * line by `displayLabel`, so it cannot be) would still come before it. The
 * block is one line, and the end marker must be the line after it.
 */
export function extractPassportBundle(
    content: string,
    expectedDigest: string,
    expectedPeriodStart: Date,
): PassportBundleExtraction {
    const lines = content.split('\n');
    const at = lines.lastIndexOf(PASSPORT_BLOCK_BEGIN);
    if (at < 0 || lines[at + 2] !== PASSPORT_BLOCK_END) return { ok: false, reason: 'BLOCK_MISSING' };
    const block = lines[at + 1];
    if (sha256(block) !== expectedDigest) return { ok: false, reason: 'DIGEST_MISMATCH' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(block);
    } catch {
        return { ok: false, reason: 'NOT_CANONICAL' };
    }
    if (embed(parsed) !== block) return { ok: false, reason: 'NOT_CANONICAL' };
    if (!isBundleOfThisFormat(parsed)) return { ok: false, reason: 'FORMAT_UNKNOWN' };
    if (parsed.periodStart !== iso(expectedPeriodStart)) return { ok: false, reason: 'PERIOD_MISMATCH' };
    for (const p of parsed.connections) {
        if (passportDigest(p) !== p.digest) return { ok: false, reason: 'PASSPORT_DIGEST_MISMATCH' };
    }
    return { ok: true, bundle: parsed };
}

// ── The evidence body ───────────────────────────────────────────────────────

/**
 * The passport's own redaction contract. In the body for the reason the
 * receipts artefact gives: the reader is an assessor, and an absence explained
 * where it is noticed reads as a design rather than as an incomplete export.
 */
export const PASSPORT_REDACTION_CONTRACT =
    'REDACTION CONTRACT — this artefact records what each external agent connection lets an ' +
    'agent do, as identifiers and hashes. It deliberately carries no secret value and no hash ' +
    'of one, no access token, no endpoint path or query (either can carry a credential, so ' +
    'the endpoint is its origin and a digest keyed by the deployment), no tool description or ' +
    'schema text (the pinned hashes stand for them), no parameter values (each set\'s ' +
    'parametersHash stands for them) and no write-journal payload. The grant kind is derived ' +
    'from which credential fields a connection holds; no credential value was carried beyond ' +
    'that. User ids are opaque identifiers.';

function summaryLine(p: IntegrationPassport): string {
    const decl = writeDeclarationsOf(p);
    const baseline = p.pinnedTools.filter((t) => t.approvalSource === 'BASELINE').length;
    const unattested = p.pinnedTools.filter((t) => t.annotationsHash === null).length;
    const unpaired = decl.declaredWrite.filter((t) => !t.hasPairing).length;
    const pending = p.parameterSets.filter((s) => s.pending).length;
    const rung =
        p.writeRung.storedUnrecognised === null
            ? p.writeRung.mode
            : `${p.writeRung.mode} (stored value "${p.writeRung.storedUnrecognised}" not recognised)`;
    const owner = p.owner.accountable
        ? 'accountable owner set'
        : p.owner.userId === null
        ? 'NO accountable owner'
        : 'NO accountable owner (the named owner holds no active membership)';
    const test =
        p.lastValidated.at === null
            ? 'never tested'
            : `last test ${displayLabel(p.lastValidated.status, 16)} at ${p.lastValidated.at}`;
    const endpoint =
        p.endpoint.origin !== null
            ? displayLabel(p.endpoint.origin)
            : p.endpoint.urlDigest === null
            ? 'none'
            : 'not an http(s) URL';
    return (
        `- ${p.connectionId} "${displayLabel(p.name)}": ${p.enabled ? 'enabled' : 'disabled'} · `
        + `endpoint ${endpoint} · `
        + `grant ${p.grantKind} · write rung ${rung} · pinned tools ${p.pinnedTools.length} `
        + `(baseline ${baseline}, annotations unattested ${unattested}, declare a write `
        + `${decl.declaredWrite.length}, declare a write with no prior-state pairing ${unpaired}, `
        + `write declaration not recorded ${decl.declarationNotRecorded.length}) · agents granted `
        + `${p.grantedAgents.length} · parameter sets ${p.parameterSets.length} (pending ${pending}) · `
        + `${owner} · ${test}`
    );
}

/**
 * The evidence body for one week's passports. The emitter prepends the
 * `Control:` line, as it does for every artefact.
 *
 * `digest` must be `passportBundleDigest(serialisePassportBundle(bundle))`; a
 * caller passing anything else would emit an artefact that never verifies, so
 * that is refused here rather than discovered next week.
 */
export function buildPassportArtefactBody(
    period: ArtefactPeriod,
    bundle: PassportBundle,
    digest: string,
): ArtefactBody {
    const serialised = serialisePassportBundle(bundle);
    if (passportBundleDigest(serialised) !== digest) {
        throw new Error('buildPassportArtefactBody: digest is not the digest of this bundle');
    }
    const enabled = bundle.connections.filter((c) => c.enabled).length;
    const lines = [
        `Period: ${period.label} (${iso(period.start)} .. ${iso(period.end)}, end exclusive)`,
        `External agent connections: ${bundle.connections.length} (enabled ${enabled}, disabled `
            + `${bundle.connections.length - enabled})`,
        '',
        ...bundle.connections.map(summaryLine),
        ...(bundle.connections.length === 0 ? ['(none)'] : []),
        '',
        `Bundle digest (SHA-256 over the embedded canonical bundle below): ${digest}`,
        '',
        PASSPORT_REDACTION_CONTRACT,
        '',
        PASSPORT_BLOCK_BEGIN,
        serialised,
        PASSPORT_BLOCK_END,
    ];
    return {
        title: `Integration passports — ${period.label}`,
        content: lines.join('\n'),
    };
}
