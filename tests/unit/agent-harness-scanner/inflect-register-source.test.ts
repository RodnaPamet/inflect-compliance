/**
 * The scanner's register source over the fixture tenant (#3686, part c).
 *
 *   1. ONE NAMED TOOL, ON ITS OWN TENANT (DPIA condition 2, owner decision 7):
 *      the handshake and one `tools/call` of `get_harness_register` to the
 *      ingest host's `/api/mcp`, with the ingest key, and nothing else.
 *   2. WHAT IT REPORTS (owner decision 4): each agent, as its confirmed
 *      principal when a person confirmed one, with its owner, its own keys by
 *      reference and the verdicts the register can evidence — and no "no" for a
 *      credential it cannot see.
 *   3. THE REGISTER ALONE LINKS: the report carries the register source's
 *      `registeredAgentId`, and drops the same member from any other source.
 *   4. A read that cannot be trusted is INCOMPLETE with the contract's reason.
 *   5. Through the runner, beside the Entra source: one agent, linked, via both.
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
    registerFixture,
    type Fakes,
} from '../../helpers/agent-harness-source-fakes';
import { verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { ConfigError, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { createSourceWire } from '../../../packages/agent-harness-scanner/src/http';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { buildReportBody, rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import { isDeclaredRegisterMessage, isDeclaredRequest } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import { inflectRegisterSource } from '../../../packages/agent-harness-scanner/src/sources/inflect-register';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');
const INGEST_KEY_VALUE = 'iflk_fake-ingest-key-3686';
const SUPPORT_SP = `entra:sp:${ENTRA.spSupport}`;

async function read(fakes: Fakes): Promise<SourceRead> {
    const wire = createSourceWire({ fetchImpl: fakes.fetchImpl, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
    return inflectRegisterSource({ baseUrl: INGEST, tenantSlug: 'acme', apiKey: INGEST_KEY_VALUE }).read({
        asOf: ASOF,
        deadline: ASOF.getTime() + 60_000,
        now: () => ASOF.getTime(),
        ...wire,
    });
}

describe('1. one named tool, on its own tenant', () => {
    it('the handshake and one tools/call of get_harness_register, with the ingest key', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);
        expect(result).toMatchObject({ kind: 'inflect-register', status: 'COMPLETE', rows: 2 });
        expect(fakes.log.map((r) => `${r.method} ${r.host}${r.path} ${r.rpc}`)).toEqual([
            'POST inflect.example.com/api/mcp initialize',
            'POST inflect.example.com/api/mcp notifications/initialized',
            'POST inflect.example.com/api/mcp tools/call',
        ]);
        for (const r of fakes.log) {
            expect(isDeclaredRegisterMessage(r.body ?? '')).toBe(true);
            expect(isDeclaredRequest(r.method, `https://${r.host}${r.path}`)).toBe(true);
        }
        expect(fakes.ingestAuth).toEqual([`Bearer ${INGEST_KEY_VALUE}`, `Bearer ${INGEST_KEY_VALUE}`, `Bearer ${INGEST_KEY_VALUE}`]);
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
        const logText = lines.join('\n');
        for (const never of [...NEVER_REPORTED, INGEST_KEY_VALUE]) {
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
