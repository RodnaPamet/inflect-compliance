/**
 * FROM SOURCE READS TO A SIGNED `inflect-agent-harness/2` REPORT.
 *
 * The report is built against the contract's own schemas
 * (`src/lib/agentic/harness-contract.ts`) rather than a copy of them, and the
 * scanner checks its own output with them BEFORE it signs: a body the ingest
 * would refuse as SCHEMA, or as SECRET_IN_REPORT, is refused here and never
 * leaves the estate. The signed message is the contract's
 * (`harnessSignedMessage`), so the bytes signed here and the bytes verified
 * there come from one function.
 *
 * What the builder decides, and why:
 *
 *   • EVERY SOURCE IS LISTED, read or not. `population.sources` is built from
 *     the reads, and a source that stopped is INCOMPLETE with its reason. The
 *     scan's completeness is not stated anywhere: the ingest derives it.
 *   • AGENTS MERGE BY `discoveredId`. A principal seen by two sources is one
 *     agent `discoveredVia` both, with both sources' credentials, tools (once
 *     per server and name) and model endpoints (once per endpoint and model).
 *     The owner is the first one found in source order — the identity source
 *     before the vault — and a disagreement is not resolved by inventing a
 *     third answer. A tool's call count stays with the source for now: `/2`
 *     has a member for it (`calls`, with `windowDays`), and filling it is a
 *     follow-up of #3738's.
 *   • VERDICTS COLLAPSE TO THE LEAST FAVOURABLE per criterion, the ladder's
 *     own rule (`collapseVerdicts`), so the report never says more than the
 *     most cautious source did.
 *   • CAPS ARE REPORTED, NOT ABSORBED. When the merged population or one
 *     agent's credentials or tools exceed what a report may carry, the overflow
 *     is cut deterministically and every source that contributed to what was
 *     cut is marked INCOMPLETE `BYTE_CAP`. A report that silently held the
 *     first 5,000 agents would describe a slice as the estate.
 *   • `registeredAgentId` COMES FROM THE REGISTER SOURCE ALONE. The
 *     `inflect-register` source's link is taken, the first for a principal in
 *     source order; the same member from any other kind is dropped, because a
 *     label in the estate is something its administrator could write (see
 *     `source.ts`).
 *   • The scanner's own `findings` are INCOMPLETE_SOURCE only. The ingest
 *     derives its findings and does not act on this member; the scanner raises
 *     only what it alone knows, which is where it could not read.
 *   • A `<key>:*` PLACEHOLDER IS REPLACED BY WHAT THE SERVER SERVES. The `code`
 *     source reports a tool set its agent fetches from an MCP server at run
 *     time as one `<key>:*` entry at the server's URL. When the `mcp` source
 *     read that same server IN FULL, the placeholder becomes the server's
 *     actual tools, with their hashes, hints and pin, and the agent is
 *     `discoveredVia` `mcp` too (owner decision 2 on #3686). A server read in
 *     part replaces nothing: the placeholder, which counts as a write, stays.
 *   • AN UNBOUND CREDENTIAL IS ONE NO PRINCIPAL HOLDS, across every source.
 *     `unboundCredentials[]` is what each source saw bound to no principal,
 *     less any reference some merged principal holds — including one cut by a
 *     cap, whose source is then INCOMPLETE anyway. A credential the vault sees
 *     untagged and the identity source sees on an agent is that agent's, and
 *     the contract refuses a report that says both. The ingest, not the
 *     scanner, decides it is an ORPHAN_CREDENTIAL.
 */
import { sign, type KeyObject } from 'crypto';

import {
    HARNESS_CONTRACT_V2,
    HarnessReportBodyV2Schema,
    MAX_AGENTS,
    MAX_CREDENTIALS_PER_AGENT,
    MAX_MODELS_PER_AGENT,
    MAX_TOOLS_PER_AGENT,
    MAX_UNBOUND_CREDENTIALS,
    SOURCE_KINDS_V2,
    harnessSignedMessage,
    type HarnessReportAgent,
    type HarnessReportBodyV2,
    type HarnessUnboundCredential,
} from '@/lib/agentic/harness-contract';
import { firstSecretShapedMember } from '@/lib/agentic/harness-findings';
import { collapseVerdicts, type CriterionVerdict } from '@/lib/agentic/harness-ladder';

import { SCANNER_VERSION, scannerManifestHash } from './scanner-surface';
import type {
    IncompleteReason,
    McpServerRead,
    ObservedCredential,
    ObservedModel,
    ObservedOwner,
    ObservedTool,
    SourceKind,
    SourceRead,
} from './source';

