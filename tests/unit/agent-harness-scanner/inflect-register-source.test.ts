/**
 * The scanner's register source over the fixture tenant (#3686, part c).
 *
 *   1. ONE NAMED TOOL, ON ITS OWN TENANT (DPIA condition 2, owner decision 7):
 *      the key exchanged at `/api/mcp/token` for a token naming that one tool
 *      (#5004), then the handshake and one `tools/call` of
 *      `get_harness_register` to the ingest host's `/api/mcp` on that token,
 *      and nothing else. The key never reaches `/api/mcp`.
 *   2. WHAT IT REPORTS (owner decision 4): each agent, as its confirmed
 *      principal when a person confirmed one, with its owner, its own keys by
 *      reference and the verdicts the register can evidence — and no "no" for a
 *      credential it cannot see.
 *   3. THE REGISTER ALONE LINKS: the report carries the register source's
 *      `registeredAgentId`, and drops the same member from any other source.
 *   4. A read that cannot be trusted is INCOMPLETE with the contract's reason.
 *   5. Through the runner, beside the Entra source: one agent, linked, via both.
 *   6. WHAT THE GATE ENFORCES (#5004): audience tokens from the keys, pinned
 *      manifests, the four no-write H3 criteria on the enforced bound only, and
 *      the scanner's own payload guards on its own agent only.
 *   7. THE EGRESS PROOF (#5004 part C): this scan's, on the scanner's own agent
 *      only, a "no" when it failed, nothing when no proxy is configured — and
 *      through the runner, taken before the sources read.
 */
import { generateKeyPairSync } from 'crypto';

