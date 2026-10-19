/**
 * The REFERENCE implementation of a scanner speaking `inflect-agent-harness/2`
 * and `/3`.
 *
 * `docs/agent-harness-contract.md` names this file as the executable reference,
 * and `tests/unit/agentic/harness-contract.test.ts` validates its output against
 * `src/lib/agentic/harness-contract.ts`. Where the prose and this file disagree,
 * this file is the one the suite checks, so it is the one to copy.
 *
 * It produces valid signed `/2` reports — `validReportBody`, the plainest, and
 * `validV2ReportBody`, which carries every member `/2` added — and, on request,
 * `validV3ReportBody`, the same estate under `/3` with a `gcp-sa` source read
 * in full — and, on request,
 * every malformation the contract tells an ingest to refuse, each paired with
 * the refusal it must get. One of those is `retiredV1ReportBody`, a report as a
 * `/1` scanner sent it, which the verifier refuses since `/1` was retired
 * (#3686).
 *
 * Secret-shaped fixtures are assembled at runtime from fragments, so no literal
 * credential pattern exists in this file for the secret scanners to flag.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'crypto';

import {
    HARNESS_CONTRACT_V1,
    HARNESS_CONTRACT_V2,
    HARNESS_CONTRACT_V3,
    MAX_REPORT_BYTES,
    harnessSignedMessage,
    type HarnessRefusal,
    type HarnessReportBodyV2,
    type HarnessReportBodyV3,
} from '@/lib/agentic/harness-contract';

export interface FakeScanner {
    /** The raw 32-byte Ed25519 public key, hex. What a tenant registers as trusted. */
    readonly publicKeyHex: string;
    signBody(body: unknown): { alg: 'ed25519'; signerKey: string; sig: string };
    /** A complete signed report, serialised. */
    serialise(body: unknown): string;
}

export function createFakeScanner(): FakeScanner {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = rawPublicKeyHex(publicKey);
    const signBody = (body: unknown) => ({
        alg: 'ed25519' as const,
        signerKey: publicKeyHex,
        sig: sign(null, harnessSignedMessage(body), privateKey).toString('hex'),
    });
    return {
        publicKeyHex,
        signBody,
        serialise: (body) => JSON.stringify({ ...(body as object), signature: signBody(body) }),
    };
}

function rawPublicKeyHex(key: KeyObject): string {
    // SPKI DER for Ed25519 is a fixed 12-byte prefix followed by the raw key.
    return key.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
}

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

/** A report body as a `/1` scanner sent it: `/2`'s members without `unboundCredentials[]`. */
export type RetiredV1ReportBody = Omit<HarnessReportBodyV2, 'contract' | 'unboundCredentials'> & {
    contract: typeof HARNESS_CONTRACT_V1;
};

/**
 * A report a `/1` scanner would send, signed and otherwise valid: one
 * registered agent at H2, one shadow agent at H0. The verifier refuses it
 * (`SCHEMA`) since `/1` was retired (#3686, owner decision 2026-10-19).
 */