export interface ScanIdentity {
    /** The scanner's id for this run; unique per tenant, or the ingest refuses it as a REPLAY. */
    readonly scanId: string;
    readonly asOf: Date;
    /** The scanner's own register id. Its signing key is registered against it. */
    readonly scannerAgentId: string;
}

const kindOrder = (k: SourceKind) => SOURCE_KINDS_V2.indexOf(k);
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface MergedAgent {
    discoveredId: string;
    via: Set<SourceKind>;
    registeredAgentId: string | null;
    owner: ObservedOwner | null;
    credentials: Map<string, { credential: ObservedCredential; via: SourceKind }>;
    tools: Map<string, { tool: ObservedTool; via: SourceKind }>;
    models: Map<string, { model: ObservedModel; via: SourceKind }>;
    verdicts: CriterionVerdict[];
}

const toolKey = (t: ObservedTool) => `${t.server}\u0000${t.name}`;

/** One MCP endpoint however it is spelt: origin and path, no trailing slash. */
function endpointKey(url: string): string {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
        return url;
    }
}
const modelKey = (m: ObservedModel) => `${m.endpoint}\u0000${m.model ?? ''}`;

/** Build the report body. Pure: no clock, no I/O. */
export function buildReportBody(identity: ScanIdentity, reads: readonly SourceRead[]): HarnessReportBodyV2 {
    const ordered = [...reads].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
    const status = new Map<SourceKind, { status: 'COMPLETE' | 'INCOMPLETE'; reason?: IncompleteReason; rows: number }>(
        ordered.map((r) => [r.kind, { status: r.status, reason: r.reason, rows: r.rows }]),
    );
    const capped = (kind: SourceKind) => {
        const s = status.get(kind);
        if (s && s.status === 'COMPLETE') status.set(kind, { status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: s.rows });
    };

    const merged = new Map<string, MergedAgent>();
    for (const read of ordered) {
        for (const o of read.observations) {
            const agent: MergedAgent = merged.get(o.discoveredId) ?? {
                discoveredId: o.discoveredId,
                via: new Set<SourceKind>(),
                registeredAgentId: null,
                owner: null,
                credentials: new Map(),
                tools: new Map(),
                models: new Map(),
                verdicts: [],
            };
            agent.via.add(read.kind);
            if (read.kind === 'inflect-register' && agent.registeredAgentId === null && o.registeredAgentId !== undefined) {
                agent.registeredAgentId = o.registeredAgentId;
            }
            if (agent.owner === null && o.owner !== null) agent.owner = o.owner;
            for (const c of o.credentials) if (!agent.credentials.has(c.ref)) agent.credentials.set(c.ref, { credential: c, via: read.kind });
            for (const { tool } of o.tools ?? []) if (!agent.tools.has(toolKey(tool))) agent.tools.set(toolKey(tool), { tool, via: read.kind });
            for (const m of o.models ?? []) if (!agent.models.has(modelKey(m))) agent.models.set(modelKey(m), { model: m, via: read.kind });
            agent.verdicts.push(...o.verdicts);
            merged.set(o.discoveredId, agent);
        }
    }

    // A run-time tool set (`<key>:*`) on a server the `mcp` source read in full
    // is replaced by that server's tools.
    const served = new Map<string, McpServerRead>();
    for (const read of ordered) for (const s of read.mcpServers ?? []) served.set(endpointKey(s.url), s);
    for (const agent of merged.values()) {
        for (const [key, { tool }] of [...agent.tools]) {
            if (!tool.name.endsWith(':*')) continue;
            const server = served.get(endpointKey(tool.server));
            if (server === undefined) continue;
            agent.tools.delete(key);
            for (const t of server.tools) if (!agent.tools.has(toolKey(t))) agent.tools.set(toolKey(t), { tool: t, via: 'mcp' });
            agent.via.add('mcp');
        }
    }

    const all = [...merged.values()].sort((a, b) => byString(a.discoveredId, b.discoveredId));
    for (const dropped of all.slice(MAX_AGENTS)) dropped.via.forEach(capped);
    const kept = all.slice(0, MAX_AGENTS);

    const agents: HarnessReportAgent[] = kept.map((a) => {
        const creds = [...a.credentials.values()].sort((x, y) => byString(x.credential.ref, y.credential.ref));
        for (const cut of creds.slice(MAX_CREDENTIALS_PER_AGENT)) capped(cut.via);
        const tools = [...a.tools.entries()].sort(([x], [y]) => byString(x, y)).map(([, t]) => t);
        for (const cut of tools.slice(MAX_TOOLS_PER_AGENT)) capped(cut.via);
        const models = [...a.models.entries()].sort(([x], [y]) => byString(x, y)).map(([, m]) => m);
        for (const cut of models.slice(MAX_MODELS_PER_AGENT)) capped(cut.via);
        return {
            discoveredId: a.discoveredId,
            discoveredVia: [...a.via].sort((x, y) => kindOrder(x) - kindOrder(y)),
            registeredAgentId: a.registeredAgentId,
            owner: a.owner,
            credentials: creds.slice(0, MAX_CREDENTIALS_PER_AGENT).map((c) => c.credential),
            tools: tools.slice(0, MAX_TOOLS_PER_AGENT).map((t) => t.tool),
            // Optional in `/2`: left out when no source reported a model.
            ...(models.length > 0 ? { models: models.slice(0, MAX_MODELS_PER_AGENT).map((m) => m.model) } : {}),
            skills: [],
            verdicts: [...collapseVerdicts(a.verdicts).values()].sort((x, y) => byString(x.criterion, y.criterion)),
        };
    });

    // Unbound: seen by a source against no principal, and held by no merged
    // principal — kept or cut. One entry per (source, reference), in source
    // then reference order; past the cap, the source that lost entries is
    // INCOMPLETE BYTE_CAP like any other overflow.
    const held = new Set(all.flatMap((a) => [...a.credentials.keys()]));
    const unbound: HarnessUnboundCredential[] = [];
    for (const read of ordered) {
        const refs = [...new Set(read.unboundCredentials ?? [])].filter((ref) => !held.has(ref)).sort(byString);
        for (const ref of refs) unbound.push({ ref, sourceKind: read.kind });
    }
    for (const cut of unbound.slice(MAX_UNBOUND_CREDENTIALS)) capped(cut.sourceKind);

    const sources = ordered.map((r) => {
        const s = status.get(r.kind)!;
        return s.status === 'COMPLETE'
            ? { kind: r.kind, status: 'COMPLETE' as const, rows: s.rows }
            : { kind: r.kind, status: 'INCOMPLETE' as const, reason: s.reason ?? 'UNREACHABLE', rows: s.rows };
    });

    return {
        contract: HARNESS_CONTRACT_V2,
        scan: {
            id: identity.scanId,
            asOf: identity.asOf.toISOString(),
            scanner: { agentId: identity.scannerAgentId, version: SCANNER_VERSION, manifestHash: scannerManifestHash() },
        },
        population: { sources },
        agents,
        findings: sources
            .filter((s) => s.status === 'INCOMPLETE')
            .map((s) => ({
                code: 'INCOMPLETE_SOURCE' as const,
                discoveredId: null,
                severity: 'MEDIUM' as const,
                evidence: `source:${s.kind}#${'reason' in s ? s.reason : ''}`,
            })),
        unboundCredentials: unbound.slice(0, MAX_UNBOUND_CREDENTIALS),
    };
}

