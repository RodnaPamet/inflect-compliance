/**
 * The `inflect-agent-harness/1` contract (#3660) and `/2` (#3754), validated
 * against their reference implementation,
 * `tests/helpers/agent-harness-fake-scanner.ts`.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';

import { canonicalJson } from '@/lib/canonical-json';
import {
    HARNESS_CONTRACT_IDS,
    HARNESS_CONTRACT_V1,
    HARNESS_CONTRACT_V2,
    INCOMPLETE_REASONS,
    INCOMPLETE_REASONS_V1,
    INCOMPLETE_REASONS_V2,
    SOURCE_KINDS,
    SOURCE_KINDS_V1,
    SOURCE_KINDS_V2,
    harnessSignedMessage,
    isScanComplete,
    looksLikeSecret,
    parseStoredHarnessSources,
    parseStoredHarnessTools,
    verifyAndParseHarnessReport,
    type HarnessRefusal,
} from '@/lib/agentic/harness-contract';
import { firstSecretShapedMember } from '@/lib/agentic/harness-findings';
import { scoreHarness } from '@/lib/agentic/harness-ladder';

import {
    MALFORMATIONS,
    UNBOUND_VAULT_REF,
    V2_MODEL_ENDPOINTS,
    createFakeScanner,
    malformedReport,
    validIncompleteReportBody,
    validReportBody,
    validV2ReportBody,
    type Malformation,
} from '../../helpers/agent-harness-fake-scanner';
import { REPO_ROOT, repoFiles } from '../../helpers/repo-files';

const scanner = createFakeScanner();

describe('a valid report from the reference scanner', () => {
    it('verifies and parses, and is complete when every source is', () => {
        const result = verifyAndParseHarnessReport(scanner.serialise(validReportBody()), [scanner.publicKeyHex]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.complete).toBe(true);
        expect(result.body.agents.map((a) => a.discoveredId)).toEqual(['entra:sp:registered-1', 'entra:sp:shadow-1']);
    });

    it('parses an honestly incomplete report, and derives that it is not complete', () => {
        const result = verifyAndParseHarnessReport(scanner.serialise(validIncompleteReportBody()), [scanner.publicKeyHex]);
        expect(result.ok && result.complete).toBe(false);
        expect(result.ok).toBe(true);
    });

    it('carries verdicts the ladder scores, not a level', () => {
        const result = verifyAndParseHarnessReport(scanner.serialise(validReportBody()), [scanner.publicKeyHex]);
        if (!result.ok) throw new Error(result.reason);
        const [registered, shadow] = result.body.agents;
        expect(scoreHarness(registered.verdicts).level).toBe('H2');
        expect(scoreHarness(shadow.verdicts).level).toBe('H0');
        expect(registered).not.toHaveProperty('level');
    });

    it('verifies regardless of the key order on the wire, because the signed form is canonical', () => {
        const body = validReportBody();
        const signature = scanner.signBody(body);
        const reordered = JSON.stringify({ signature, findings: body.findings, agents: body.agents, population: body.population, scan: body.scan, contract: body.contract });
        expect(verifyAndParseHarnessReport(reordered, [scanner.publicKeyHex]).ok).toBe(true);
    });

    it('signs SHA-256 over the canonical JSON of the body', () => {
        const body = validReportBody();
        expect(harnessSignedMessage(body).equals(createHash('sha256').update(canonicalJson(body), 'utf8').digest())).toBe(true);
    });
});

describe('every malformation the contract names is refused with its reason', () => {
    it.each(Object.keys(MALFORMATIONS) as Malformation[])('%s', (kind) => {
        const { raw, trusted, expected } = malformedReport(scanner, kind);
        const result = verifyAndParseHarnessReport(raw, trusted);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe(expected);
        if (expected === 'SCHEMA') expect(result.issues?.length).toBeGreaterThan(0);
    });

    it('a SCHEMA refusal names no part of the body: an unknown key is counted, never quoted', () => {
        // Built at runtime so no literal credential pattern sits in this file.
        const secret = ['gh', 'p_', 'Q'.repeat(36)].join('');
        expect(looksLikeSecret(secret)).toBe(true);
        const body = validReportBody() as unknown as { agents: Array<Record<string, unknown>> } & Record<string, unknown>;
        body.agents[0][secret] = 'x';
        body[`${secret}_root`] = 'y';
        const result = verifyAndParseHarnessReport(scanner.serialise(body), [scanner.publicKeyHex]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('SCHEMA');
        expect(result.issues).toEqual(expect.arrayContaining(['agents.0: 1 unrecognized key', '(root): 1 unrecognized key']));
        expect((result.issues ?? []).join(' ')).not.toContain(secret);
    });

    it('produces every refusal code at least once, so no code is untested', () => {
        const codes: HarnessRefusal[] = [
            'TOO_LARGE', 'NOT_JSON', 'NOT_AN_OBJECT', 'UNSIGNED', 'MALFORMED_SIGNATURE', 'UNTRUSTED_SIGNER', 'BAD_SIGNATURE', 'SCHEMA',
        ];
        expect(new Set(Object.values(MALFORMATIONS))).toEqual(new Set(codes));
    });

    it('refuses a report from a valid but unregistered scanner even though its signature verifies', () => {
        const other = createFakeScanner();
        const raw = other.serialise(validReportBody());
        expect(verifyAndParseHarnessReport(raw, [other.publicKeyHex]).ok).toBe(true);
        expect(verifyAndParseHarnessReport(raw, [scanner.publicKeyHex])).toEqual({ ok: false, reason: 'UNTRUSTED_SIGNER' });
        expect(verifyAndParseHarnessReport(raw, [])).toEqual({ ok: false, reason: 'UNTRUSTED_SIGNER' });
    });
});

describe('completeness is derived, never declared', () => {
    it('is false for a report whose sources list is empty', () => {
        expect(isScanComplete({ population: { sources: [] } })).toBe(false);
    });
});

describe('looksLikeSecret', () => {
    const fragments = (...parts: string[]) => parts.join('');

    it.each([
        fragments('gh', 'p_', 'Z'.repeat(36)),
        fragments('AK', 'IA', 'Q'.repeat(16)),
        fragments('-----BEGIN ', 'PRIVATE KEY-----'),
        fragments('xo', 'xb-', '1234567890-abc'),
        fragments('https://svc-reader:', 'S3cret', 'Pass', '@vault.corp.example/v1/audit'),
        fragments('ldaps://cn=svc:', 'hunter', '22', '@dc1.corp:636'),
        fragments('see https://ops@corp.example:', 'pa', 'ss', '@host.example/x'),
    ])('flags a credential shape', (value) => {
        expect(looksLikeSecret(value)).toBe(true);
    });

    it.each([
        'kv://prod/agents/reporting',
        'vault://secret/data/agents/sales-bot',
        'keyid://9f1c',
        // A `:` and an `@` AFTER the authority are a locator, not a credential.
        'kv://prod/agents:reporting@v2',
        // A username alone is not a secret.
        'ssh://git@github.example/org/repo',
        'https://graph.example.com/servicePrincipals/1',
    ])('accepts the reference %s', (value) => {
        expect(looksLikeSecret(value)).toBe(false);
    });
});

describe('inflect-agent-harness/2 (#3754)', () => {
    // Built at runtime so no literal credential pattern sits in this file.
    const secret = () => ['gh', 'p_', 'Q'.repeat(36)].join('');
    const verify = (body: unknown) => verifyAndParseHarnessReport(scanner.serialise(body), [scanner.publicKeyHex]);
    const issuesOf = (body: unknown): string[] => {
        const result = verify(body);
        if (result.ok) throw new Error('expected a refusal');
        expect(result.reason).toBe('SCHEMA');
        return result.issues ?? [];
    };

    it('verifies, carrying the code source, the UNPARSEABLE reason and the unbound credential as signed', () => {
        const result = verify(validV2ReportBody());
        if (!result.ok) throw new Error(result.reason);
        expect(result.body.contract).toBe(HARNESS_CONTRACT_V2);
        expect(result.body.population.sources).toContainEqual({ kind: 'code', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: 4 });
        if (result.body.contract !== HARNESS_CONTRACT_V2) throw new Error('narrowed to /2');
        expect(result.body.unboundCredentials).toEqual([{ ref: UNBOUND_VAULT_REF, sourceKind: 'vault' }]);
        // The code source stopped early, so the scan is not complete.
        expect(result.complete).toBe(false);
    });

    it('is complete only when the code source is read in full too, and an empty unbound list is valid', () => {
        const body = validV2ReportBody();
        body.population.sources = body.population.sources.map((s) => (s.kind === 'code' ? { kind: 'code', status: 'COMPLETE', rows: 4 } : s));
        body.unboundCredentials = [];
        expect(verify(body)).toMatchObject({ ok: true, complete: true });
    });

    it('a /1 report still verifies, and is held to /1 whatever it carries', () => {
        expect(verify(validReportBody())).toMatchObject({ ok: true, body: { contract: HARNESS_CONTRACT_V1 } });
        // Each /2 addition, on a /1 report, is refused by the /1 schema — never
        // read as a /2 report that forgot to say so.
        const unbound = { ...validReportBody(), unboundCredentials: [{ ref: UNBOUND_VAULT_REF, sourceKind: 'vault' }] };
        expect(issuesOf(unbound)).toContain('(root): 1 unrecognized key');
        const code = validReportBody() as unknown as { population: { sources: unknown[] } };
        code.population.sources.push({ kind: 'code', status: 'COMPLETE', rows: 1 });
        expect(issuesOf(code).some((i) => i.startsWith('population.sources.4.kind:'))).toBe(true);
        const unparseable = validReportBody() as unknown as { population: { sources: unknown[] } };
        unparseable.population.sources[2] = { kind: 'mcp', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: 1 };
        expect(issuesOf(unparseable).some((i) => i.startsWith('population.sources.2.reason:'))).toBe(true);
    });

    it('a /2 report must carry its member, and is checked against /2, not /1', () => {
        const { unboundCredentials: _absent, ...missing } = validV2ReportBody();
        expect(issuesOf(missing).some((i) => i.startsWith('unboundCredentials:'))).toBe(true);
        // The same body relabelled /1 fails on exactly what /1 lacks.
        const relabelled = { ...validV2ReportBody(), contract: HARNESS_CONTRACT_V1 };
        const issues = issuesOf(relabelled);
        expect(issues).toContain('(root): 1 unrecognized key');
        expect(issues.some((i) => i.startsWith('population.sources.4.'))).toBe(true);
    });

    it('the verify order holds for /2: the signature covers the new member and is checked before the schema', () => {
        const parsed = JSON.parse(scanner.serialise(validV2ReportBody())) as { unboundCredentials: { ref: string }[] };
        parsed.unboundCredentials[0].ref = 'kv://prod/agents/someone-else';
        expect(verifyAndParseHarnessReport(JSON.stringify(parsed), [scanner.publicKeyHex])).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
        // A /2 body with a schema fault, signed by a key nobody trusts, is refused
        // as UNTRUSTED_SIGNER: the schema is never reached.
        const other = createFakeScanner();
        const broken = { ...validV2ReportBody(), unboundCredentials: [{ ref: secret(), sourceKind: 'vault' }] };
        expect(verifyAndParseHarnessReport(other.serialise(broken), [scanner.publicKeyHex])).toEqual({ ok: false, reason: 'UNTRUSTED_SIGNER' });
    });

    it('an id this verifier does not accept is refused without repeating it', () => {
        const issues = issuesOf({ ...validV2ReportBody(), contract: `inflect-agent-harness/${secret()}` });
        expect(issues).toEqual(['contract: not a contract id this verifier accepts']);
        const { contract: _none, ...unnamed } = validV2ReportBody();
        expect(issuesOf(unnamed)).toEqual(['contract: not a contract id this verifier accepts']);
        // Neither a prototype key nor the list's own name is an id.
        expect(issuesOf({ ...validV2ReportBody(), contract: 'constructor' })).toEqual(['contract: not a contract id this verifier accepts']);
    });

    describe('unboundCredentials[] carries references, never values', () => {
        it('the contract refuses a raw value and a secret inside a reference, naming the path only', () => {
            for (const ref of [secret(), `kv://${secret()}`, `vault://svc:${'pa'}${'ss'}word@vault.example/x`]) {
                const issues = issuesOf({ ...validV2ReportBody(), unboundCredentials: [{ ref, sourceKind: 'vault' }] });
                expect(issues.some((i) => i.startsWith('unboundCredentials.0.ref:'))).toBe(true);
                expect(issues.join(' ')).not.toContain(ref);
            }
        });

        it('the ingest\'s secret-shape walk reaches the member too, by path', () => {
            const body = validV2ReportBody();
            expect(firstSecretShapedMember(body)).toBeNull();
            body.unboundCredentials[0] = { ref: `kv://prod/${secret()}`, sourceKind: 'vault' };
            expect(firstSecretShapedMember(body)).toBe('unboundCredentials[0].ref');
        });
    });

    it('refuses an unbound list that contradicts the rest of the report', () => {
        const at = (unboundCredentials: unknown) => issuesOf({ ...validV2ReportBody(), unboundCredentials });
        // A source the report does not list.
        expect(at([{ ref: UNBOUND_VAULT_REF, sourceKind: 'cicd' }])).toEqual([
            'unboundCredentials.0.sourceKind: an unbound credential must name a source the report lists',
        ]);
        // The same reference twice from one source.
        const twice = { ref: UNBOUND_VAULT_REF, sourceKind: 'vault' };
        expect(at([twice, twice])).toEqual(['unboundCredentials.1: each unbound credential appears once per source']);
        // A credential an agent in the same report holds.
        expect(at([{ ref: 'kv://prod/agents/sales-bot', sourceKind: 'vault' }])).toEqual([
            'unboundCredentials.0.ref: a credential an agent in this report holds is not unbound',
        ]);
        // The same reference from two sources is two observations, and valid.
        const two = validV2ReportBody();
        two.unboundCredentials = [
            { ref: UNBOUND_VAULT_REF, sourceKind: 'vault' },
            { ref: UNBOUND_VAULT_REF, sourceKind: 'entra-sp' },
        ];
        expect(verify(two).ok).toBe(true);
    });

    describe('per-tool call counts and model endpoints (owner decision, 2026-10-19)', () => {
        it('a /2 report carries both, each optional, and verifies', () => {
            const result = verify(validV2ReportBody());
            if (!result.ok || result.body.contract !== HARNESS_CONTRACT_V2) throw new Error('expected a verified /2 report');
            const [registered, shadow] = result.body.agents;
            expect(registered.tools[0]).toMatchObject({ calls: 42, windowDays: 30 });
            expect(registered.models).toEqual(V2_MODEL_ENDPOINTS);
            expect(shadow.models).toBeUndefined();
            expect(shadow.tools[0]).not.toHaveProperty('calls');
        });

        it('a /1 report carrying either is refused by the /1 schema', () => {
            const calls = validReportBody() as unknown as { agents: Array<{ tools: Array<Record<string, unknown>> }> };
            Object.assign(calls.agents[0].tools[0], { calls: 1, windowDays: 1 });
            expect(issuesOf(calls)).toContain('agents.0.tools.0: 2 unrecognized keys');
            const models = { ...validReportBody() } as unknown as { agents: Array<Record<string, unknown>> };
            models.agents[0].models = [{ endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }];
            expect(issuesOf(models)).toContain('agents.0: 1 unrecognized key');
        });

        it('a count comes with its window, and both are bounded whole numbers', () => {
            const at = (tool: Record<string, unknown>) => {
                const body = validV2ReportBody() as unknown as { agents: Array<{ tools: Array<Record<string, unknown>> }> };
                const merged: Record<string, unknown> = { ...body.agents[0].tools[0], ...tool };
                // An undefined member is left out, as it would be on the wire.
                for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
                body.agents[0].tools[0] = merged;
                return issuesOf(body).filter((i) => i.startsWith('agents.0.tools.0'));
            };
            expect(at({ windowDays: undefined })).toEqual(['agents.0.tools.0.calls: a call count and its window come together or not at all']);
            expect(at({ calls: -1 }).length).toBeGreaterThan(0);
            expect(at({ calls: 1.5 }).length).toBeGreaterThan(0);
            expect(at({ windowDays: 0 }).length).toBeGreaterThan(0);
            expect(at({ windowDays: 367 }).length).toBeGreaterThan(0);
        });

        it('an endpoint is a reference or a host — never a credential, never prose', () => {
            const withEndpoint = (endpoint: string) => {
                const body = validV2ReportBody();
                body.agents[0].models = [{ endpoint, model: 'gpt-4o-mini' }];
                return body;
            };
            for (const ok of ['https://api.openai.com/v1', 'env://AZURE_OPENAI_ENDPOINT', 'code://acme/agent.py#L4', 'llm-gateway.internal.example:8443']) {
                expect(verify(withEndpoint(ok)).ok).toBe(true);
            }
            for (const bad of [
                `https://api.example/${secret()}`,
                ['https://svc:', 'pa', 'ss', 'word@api.example/v1'].join(''),
                'https://svc@api.example/v1',
                'call the model with this prompt',
                '',
            ]) {
                const issues = issuesOf(withEndpoint(bad));
                expect(issues.some((i) => i.startsWith('agents.0.models.0.endpoint'))).toBe(true);
                if (bad !== '') expect(issues.join(' ')).not.toContain(bad);
            }
            // A model entry carries an endpoint and an id, and nothing else.
            const prompt = validV2ReportBody() as unknown as { agents: Array<{ models: Array<Record<string, unknown>> }> };
            prompt.agents[0].models[0].prompt = 'You are a helpful agent.';
            expect(issuesOf(prompt)).toContain('agents.0.models.0: 1 unrecognized key');
        });

        it('the ingest\'s secret-shape walk reaches an endpoint and a model id too', () => {
            const body = validV2ReportBody();
            body.agents[0].models = [{ endpoint: 'https://api.openai.com/v1', model: secret() }];
            expect(firstSecretShapedMember(body)).toBe('agents[0].models[0].model');
        });

        it('a stored tool keeps its count and window, and a /1 tool still reads back', () => {
            const v2Tools = JSON.parse(JSON.stringify(validV2ReportBody().agents[0].tools)) as unknown;
            expect(parseStoredHarnessTools(v2Tools)?.[0]).toMatchObject({ calls: 42, windowDays: 30 });
            const v1Tools = JSON.parse(JSON.stringify(validReportBody().agents[0].tools)) as unknown;
            expect(parseStoredHarnessTools(v1Tools)?.[0]).not.toHaveProperty('calls');
            expect(parseStoredHarnessTools([{ ...(v1Tools as object[])[0], calls: 3 }])).toBeNull();
        });
    });

    it('each id has its own lists, and the union is what stored rows are read against', () => {
        expect(HARNESS_CONTRACT_IDS).toEqual([HARNESS_CONTRACT_V1, HARNESS_CONTRACT_V2]);
        expect(SOURCE_KINDS_V2).toEqual([...SOURCE_KINDS_V1, 'code']);
        expect(INCOMPLETE_REASONS_V2).toEqual([...INCOMPLETE_REASONS_V1, 'UNPARSEABLE']);
        expect(new Set(SOURCE_KINDS)).toEqual(new Set([...SOURCE_KINDS_V1, ...SOURCE_KINDS_V2]));
        expect(new Set(INCOMPLETE_REASONS)).toEqual(new Set([...INCOMPLETE_REASONS_V1, ...INCOMPLETE_REASONS_V2]));
    });

    it('every reason an accepted id can carry has a label in each locale the harness tab renders', () => {
        // A reason with no label renders as its raw message key on the scan history.
        for (const locale of ['en', 'bg']) {
            const messages = JSON.parse(fs.readFileSync(`${REPO_ROOT}/messages/${locale}.json`, 'utf8')) as {
                agents: { harness: { incompleteReason: Record<string, string> } };
            };
            expect(Object.keys(messages.agents.harness.incompleteReason).sort()).toEqual([...INCOMPLETE_REASONS].sort());
        }
    });

    it('a stored /2 scan\'s sources read back, code and UNPARSEABLE included', () => {
        const stored = JSON.parse(JSON.stringify(validV2ReportBody().population.sources)) as unknown;
        expect(parseStoredHarnessSources(stored)).toContainEqual({ kind: 'code', status: 'INCOMPLETE', rows: 4, reason: 'UNPARSEABLE' });
        // A kind no id defines still makes the row unreadable.
        expect(parseStoredHarnessSources([{ kind: 'ldap', status: 'COMPLETE', rows: 1 }])).toBeNull();
    });

    it('an estate may declare exactly the kinds a report can carry: the newest migration\'s CHECK lists SOURCE_KINDS', () => {
        // The CHECK is DROP + ADD in each migration that widens it, so the one
        // that sorts LAST is the one in force.
        const migrations = repoFiles({ under: 'prisma/migrations', extensions: ['.sql'] })
            .filter((f) => fs.readFileSync(f, 'utf8').includes('"AgentHarnessEstateSource_kind_known"'))
            .sort();
        const newest = fs.readFileSync(migrations[migrations.length - 1], 'utf8');
        const check = /ADD CONSTRAINT "AgentHarnessEstateSource_kind_known"\s+CHECK \("kind" IN \(([^)]*)\)\)/.exec(newest);
        expect(check).not.toBeNull();
        const allowed = check![1].split(',').map((k) => k.trim().replace(/^'|'$/g, '')).sort();
        expect(allowed).toEqual([...SOURCE_KINDS].sort());
    });
});