export function retiredV1ReportBody(): RetiredV1ReportBody {
    return {
        contract: HARNESS_CONTRACT_V1,
        scan: {
            id: 'scan_01JFAKE',
            asOf: '2026-11-03T03:30:00.000Z',
            scanner: { agentId: 'agt_scanner', version: '0.1.0', manifestHash: HASH_A },
        },
        population: {
            sources: [
                { kind: 'entra-sp', status: 'COMPLETE', rows: 412 },
                { kind: 'vault', status: 'COMPLETE', rows: 37 },
                { kind: 'mcp', status: 'COMPLETE', rows: 3 },
                { kind: 'inflect-register', status: 'COMPLETE', rows: 1 },
            ],
        },
        agents: [
            {
                discoveredId: 'entra:sp:registered-1',
                discoveredVia: ['entra-sp', 'vault', 'inflect-register'],
                registeredAgentId: 'agt_registered_1',
                owner: { kind: 'user', id: 'usr_owner_1', source: 'inflect-register' },
                credentials: [
                    { ref: 'kv://prod/agents/reporting', ageDays: 12, expires: true, boundToAgent: true, grant: 'delegated' },
                ],
                tools: [
                    { server: 'https://mcp.internal.example/crm', name: 'list_accounts', manifestHash: HASH_B, pinned: true, readOnlyHint: true },
                ],
                skills: [{ name: 'evidence-sufficiency', license: 'proprietary', declared: true }],
                verdicts: [
                    { criterion: 'H1.registered', met: true, evidence: 'inflect-register:RegisteredAgent/agt_registered_1' },
                    { criterion: 'H1.owner', met: true, evidence: 'inflect-register:RegisteredAgent/agt_registered_1#owner' },
                    { criterion: 'H1.axes_declared', met: true, evidence: 'inflect-register:RegisteredAgent/agt_registered_1#axes' },
                    { criterion: 'H1.tier_scored_fresh', met: true, evidence: 'inflect-register:AgentRiskAssessment/latest' },
                    { criterion: 'H2.credential_bound', met: true, evidence: 'kv://prod/agents/reporting' },
                    { criterion: 'H2.grant_kind_declared', met: true, evidence: 'kv://prod/agents/reporting#grant' },
                    { criterion: 'H2.tools_allowlisted', met: true, evidence: 'inflect-register:RegisteredAgentTool' },
                    { criterion: 'H2.audience_tokens', met: true, evidence: 'inflect-register:/api/mcp/token' },
                    { criterion: 'H2.policy_card', met: true, evidence: 'inflect-register:AgentPolicyCard/head' },
                    { criterion: 'H3.manifests_pinned', met: false, evidence: null },
                ],
            },
            {
                discoveredId: 'entra:sp:shadow-1',
                discoveredVia: ['entra-sp', 'vault'],
                registeredAgentId: null,
                owner: null,
                credentials: [
                    { ref: 'kv://prod/agents/sales-bot', ageDays: 212, expires: false, boundToAgent: false, grant: 'app-only' },
                ],
                tools: [
                    { server: 'https://mcp.internal.example/crm', name: 'update_opportunity', manifestHash: null, pinned: false, readOnlyHint: false },
                ],
                skills: [],
                verdicts: [],
            },
        ],
        findings: [
            { code: 'SHADOW_AGENT', discoveredId: 'entra:sp:shadow-1', severity: 'HIGH', evidence: 'entra-sp:servicePrincipals/shadow-1' },
            { code: 'UNPINNED_WRITE_TOOL', discoveredId: 'entra:sp:shadow-1', severity: 'HIGH', evidence: 'mcp:https://mcp.internal.example/crm#update_opportunity' },
        ],
    };
}

/**
 * A valid `/2` report body, the plainest: `retiredV1ReportBody`'s two agents
 * under `/2`, with no credential reported unbound.
 */
export function validReportBody(): HarnessReportBodyV2 {
    return { ...retiredV1ReportBody(), contract: HARNESS_CONTRACT_V2, unboundCredentials: [] };
}

/** The same valid body with one source honestly reported as incomplete. */
export function validIncompleteReportBody(): HarnessReportBodyV2 {
    const body = validReportBody();
    body.population.sources[2] = { kind: 'mcp', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 1 };
    return body;
}

/** The unbound credential both `/2` bodies report: in the vault, read in full, held by no agent. */
export const UNBOUND_VAULT_REF = 'kv://prod/agents/retired-reporting';