/** The scanner refused to sign its own output. Carries issue PATHS, never values. */
export class ReportRefusedLocally extends Error {
    constructor(readonly issues: readonly string[]) {
        super(`the scanner refused to sign its report: ${issues.slice(0, 20).join('; ')}`);
        this.name = 'ReportRefusedLocally';
    }
}

/** The raw 32-byte Ed25519 public key, hex — what a tenant registers as the scanner's key. */
export function rawPublicKeyHex(publicKey: KeyObject): string {
    // SPKI DER for Ed25519 is a fixed 12-byte prefix followed by the raw key.
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
}

/**
 * Check the body against the contract, then sign it. Returns the serialised
 * report, ready to post unchanged.
 *
 * The checks are the ingest's own — the strict schema, and the secret shape
 * over every string member — run here so a report that would be refused is
 * never signed. A refusal names paths only: a message that quoted a value
 * could quote a secret.
 */
export function signReport(body: HarnessReportBodyV2, keys: { privateKey: KeyObject; publicKey: KeyObject }): string {
    const parsed = HarnessReportBodyV2Schema.safeParse(body);
    if (!parsed.success) {
        throw new ReportRefusedLocally(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`));
    }
    const secretAt = firstSecretShapedMember(parsed.data);
    if (secretAt !== null) throw new ReportRefusedLocally([`${secretAt}: secret-shaped`]);

    // Sign what the WIRE will carry, not the in-memory object: a key holding
    // `undefined` canonicalises as `null` but is dropped by JSON.stringify, so
    // the two can differ. Round-tripping first makes the signed message the one
    // the verifier recomputes from the bytes it receives.
    const wireBody = JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
    const signature = {
        alg: 'ed25519' as const,
        signerKey: rawPublicKeyHex(keys.publicKey),
        sig: sign(null, harnessSignedMessage(wireBody), keys.privateKey).toString('hex'),
    };
    return JSON.stringify({ ...wireBody, signature });
}