import {
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET_VALUE,
    createSourceFakes,
    ENTRA,
    ENTRA_DIRECTORY_ID,
    INGEST,
    MCP_MARKERS,
    NEVER_REPORTED,
    REGISTER_EXCHANGED_TOKEN,
    registerFixture,
    type Fakes,
    type RegisterFixture,
} from '../../helpers/agent-harness-source-fakes';
import {
    ACCESS_TOKEN_TYPE as SERVER_ACCESS_TOKEN_TYPE,
    TOKEN_EXCHANGE_GRANT_TYPE as SERVER_TOKEN_EXCHANGE_GRANT,
} from '@/lib/mcp/token-exchange';
import { verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { ConfigError, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { ACCESS_TOKEN_TYPE, createSourceWire, TOKEN_EXCHANGE_GRANT } from '../../../packages/agent-harness-scanner/src/http';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { buildReportBody, rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import {
    isDeclaredRegisterExchange,
    isDeclaredRegisterMessage,
    isDeclaredRequest,
} from '../../../packages/agent-harness-scanner/src/scanner-surface';
import { inflectRegisterSource, READ_ONLY_BOUND_CRITERIA } from '../../../packages/agent-harness-scanner/src/sources/inflect-register';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';
import type { EgressProbe, EgressProof } from '../../../packages/agent-harness-scanner/src/egress-proof';

const ASOF = new Date('2026-10-19T03:00:00.000Z');
const INGEST_KEY_VALUE = 'iflk_fake-ingest-key-3686';
const SUPPORT_SP = `entra:sp:${ENTRA.spSupport}`;

async function read(fakes: Fakes, scannerAgentId?: string, egressProof?: EgressProof): Promise<SourceRead> {
    const wire = createSourceWire({ fetchImpl: fakes.fetchImpl, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
    return inflectRegisterSource({ baseUrl: INGEST, tenantSlug: 'acme', apiKey: INGEST_KEY_VALUE, scannerAgentId, egressProof }).read({
        asOf: ASOF,
        deadline: ASOF.getTime() + 60_000,
        now: () => ASOF.getTime(),
        ...wire,
    });
}

describe('1. one named tool, on its own tenant', () => {
    it('the key exchanged for a token naming the tool, then the handshake and one tools/call on that token', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);
        expect(result).toMatchObject({ kind: 'inflect-register', status: 'COMPLETE', rows: 2 });
        expect(fakes.log.map((r) => `${r.method} ${r.host}${r.path} ${r.rpc ?? '-'}`)).toEqual([
            'POST inflect.example.com/api/mcp/token -',
            'POST inflect.example.com/api/mcp initialize',
            'POST inflect.example.com/api/mcp notifications/initialized',
            'POST inflect.example.com/api/mcp tools/call',
        ]);
        const [exchange, ...messages] = fakes.log;
        expect(isDeclaredRegisterExchange(exchange.body ?? '')).toBe(true);
        expect(JSON.parse(exchange.body ?? '{}')).toEqual({
            grant_type: TOKEN_EXCHANGE_GRANT,
            subject_token: INGEST_KEY_VALUE,
            audience: ['get_harness_register'],
            requested_token_type: ACCESS_TOKEN_TYPE,
        });
        for (const r of messages) expect(isDeclaredRegisterMessage(r.body ?? '')).toBe(true);
        for (const r of fakes.log) expect(isDeclaredRequest(r.method, `https://${r.host}${r.path}`)).toBe(true);
        // The MCP endpoint saw the exchanged token, three times, and never the key.
        expect(fakes.ingestAuth).toEqual(Array.from({ length: 3 }, () => `Bearer ${REGISTER_EXCHANGED_TOKEN}`));
        for (const r of messages) expect(r.body).not.toContain(INGEST_KEY_VALUE);
    });

    it('spells the exchange as the server takes it', () => {
        expect(TOKEN_EXCHANGE_GRANT).toBe(SERVER_TOKEN_EXCHANGE_GRANT);
        expect(ACCESS_TOKEN_TYPE).toBe(SERVER_ACCESS_TOKEN_TYPE);
    });

    it('the declared exchange is for the register tool alone', () => {
        const body = (audience: unknown) => JSON.stringify({ grant_type: TOKEN_EXCHANGE_GRANT, subject_token: 'iflk_x', audience });
        expect(isDeclaredRegisterExchange(body(['get_harness_register']))).toBe(true);
        expect(isDeclaredRegisterExchange(body(['get_harness_register', 'list_controls']))).toBe(false);
        expect(isDeclaredRegisterExchange(body('get_harness_register'))).toBe(false);
        expect(isDeclaredRegisterExchange(body(['propose_risks']))).toBe(false);
    });

    it('the declared surface admits that one tool and no other', () => {
        const call = (name: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
        expect(isDeclaredRegisterMessage(call('get_harness_register'))).toBe(true);
        for (const other of ['get_discovered_agent', 'propose_risk', 'list_controls']) expect(isDeclaredRegisterMessage(call(other))).toBe(false);
        expect(isDeclaredRegisterMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read' }))).toBe(false);
    });
});

describe('2. what it reports', () => {
    it('an agent with no confirmed principal as inflect:agent:<id>, with its own key by reference and its verdicts', async () => {
        const result = await read(createSourceFakes());
        const scanner = result.observations.find((o) => o.discoveredId === 'inflect:agent:agt_scanner_acme');
        expect(scanner).toMatchObject({
            registeredAgentId: 'agt_scanner_acme',
            owner: { kind: 'user', id: 'usr_owner_acme', source: 'inflect-register' },
            credentials: [
                { ref: 'inflect://inflect.example.com/t/acme/api-keys/key_ingest_acme', ageDays: 10, expires: true, boundToAgent: true, grant: 'app-only' },
            ],
        });
        expect(scanner?.verdicts.map((v) => [v.criterion, v.met])).toEqual([
            ['H1.registered', true],
            ['H1.owner', true],
            ['H1.axes_declared', true],
            ['H1.tier_scored_fresh', true],
            ['H2.tools_allowlisted', true],
            ['H2.policy_card', true],
            ['H2.credential_bound', true],
            ['H2.grant_kind_declared', true],
            ['H2.audience_tokens', true],
            ['H3.manifests_pinned', true],
            ['H3.propose_not_commit', true],
            ['H3.prior_state_reads', true],
            ['H3.skills_declared', true],
            ['H3.delegation_narrows', true],
        ]);
        expect(scanner?.verdicts.every((v) => v.evidence?.startsWith('inflect-register:agents/agt_scanner_acme#'))).toBe(true);
    });

    it('a confirmed principal as itself; no key means no answer on the credential, never a no', async () => {
        const result = await read(createSourceFakes());
        const support = result.observations.find((o) => o.discoveredId === SUPPORT_SP);
        expect(support).toMatchObject({ registeredAgentId: 'agt_support_acme', credentials: [] });
        const answered = new Map(support?.verdicts.map((v) => [v.criterion, v.met]));
        expect(answered.get('H1.tier_scored_fresh')).toBe(false);
        expect(answered.get('H2.policy_card')).toBe(false);
        expect(answered.has('H2.credential_bound')).toBe(false);
        expect(answered.has('H2.grant_kind_declared')).toBe(false);
        expect(answered.has('H2.audience_tokens')).toBe(false);
        expect(result.observations.some((o) => o.discoveredId === 'inflect:agent:agt_support_acme')).toBe(false);
    });
});

describe('3. the register alone links', () => {
    it('another source\'s registeredAgentId is dropped; the register\'s is kept, and merges with the same principal', () => {
        const estate: SourceRead = {
            kind: 'entra-sp',
            status: 'COMPLETE',
            rows: 2,
            observations: [
                // A label in the estate claiming a register row: dropped.
                { discoveredId: 'entra:sp:other', owner: null, credentials: [], verdicts: [], registeredAgentId: 'agt_support_acme' },
                { discoveredId: SUPPORT_SP, owner: null, credentials: [], verdicts: [] },
            ],
        };
        const register: SourceRead = {
            kind: 'inflect-register',
            status: 'COMPLETE',
            rows: 1,
            observations: [{ discoveredId: SUPPORT_SP, owner: null, credentials: [], verdicts: [], registeredAgentId: 'agt_support_acme' }],
        };
        const body = buildReportBody({ scanId: 's-1', asOf: ASOF, scannerAgentId: 'agt_scanner_acme' }, [estate, register]);
        const byId = new Map(body.agents.map((a) => [a.discoveredId, a]));
        expect(byId.get('entra:sp:other')?.registeredAgentId).toBeNull();
        expect(byId.get(SUPPORT_SP)).toMatchObject({ registeredAgentId: 'agt_support_acme', discoveredVia: ['entra-sp', 'inflect-register'] });
    });
});

describe('4. a read that cannot be trusted is INCOMPLETE', () => {
    it('a register the server calls truncated is BYTE_CAP, and what was read is still reported', async () => {
        const register = { ...registerFixture(), truncated: true };
        const result = await read(createSourceFakes({ register }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 2 });
        expect(result.observations).toHaveLength(2);
    });

    it('a payload with a member the register does not define is PAGINATION_TORN', async () => {
        const register = registerFixture();
        (register.agents[0] as Record<string, unknown>).name = 'Acme scanner';
        expect(await read(createSourceFakes({ register }))).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN', observations: [] });
    });

    it('a refused key is AUTH_FAILED', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/api/mcp' ? { status: 403 } : undefined);
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED' });
    });

    it('a refused exchange is AUTH_FAILED, and nothing is sent to /api/mcp', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/api/mcp/token' ? { status: 401 } : undefined);
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED' });
        expect(fakes.log.filter((r) => r.path === '/api/mcp')).toEqual([]);
    });

    it('an exchange that answers with anything but an exchanged token is refused, never forwarded', async () => {
        for (const access_token of [INGEST_KEY_VALUE, 'ifxt_no-signature', '', 42]) {
            const fakes = createSourceFakes();
            fakes.override = (r) => (r.path === '/api/mcp/token' ? { status: 201, body: { access_token } } : undefined);
            expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED' });
            expect(fakes.log.filter((r) => r.path === '/api/mcp')).toEqual([]);
        }
    });

    it('a register without the enforcement member is PAGINATION_TORN', async () => {
        const register = registerFixture();
        delete (register.agents[0] as Partial<RegisterFixture['agents'][number]>).enforcement;
        expect(await read(createSourceFakes({ register }))).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });
});

describe('5. through the runner, beside the Entra source', () => {
    it('one agent, linked by the register, via both — and a report the ingest verifies', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const fakes = createSourceFakes();
        const lines: string[] = [];
        const { raw, body } = await runScan({
            config: parseScannerConfig({
                estate: 'acme-pilot',
                scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
                inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
                schedule: { everyHours: 24 },
                sources: [
                    { kind: 'entra-sp', directoryId: ENTRA_DIRECTORY_ID, clientId: AZURE_CLIENT_ID, clientSecretEnv: 'ENTRA_CLIENT_SECRET' },
                    { kind: 'inflect-register' },
                ],
            }),
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                INFLECT_INGEST_KEY: INGEST_KEY_VALUE,
                ENTRA_CLIENT_SECRET: AZURE_CLIENT_SECRET_VALUE,
            },
            log: jsonLineLog((l) => lines.push(l)),
            fetchImpl: fakes.fetchImpl,
            now: () => ASOF.getTime(),
        });
        expect(verifyAndParseHarnessReport(raw, [rawPublicKeyHex(publicKey)])).toMatchObject({ ok: true, complete: true });
        const support = body.agents.find((a) => a.discoveredId === SUPPORT_SP);
        expect(support).toMatchObject({ registeredAgentId: 'agt_support_acme', discoveredVia: ['entra-sp', 'inflect-register'] });
        // The Entra source's evidence of a bound credential is not outvoted by the register's silence.
        expect(support?.verdicts.find((v) => v.criterion === 'H2.credential_bound')).toMatchObject({ met: true });
        expect(body.agents.find((a) => a.discoveredId === 'inflect:agent:agt_scanner_acme')?.registeredAgentId).toBe('agt_scanner_acme');
        // The one tool call made was the register read.
        expect(fakes.log.filter((r) => r.rpc === 'tools/call')).toHaveLength(1);
        expect(raw).not.toContain(MCP_MARKERS.toolCallResult);
        // The scanner's own agent carries its payload guards; no other agent does.
        const own = body.agents.find((a) => a.discoveredId === 'inflect:agent:agt_scanner_acme');
        expect(own?.verdicts.find((v) => v.criterion === 'H3.payloads_guarded')).toMatchObject({ met: true });
        expect(support?.verdicts.some((v) => v.criterion === 'H3.payloads_guarded')).toBe(false);
        const logText = lines.join('\n');
        for (const never of [...NEVER_REPORTED, INGEST_KEY_VALUE, REGISTER_EXCHANGED_TOKEN]) {
            expect(raw).not.toContain(never);
            expect(logText).not.toContain(never);
        }
    });

    it('the source takes no field, and refuses one', () => {
        const base = {
            estate: 'acme-pilot',
            scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
        };
        expect(() => parseScannerConfig({ ...base, sources: [{ kind: 'inflect-register' }] })).not.toThrow();
        expect(() => parseScannerConfig({ ...base, sources: [{ kind: 'inflect-register', tool: 'list_controls' }] })).toThrow(ConfigError);
    });
});

describe('6. what the gate enforces', () => {
    const verdicts = async (register: RegisterFixture, id: string, scannerAgentId?: string) => {
        const result = await read(createSourceFakes({ register }), scannerAgentId);
        const obs = result.observations.find((o) => o.registeredAgentId === id);
        return new Map(obs?.verdicts.map((v) => [v.criterion, v.met]));
    };
    const scannerOf = (r: RegisterFixture) => r.agents[0];

    it('off the bound, the four are unanswered — not a no — and an agent with no key gives no answer on tokens', async () => {
        const answered = await verdicts(registerFixture(), 'agt_support_acme');
        for (const c of READ_ONLY_BOUND_CRITERIA) expect(answered.has(c)).toBe(false);
        expect(answered.get('H3.manifests_pinned')).toBe(false);
        expect(answered.has('H2.audience_tokens')).toBe(false);
    });

    it.each([
        ['propose is admitted', { proposeRefused: false }],
        ['orchestrate is admitted', { orchestrateRefused: false }],
        ['a propose grant', { grants: { read: 1, propose: 1, external: 0 } }],
        ['an external grant', { grants: { read: 1, propose: 0, external: 1 } }],
        ['a profile in force', { profileInForce: true }],
        ['a run mounted a skill', { skillsMounted: true }],
        ['the runs could not be read', { skillsMounted: null }],
    ])('one term short of the bound — %s — leaves all four unanswered', async (_label, over) => {
        const register = registerFixture();
        scannerOf(register).enforcement = { ...scannerOf(register).enforcement, ...over };
        const answered = await verdicts(register, 'agt_scanner_acme');
        for (const c of READ_ONLY_BOUND_CRITERIA) expect(answered.has(c)).toBe(false);
    });

    it('audience tokens: met only when every key that reaches /api/mcp requires the exchange', async () => {
        const register = registerFixture();
        const key = scannerOf(register).apiKeys[0];
        scannerOf(register).apiKeys = [key, { ...key, id: 'key_raw_acme', requiresTokenExchange: false }];
        expect((await verdicts(register, 'agt_scanner_acme')).get('H2.audience_tokens')).toBe(false);
        // A key that cannot reach the endpoint is not counted either way.
        scannerOf(register).apiKeys = [key, { ...key, id: 'key_rest_acme', mcpCapable: false, requiresTokenExchange: false }];
        expect((await verdicts(register, 'agt_scanner_acme')).get('H2.audience_tokens')).toBe(true);
        // Only keys that cannot reach it: unanswered.
        scannerOf(register).apiKeys = [{ ...key, mcpCapable: false }];
        expect((await verdicts(register, 'agt_scanner_acme')).has('H2.audience_tokens')).toBe(false);
    });

    it('payloads guarded: on the scanner\'s own agent, and only there', async () => {
        expect((await verdicts(registerFixture(), 'agt_scanner_acme', 'agt_scanner_acme')).get('H3.payloads_guarded')).toBe(true);
        expect((await verdicts(registerFixture(), 'agt_support_acme', 'agt_scanner_acme')).has('H3.payloads_guarded')).toBe(false);
        expect((await verdicts(registerFixture(), 'agt_scanner_acme')).has('H3.payloads_guarded')).toBe(false);
    });
});

describe('7. the egress proof', () => {
    const PROOF_MET: EgressProof = { met: true, failed: null, evidence: 'egress:proxy=harness-egress:3128;direct=blocked' };
    const PROOF_FAILED: EgressProof = { met: false, failed: 'DIRECT_EGRESS_OPEN', evidence: 'egress:failed=DIRECT_EGRESS_OPEN' };
    const egressOf = async (proof: EgressProof | undefined, id: string) => {
        const result = await read(createSourceFakes(), 'agt_scanner_acme', proof);
        return result.observations.find((o) => o.registeredAgentId === id)?.verdicts.find((v) => v.criterion === 'H3.egress_enforced');
    };

    it('is reported on the scanner\'s own agent, met or not, with the proof\'s own evidence', async () => {
        expect(await egressOf(PROOF_MET, 'agt_scanner_acme')).toEqual({ criterion: 'H3.egress_enforced', met: true, evidence: PROOF_MET.evidence });
        expect(await egressOf(PROOF_FAILED, 'agt_scanner_acme')).toMatchObject({ met: false });
    });

    it('says nothing about any other agent, and nothing when no proxy is configured', async () => {
        expect(await egressOf(PROOF_MET, 'agt_support_acme')).toBeUndefined();
        expect(await egressOf(undefined, 'agt_scanner_acme')).toBeUndefined();
    });

    it('through the runner: proven before the sources read, and in the signed report', async () => {
        const { privateKey } = generateKeyPairSync('ed25519');
        const calls: string[] = [];
        const probe: EgressProbe = {
            connectThrough: async (_proxy, target) => {
                calls.push(`CONNECT ${target}`);
                return target === 'inflect.example.com:443' ? 200 : 403;
            },
            dialDirect: async (host, port) => {
                calls.push(`TCP ${host}:${port}`);
                return false;
            },
        };
        const fakes = createSourceFakes();
        const { body } = await runScan({
            config: parseScannerConfig({
                estate: 'acme-pilot',
                scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
                inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
                schedule: { everyHours: 24 },
                egress: { proxyUrl: 'http://harness-egress:3128', canaryHost: 'example.com' },
                sources: [{ kind: 'inflect-register' }],
            }),
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                INFLECT_INGEST_KEY: INGEST_KEY_VALUE,
                HTTPS_PROXY: 'http://harness-egress:3128',
                NODE_USE_ENV_PROXY: '1',
            },
            log: jsonLineLog(() => {}),
            fetchImpl: fakes.fetchImpl,
            egressProbe: probe,
            now: () => ASOF.getTime(),
        });
        expect(calls).toEqual(['CONNECT inflect.example.com:443', 'CONNECT example.com:443', 'TCP inflect.example.com:443']);
        const own = body.agents.find((a) => a.discoveredId === 'inflect:agent:agt_scanner_acme');
        expect(own?.verdicts.find((v) => v.criterion === 'H3.egress_enforced')).toMatchObject({ met: true });
    });

    it('the configuration takes only an http proxy URL and a hostname canary', () => {
        const base = {
            estate: 'acme-pilot',
            scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'inflect-register' }],
        };
        const withEgress = (egress: unknown) => () => parseScannerConfig({ ...base, egress });
        expect(withEgress({ proxyUrl: 'http://harness-egress:3128', canaryHost: 'example.com' })).not.toThrow();
        for (const bad of [
            { proxyUrl: 'https://harness-egress:3128', canaryHost: 'example.com' },
            { proxyUrl: 'http://u:p@harness-egress:3128', canaryHost: 'example.com' },
            { proxyUrl: 'http://harness-egress:3128/path', canaryHost: 'example.com' },
            { proxyUrl: 'http://harness-egress:3128', canaryHost: 'Example.com' },
            { proxyUrl: 'http://harness-egress:3128', canaryHost: '*.example.com' },
            { proxyUrl: 'http://harness-egress:3128', canaryHost: 'example.com', extra: true },
        ]) {
            expect(withEgress(bad)).toThrow(ConfigError);
        }
    });
});