/** The model endpoints `validV2ReportBody` reports for its registered agent: a URL, and a host. */
export const V2_MODEL_ENDPOINTS = [
    { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { endpoint: 'llm-gateway.internal.example', model: null },
] as const;

/**
 * A valid `/2` report body carrying what `/2` added: `validReportBody`'s two agents, and a `code`
 * source that could not resolve one definition (INCOMPLETE `UNPARSEABLE`), one
 * credential the vault, read in full, saw bound to no agent, a call count over
 * a 30-day window on the registered agent's tool, and its model endpoints.
 *
 * The planner opens no ORPHAN_CREDENTIAL from it: `code` is identity-bearing,
 * and it stopped early, so the agent that binds the vault's credential may be
 * the definition it could not read. `validV2CompleteReportBody` is the same
 * report with `code` read in full, which opens it.
 */
export function validV2ReportBody(): HarnessReportBodyV2 {
    const plain = validReportBody();
    const [registered, shadow] = plain.agents;
    return {
        ...plain,
        agents: [
            {
                ...registered,
                tools: registered.tools.map((t) => ({ ...t, calls: 42, windowDays: 30 })),
                models: V2_MODEL_ENDPOINTS.map((m) => ({ ...m })),
            },
            // An agent may carry neither: both are optional.
            shadow,
        ],
        population: {
            sources: [...plain.population.sources, { kind: 'code', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: 4 }],
        },
        findings: [
            ...plain.findings,
            { code: 'INCOMPLETE_SOURCE', discoveredId: null, severity: 'MEDIUM', evidence: 'source:code#UNPARSEABLE' },
        ],
        unboundCredentials: [{ ref: UNBOUND_VAULT_REF, sourceKind: 'vault' }],
    };
}

/**
 * `validV2ReportBody` with its `code` source read in full: every source it
 * lists is COMPLETE, so the vault's unbound credential opens ORPHAN_CREDENTIAL.
 */
export function validV2CompleteReportBody(): HarnessReportBodyV2 {
    const body = validV2ReportBody();
    body.population.sources = body.population.sources.map((s) =>
        s.kind === 'code' ? { kind: 'code', status: 'COMPLETE', rows: 4 } : s,
    );
    body.findings = body.findings.filter((f) => f.code !== 'INCOMPLETE_SOURCE');
    return body;
}

/** The service account `validV3ReportBody` reports, and its one user-managed key. */
export const GCP_SA_ID = 'gcp:sa:104238856123456789012';
export const GCP_SA_KEY_REF = 'gcp-sa-key://acme-prod-319/104238856123456789012/2f1a9c0e3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';

/**
 * A valid `/3` report body: `validReportBody`'s estate under `/3`, with a
 * `gcp-sa` source read in full and the service account it found, holding one
 * user-managed key. Everything else is `/2`'s, unchanged — `/3` adds only the
 * kind.
 */
export function validV3ReportBody(): HarnessReportBodyV3 {
    const plain = validReportBody();
    return {
        ...plain,
        contract: HARNESS_CONTRACT_V3,
        population: { sources: [...plain.population.sources, { kind: 'gcp-sa', status: 'COMPLETE', rows: 3 }] },
        agents: [
            ...plain.agents,
            {
                discoveredId: GCP_SA_ID,
                discoveredVia: ['gcp-sa'],
                registeredAgentId: null,
                owner: null,
                credentials: [{ ref: GCP_SA_KEY_REF, ageDays: 400, expires: false, boundToAgent: true, grant: 'app-only' }],
                tools: [],
                skills: [],
                verdicts: [
                    { criterion: 'H2.credential_bound', met: true, evidence: 'gcp-sa:projects/acme-prod-319/serviceAccounts/104238856123456789012/keys' },
                    { criterion: 'H2.grant_kind_declared', met: true, evidence: 'gcp-sa:projects/acme-prod-319/serviceAccounts/104238856123456789012' },
                ],
            },
        ],
    };
}

/** A credential-shaped string, built at runtime. Never a real credential. */
function fakeSecret(): string {
    return ['gh', 'p_', 'Q'.repeat(36)].join('');
}

type Path = ReadonlyArray<string | number>;

/** Set `value` at `path` inside a parsed JSON tree, creating nothing on the way. */
function setPath(target: unknown, path: Path, value: unknown): void {
    let node = target;
    for (const key of path.slice(0, -1)) {
        node = (node as Record<string | number, unknown>)[key];
    }
    (node as Record<string | number, unknown>)[path[path.length - 1]] = value;
}

/** Every malformation the contract refuses, and the refusal it must produce. */
export const MALFORMATIONS = {
    'oversized': 'TOO_LARGE',
    'not-json': 'NOT_JSON',
    'array-root': 'NOT_AN_OBJECT',
    'unsigned': 'UNSIGNED',
    'malformed-signature': 'MALFORMED_SIGNATURE',
    'untrusted-signer': 'UNTRUSTED_SIGNER',
    'tampered-after-signing': 'BAD_SIGNATURE',
    'unknown-field': 'SCHEMA',
    'self-declared-level': 'SCHEMA',
    'credential-value': 'SCHEMA',
    'secret-inside-reference': 'SCHEMA',
    'incomplete-without-reason': 'SCHEMA',
    'complete-with-reason': 'SCHEMA',
    'duplicate-agent': 'SCHEMA',
    'duplicate-source': 'SCHEMA',
    'wrong-contract': 'SCHEMA',
    'unknown-criterion': 'SCHEMA',
    // A report as a `/1` scanner sent it, signed by a trusted key and valid
    // under the schema `/1` had: refused, because `/1` is retired (#3686).
    'retired-v1': 'SCHEMA',
    // `/2` is held to its schema, which requires its member and checks every entry.
    'v2-without-unbound-credentials': 'SCHEMA',
    'v2-unbound-credential-value': 'SCHEMA',
    'v2-unbound-secret-inside-reference': 'SCHEMA',
    'v2-unbound-from-unlisted-source': 'SCHEMA',
    'v2-unbound-twice': 'SCHEMA',
    'v2-unbound-but-held-by-an-agent': 'SCHEMA',
    // The call counts and model endpoints `/2` added: only as numbers with a
    // window and as references.
    'v2-calls-without-window': 'SCHEMA',
    'v2-negative-calls': 'SCHEMA',
    'v2-secret-shaped-endpoint': 'SCHEMA',
    'v2-endpoint-with-userinfo': 'SCHEMA',
    'v2-model-with-a-prompt': 'SCHEMA',
    // `/3` adds a kind to a closed list, and each id is held to its own: a `/2`
    // report that names `gcp-sa` anywhere is refused, as a `/2` verifier would.
    'v2-names-gcp-sa-source': 'SCHEMA',
    'v2-agent-discovered-via-gcp-sa': 'SCHEMA',
    'v2-unbound-from-gcp-sa': 'SCHEMA',
} as const satisfies Record<string, HarnessRefusal>;

export type Malformation = keyof typeof MALFORMATIONS;

/**
 * Build one malformed report. `trusted` is the key list the ingest should be
 * called with; for every case but `untrusted-signer` it is the scanner's own.
 */
export function malformedReport(
    scanner: FakeScanner,
    kind: Malformation,
): { raw: string; trusted: string[]; expected: HarnessRefusal } {
    const expected = MALFORMATIONS[kind];
    const trusted = [scanner.publicKeyHex];
    /** Sign a valid body after setting one path to a value the contract refuses. */
    const signedWith = (...edits: Array<[Path, unknown]>) => {
        const body: unknown = validReportBody();
        for (const [path, value] of edits) setPath(body, path, value);
        return scanner.serialise(body);
    };
    /** The same over the `/2` body. */
    const signedV2With = (...edits: Array<[Path, unknown]>) => {
        const body: unknown = validV2ReportBody();
        for (const [path, value] of edits) setPath(body, path, value);
        return scanner.serialise(body);
    };

    switch (kind) {
        case 'oversized':
            return { raw: scanner.serialise(validReportBody()) + ' '.repeat(MAX_REPORT_BYTES), trusted, expected };
        case 'not-json':
            return { raw: '{"contract":', trusted, expected };
        case 'array-root':
            return { raw: '[]', trusted, expected };
        case 'unsigned':
            return { raw: JSON.stringify(validReportBody()), trusted, expected };
        case 'malformed-signature': {
            const raw = JSON.stringify({ ...validReportBody(), signature: { alg: 'ed25519', signerKey: scanner.publicKeyHex, sig: 'zz' } });
            return { raw, trusted, expected };
        }
        case 'untrusted-signer': {
            const other = createFakeScanner();
            return { raw: other.serialise(validReportBody()), trusted, expected };
        }
        case 'tampered-after-signing': {
            const parsed: unknown = JSON.parse(scanner.serialise(validReportBody()));
            setPath(parsed, ['agents', 1, 'owner'], { kind: 'user', id: 'usr_attacker', source: 'entra-owner-tag' });
            return { raw: JSON.stringify(parsed), trusted, expected };
        }
        case 'unknown-field':
            return { raw: signedWith([['agents', 0, 'notes'], 'not in the contract']), trusted, expected };
        case 'self-declared-level':
            return { raw: signedWith([['agents', 0, 'level'], 'H5']), trusted, expected };
        case 'credential-value':
            return { raw: signedWith([['agents', 1, 'credentials', 0, 'ref'], fakeSecret()]), trusted, expected };
        case 'secret-inside-reference':
            return { raw: signedWith([['agents', 1, 'credentials', 0, 'ref'], `kv://${fakeSecret()}`]), trusted, expected };
        case 'incomplete-without-reason':
            return { raw: signedWith([['population', 'sources', 0], { kind: 'entra-sp', status: 'INCOMPLETE', rows: 0 }]), trusted, expected };
        case 'complete-with-reason':
            return { raw: signedWith([['population', 'sources', 0, 'reason'], 'BYTE_CAP']), trusted, expected };
        case 'duplicate-agent':
            return { raw: signedWith([['agents', 1, 'discoveredId'], 'entra:sp:registered-1']), trusted, expected };
        case 'duplicate-source':
            return { raw: signedWith([['population', 'sources', 1, 'kind'], 'entra-sp']), trusted, expected };
        case 'wrong-contract':
            return { raw: signedWith([['contract'], 'inflect-agent-harness/4']), trusted, expected };
        case 'unknown-criterion':
            return { raw: signedWith([['agents', 0, 'verdicts', 0, 'criterion'], 'H9.made_up']), trusted, expected };
        case 'retired-v1':
            return { raw: scanner.serialise(retiredV1ReportBody()), trusted, expected };
        case 'v2-without-unbound-credentials': {
            const { unboundCredentials: _dropped, ...rest } = validV2ReportBody();
            return { raw: scanner.serialise(rest), trusted, expected };
        }
        case 'v2-unbound-credential-value':
            return { raw: signedV2With([['unboundCredentials', 0, 'ref'], fakeSecret()]), trusted, expected };
        case 'v2-unbound-secret-inside-reference':
            return { raw: signedV2With([['unboundCredentials', 0, 'ref'], `kv://${fakeSecret()}`]), trusted, expected };
        case 'v2-unbound-from-unlisted-source':
            return { raw: signedV2With([['unboundCredentials', 0, 'sourceKind'], 'cicd']), trusted, expected };
        case 'v2-unbound-twice':
            return { raw: signedV2With([['unboundCredentials', 1], { ref: UNBOUND_VAULT_REF, sourceKind: 'vault' }]), trusted, expected };
        case 'v2-unbound-but-held-by-an-agent':
            return { raw: signedV2With([['unboundCredentials', 0, 'ref'], 'kv://prod/agents/reporting']), trusted, expected };
        case 'v2-calls-without-window':
            return { raw: signedV2With([['agents', 1, 'tools', 0, 'calls'], 3]), trusted, expected };
        case 'v2-negative-calls':
            return { raw: signedV2With([['agents', 0, 'tools', 0, 'calls'], -1]), trusted, expected };
        case 'v2-secret-shaped-endpoint':
            return { raw: signedV2With([['agents', 0, 'models', 0, 'endpoint'], `https://api.example/${fakeSecret()}`]), trusted, expected };
        case 'v2-endpoint-with-userinfo':
            return { raw: signedV2With([['agents', 0, 'models', 0, 'endpoint'], 'https://svc@api.example/v1']), trusted, expected };
        case 'v2-model-with-a-prompt':
            return { raw: signedV2With([['agents', 0, 'models', 0, 'prompt'], 'You are a helpful agent.']), trusted, expected };
        // `/3`'s own body, its id put back to `/2`: everything else valid.
        case 'v2-names-gcp-sa-source':
        case 'v2-agent-discovered-via-gcp-sa':
        case 'v2-unbound-from-gcp-sa': {
            const body = { ...validV3ReportBody(), contract: HARNESS_CONTRACT_V2 } as unknown as Record<string, unknown>;
            if (kind === 'v2-agent-discovered-via-gcp-sa') {
                // The source list is `/2`'s; only the agent still names the kind.
                (body.population as { sources: unknown[] }).sources.pop();
                (body.agents as { discoveredVia: string[] }[])[2].discoveredVia = ['gcp-sa'];
            }
            if (kind === 'v2-unbound-from-gcp-sa') {
                (body.agents as unknown[]).pop();
                body.unboundCredentials = [{ ref: GCP_SA_KEY_REF, sourceKind: 'gcp-sa' }];
            }
            return { raw: scanner.serialise(body), trusted, expected };
        }
    }
}
