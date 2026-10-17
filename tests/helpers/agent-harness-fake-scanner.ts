/**
 * The REFERENCE implementation of a scanner speaking `inflect-agent-harness/1`.
 *
 * `docs/agent-harness-contract.md` names this file as the executable reference,
 * and `tests/unit/agentic/harness-contract.test.ts` validates its output against
 * `src/lib/agentic/harness-contract.ts`. Where the prose and this file disagree,
 * this file is the one the suite checks, so it is the one to copy.
 *
 * It produces one valid signed report and, on request, every malformation the
 * contract tells an ingest to refuse, each paired with the refusal it must get.
 *
 * Secret-shaped fixtures are assembled at runtime from fragments, so no literal
 * credential pattern exists in this file for the secret scanners to flag.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'crypto';

import {
    HARNESS_CONTRACT_ID,
    MAX_REPORT_BYTES,
    harnessSignedMessage,
    type HarnessRefusal,
    type HarnessReportBody,
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

/** A valid report body: one registered agent at H2, one shadow agent at H0. */
export function validReportBody(): HarnessReportBody {
    return {
        contract: HARNESS_CONTRACT_ID,
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

/** The same valid body with one source honestly reported as incomplete. */
export function validIncompleteReportBody(): HarnessReportBody {
    const body = validReportBody();
    body.population.sources[2] = { kind: 'mcp', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 1 };
    return body;
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
            return { raw: signedWith([['contract'], 'inflect-agent-harness/2']), trusted, expected };
        case 'unknown-criterion':
            return { raw: signedWith([['agents', 0, 'verdicts', 0, 'criterion'], 'H9.made_up']), trusted, expected };
    }
}
