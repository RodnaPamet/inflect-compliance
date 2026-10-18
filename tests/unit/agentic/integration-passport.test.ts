/**
 * The integration passport builder (#3672), over fixtures.
 *
 * `docs/integration-passport.md` defines each field and its source. These tests
 * pin what the builder derives from stored rows: the grant kind through the
 * runtime's own resolver, kind only; the effective scope and audience; the rung
 * through `coerceStoredMode`; rows found by the qualified prefix; a canonical,
 * order-free digest; and a bundle that reads back only when it is exactly what
 * was emitted.
 */
import { createHash } from 'crypto';

import { ENTRA_MCP_SCOPE } from '@/app-layer/integrations/mcp/token';
import { canonicalJson } from '@/lib/canonical-json';
import { weeklyPeriod } from '@/lib/agentic/evidence-artefact';
import {
    PASSPORT_BLOCK_BEGIN,
    PASSPORT_BLOCK_END,
    SECRET_UNREADABLE,
    buildIntegrationPassport,
    endpointUrlOf,
    buildPassportArtefactBody,
    buildPassportBundle,
    extractPassportBundle,
    passportBundleDigest,
    passportDigest,
    serialisePassportBundle,
    writeDeclarationsOf,
    type IntegrationPassport,
    type PassportConnectionSource,
    type PassportGrantRow,
    type PassportPairingRow,
    type PassportParameterSetRow,
    type PassportPinRow,
    type PassportSources,
} from '@/lib/agentic/integration-passport';

const CONN = 'cmconnpassport00000000001';
const GUID = '11111111-2222-3333-4444-555555555555';
const tool = (name: string, connectionId = CONN) => `mcp__${connectionId}__${name}`;
const hash = (ch: string) => ch.repeat(64);
const W42 = weeklyPeriod(new Date('2026-10-18T05:45:00.000Z'));

function connection(over: Partial<PassportConnectionSource> = {}): PassportConnectionSource {
    const merged: PassportConnectionSource = {
        id: CONN,
        name: 'Entra MCP',
        isEnabled: true,
        configJson: { url: 'https://mcp.example.test/enterprise', tenantId: GUID, clientId: 'client-1' },
        secrets: { clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value' }, // pragma: allowlist secret
        externalWriteMode: 'DRY_RUN',
        externalWriteModeSince: new Date('2026-10-01T09:00:00.000Z'),
        lastTestedAt: new Date('2026-10-14T10:00:00.000Z'),
        lastTestStatus: 'ok',
        ownerUserId: 'usr_owner',
        ownerMembershipActive: true,
        endpointUrlDigest: null,
        ...over,
    };
    // The usecase digests the URL with a deployment key; a fixture digests it
    // with a plain hash, so a moved URL moves the digest exactly as it would.
    return 'endpointUrlDigest' in over ? merged : { ...merged, endpointUrlDigest: fixtureUrlDigest(merged.configJson) };
}

function fixtureUrlDigest(configJson: unknown): string | null {
    const url = endpointUrlOf(configJson);
    return url === null ? null : createHash('sha256').update(`fixture-key:${url}`).digest('hex');
}

function pin(name: string, over: Partial<PassportPinRow> = {}): PassportPinRow {
    return {
        toolName: tool(name),
        descriptionHash: hash('a'),
        schemaHash: hash('b'),
        manifestHash: hash('c'),
        annotationsHash: hash('d'),
        revision: 1,
        approvalSource: 'APPROVED',
        approvedByUserId: 'usr_approver',
        approvedAt: new Date('2026-10-02T08:00:00.000Z'),
        previousManifestHash: null,
        declaresWrite: false,
        ...over,
    };
}

function grant(agentId: string, name: string, over: Partial<PassportGrantRow> = {}): PassportGrantRow {
    return {
        agentId,
        toolName: tool(name),
        grantedByUserId: 'usr_granter',
        createdAt: new Date('2026-10-03T08:00:00.000Z'),
        ...over,
    };
}

function pairing(write: string, read: string): PassportPairingRow {
    return {
        writeToolName: tool(write),
        readToolName: tool(read),
        approvedByUserId: 'usr_owner',
        updatedAt: new Date('2026-10-04T08:00:00.000Z'),
    };
}

function parameterSet(id: string, name: string, over: Partial<PassportParameterSetRow> = {}): PassportParameterSetRow {
    return {
        id,
        toolName: tool(name),
        label: 'default',
        revision: 1,
        parametersHash: hash('e'),
        approvalSource: 'APPROVED',
        approvedByUserId: 'usr_owner',
        targetPopulation: null,
        pendingHash: null,
        ...over,
    };
}

function sources(over: Partial<PassportSources> = {}): PassportSources {
    return {
        connection: connection(),
        pins: [pin('list_users'), pin('disable_user', { declaresWrite: true })],
        grants: [grant('agt_1', 'list_users'), grant('agt_2', 'list_users')],
        pairings: [pairing('disable_user', 'list_users')],
        parameterSets: [parameterSet('set_1', 'disable_user')],
        ...over,
    };
}

const build = (over: Partial<PassportSources> = {}) => buildIntegrationPassport(sources(over));
const withConnection = (over: Partial<PassportConnectionSource>) => build({ connection: connection(over) });

// ── P3, P4, P5 ──────────────────────────────────────────────────────────────

describe('the grant kind is the runtime resolver\'s answer, and only the kind leaves', () => {
    it('a refresh token makes the grant delegated, defaulting the scope to the Entra MCP resource', () => {
        const p = build();
        expect(p.grantKind).toBe('delegated');
        expect(p.scope).toEqual({ stored: null, effective: ENTRA_MCP_SCOPE, defaulted: true });
        expect(p.audience).toEqual(['api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4']);
    });

    it('a delegated grant with a stored scope uses it, and the audience drops offline_access and /.default', () => {
        const p = withConnection({
            configJson: {
                url: 'https://mcp.example.test',
                tenantId: GUID,
                clientId: 'client-1',
                scope: '  https://mcp.svc.cloud.microsoft/.default offline_access api://other  ',
            },
        });
        expect(p.grantKind).toBe('delegated');
        expect(p.scope).toEqual({
            stored: 'https://mcp.svc.cloud.microsoft/.default offline_access api://other',
            effective: 'https://mcp.svc.cloud.microsoft/.default offline_access api://other',
            defaulted: false,
        });
        expect(p.audience).toEqual(['api://other', 'https://mcp.svc.cloud.microsoft']);
    });

    it('a client secret and a scope with no refresh token is app-only, and nothing defaults', () => {
        const p = withConnection({
            configJson: { url: 'https://x.test', tenantId: GUID, clientId: 'c', scope: 'https://x.test/.default' },
            secrets: { clientSecret: 'client-secret-value' }, // pragma: allowlist secret
        });
        expect(p.grantKind).toBe('app-only');
        expect(p.scope).toEqual({ stored: 'https://x.test/.default', effective: 'https://x.test/.default', defaulted: false });
        expect(p.audience).toEqual(['https://x.test']);
    });

    it('a pasted Authorization value alone is static-header: the scope is reported, nothing is minted', () => {
        const p = withConnection({
            configJson: { url: 'https://x.test', scope: 'api://srv/.default' },
            secrets: { authorization: 'Bearer pasted-value' },
        });
        expect(p.grantKind).toBe('static-header');
        expect(p.scope).toEqual({ stored: 'api://srv/.default', effective: null, defaulted: false });
        expect(p.audience).toBe('unknown');
    });

    it('nothing set is none, including a row whose only field is a scope', () => {
        expect(withConnection({ configJson: { url: 'https://x.test' }, secrets: null }).grantKind).toBe('none');
        const scopeOnly = withConnection({ configJson: { url: 'https://x.test', scope: 'api://srv' }, secrets: null });
        expect(scopeOnly.grantKind).toBe('none');
        expect(scopeOnly.scope).toEqual({ stored: 'api://srv', effective: null, defaulted: false });
        expect(scopeOnly.audience).toBe('unknown');
    });

    it('a partial OAuth configuration is invalid, even beside a static header', () => {
        expect(withConnection({ configJson: { url: 'https://x.test', tenantId: GUID }, secrets: {} }).grantKind).toBe(
            'invalid',
        );
        const both = withConnection({
            configJson: { url: 'https://x.test', clientId: 'c' },
            secrets: { authorization: 'Bearer pasted-value' },
        });
        expect(both.grantKind).toBe('invalid');
        expect(both.audience).toBe('unknown');
    });

    it('takes the OAuth kind when a legacy row holds both a full OAuth configuration and a static header', () => {
        // The runtime's own precedence: `authorizationFor` tries the resolver
        // first and never looks at the header again.
        const p = withConnection({
            secrets: { clientSecret: 's', refreshToken: 'r', authorization: 'Bearer pasted-value' },
        });
        expect(p.grantKind).toBe('delegated');
    });

    it('a secret that did not decrypt is invalid, never none', () => {
        // A static-header connection whose secret cannot be read: treating the
        // unreadable secret as empty would report `none`, a connection that
        // needs no credential.
        const p = withConnection({ configJson: { url: 'https://x.test' }, secrets: SECRET_UNREADABLE });
        expect(p.grantKind).toBe('invalid');
        expect(p.scope.effective).toBeNull();
        expect(p.audience).toBe('unknown');
    });
});

// ── P1, P2, P8, P11, P12 ────────────────────────────────────────────────────

describe('the connection\'s own columns', () => {
    it('reports the endpoint as its origin and the digest of the trimmed URL, and an empty one as absent', () => {
        expect(withConnection({ configJson: { url: '  https://a.test:8443/mcp ' } }).endpoint).toEqual({
            origin: 'https://a.test:8443',
            urlDigest: fixtureUrlDigest({ url: 'https://a.test:8443/mcp' }),
        });
        expect(withConnection({ configJson: { url: '   ' } }).endpoint).toEqual({ origin: null, urlDigest: null });
        expect(withConnection({ configJson: null }).endpoint).toEqual({ origin: null, urlDigest: null });
        // Not an absolute http(s) URL: nothing of it is carried, but a change still moves the digest.
        expect(withConnection({ configJson: { url: 'mcp.vendor.test/s/k' } }).endpoint).toEqual({
            origin: null,
            urlDigest: fixtureUrlDigest({ url: 'mcp.vendor.test/s/k' }),
        });
    });

    it('never carries the URL path, query, fragment or userinfo, where a credential can live', () => {
        const url = 'https://ops:pw-canary@mcp.vendor.test/api/mcp/s/sk_live_path_canary/mcp?api_key=query_canary#frag_canary';
        const p = withConnection({ configJson: { url } });
        expect(p.endpoint.origin).toBe('https://mcp.vendor.test');
        const text = canonicalJson(p);
        for (const canary of ['sk_live_path_canary', 'query_canary', 'frag_canary', 'pw-canary', '/api/mcp']) {
            expect(text).not.toContain(canary);
        }
        // A move inside the same origin is still a different passport.
        const moved = withConnection({ configJson: { url: url.replace('sk_live_path_canary', 'sk_live_other') } });
        expect(moved.endpoint.origin).toBe(p.endpoint.origin);
        expect(moved.endpoint.urlDigest).not.toBe(p.endpoint.urlDigest);
        expect(moved.digest).not.toBe(p.digest);
    });

    it('reads the rung through coerceStoredMode and records a value it had to translate', () => {
        expect(withConnection({ externalWriteMode: 'PROPOSE_ONLY' }).writeRung).toEqual({
            mode: 'PROPOSE_ONLY',
            storedUnrecognised: null,
            since: '2026-10-01T09:00:00.000Z',
        });
        // `PROPOSE` is the identity ladder's retired rung; this ladder never had it.
        expect(withConnection({ externalWriteMode: 'PROPOSE' }).writeRung).toMatchObject({
            mode: 'DISABLED',
            storedUnrecognised: 'PROPOSE',
        });
        // Never set is not a translation; an empty string is.
        expect(
            withConnection({ externalWriteMode: null, externalWriteModeSince: null }).writeRung,
        ).toEqual({ mode: 'DISABLED', storedUnrecognised: null, since: null });
        expect(withConnection({ externalWriteMode: '' }).writeRung).toMatchObject({
            mode: 'DISABLED',
            storedUnrecognised: '',
        });
    });

    it('is accountable only for an owner holding an active membership', () => {
        expect(build().owner).toEqual({ userId: 'usr_owner', accountable: true });
        expect(withConnection({ ownerMembershipActive: false }).owner).toEqual({
            userId: 'usr_owner',
            accountable: false,
        });
        expect(withConnection({ ownerUserId: null, ownerMembershipActive: true }).owner).toEqual({
            userId: null,
            accountable: false,
        });
    });

    it('reports the last test as the Test button wrote it', () => {
        expect(build().lastValidated).toEqual({ at: '2026-10-14T10:00:00.000Z', status: 'ok' });
        expect(withConnection({ lastTestedAt: null, lastTestStatus: null }).lastValidated).toEqual({
            at: null,
            status: null,
        });
    });
});

// ── P6, P7, P9, P10 ─────────────────────────────────────────────────────────

describe('per-tool rows are found by the qualified prefix of this connection', () => {
    it('never takes a row of a connection whose id merely starts with this one', () => {
        const p = buildIntegrationPassport({
            connection: connection({ id: 'ck1' }),
            pins: [pin('x', { toolName: 'mcp__ck1__x' }), pin('x', { toolName: 'mcp__ck12__x' })],
            grants: [grant('agt_1', 'x', { toolName: 'mcp__ck12__x' })],
            pairings: [{ ...pairing('w', 'r'), writeToolName: 'mcp__ck12__w' }],
            parameterSets: [parameterSet('set_9', 'x', { toolName: 'mcp__ck12__x' })],
        });
        expect(p.pinnedTools.map((t) => t.toolName)).toEqual(['mcp__ck1__x']);
        expect(p.grantedAgents).toEqual([]);
        expect(p.priorStatePairings).toEqual([]);
        expect(p.parameterSets).toEqual([]);
    });

    it('carries each field the specification names, with every instant as an ISO string', () => {
        const p = build();
        expect(p.pinnedTools[0]).toEqual({
            toolName: tool('disable_user'),
            descriptionHash: hash('a'),
            schemaHash: hash('b'),
            manifestHash: hash('c'),
            annotationsHash: hash('d'),
            revision: 1,
            approvalSource: 'APPROVED',
            approvedByUserId: 'usr_approver',
            approvedAt: '2026-10-02T08:00:00.000Z',
            previousManifestHash: null,
            declaresWrite: true,
        });
        expect(p.grantedAgents[0]).toEqual({
            agentId: 'agt_1',
            toolName: tool('list_users'),
            grantedByUserId: 'usr_granter',
            createdAt: '2026-10-03T08:00:00.000Z',
        });
        expect(p.priorStatePairings).toEqual([
            {
                writeToolName: tool('disable_user'),
                readToolName: tool('list_users'),
                approvedByUserId: 'usr_owner',
                updatedAt: '2026-10-04T08:00:00.000Z',
            },
        ]);
        expect(build({ parameterSets: [parameterSet('set_1', 'disable_user', { pendingHash: hash('f') })] })
            .parameterSets[0]).toEqual({
            id: 'set_1',
            toolName: tool('disable_user'),
            label: 'default',
            revision: 1,
            parametersHash: hash('e'),
            approvalSource: 'APPROVED',
            approvedByUserId: 'usr_owner',
            targetPopulation: null,
            pending: true,
        });
    });
});

// ── Canonical and comparable ────────────────────────────────────────────────

describe('the digest is a function of the connection, not of the read', () => {
    it('is the SHA-256 of the canonical JSON of every other member', () => {
        const p = build();
        const rest: Record<string, unknown> = { ...p };
        delete rest.digest;
        expect(p.digest).toBe(createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex'));
        expect(passportDigest(p)).toBe(p.digest);
    });

    it('does not move when the database returns rows in another order', () => {
        const s = sources({
            pins: [pin('a_tool'), pin('b_tool'), pin('c_tool')],
            grants: [grant('agt_2', 'a_tool'), grant('agt_1', 'b_tool'), grant('agt_1', 'a_tool')],
            pairings: [pairing('b_tool', 'a_tool'), pairing('c_tool', 'a_tool')],
            parameterSets: [parameterSet('set_2', 'b_tool'), parameterSet('set_1', 'c_tool')],
        });
        const reversed: PassportSources = {
            connection: s.connection,
            pins: [...s.pins].reverse(),
            grants: [...s.grants].reverse(),
            pairings: [...s.pairings].reverse(),
            parameterSets: [...s.parameterSets].reverse(),
        };
        expect(buildIntegrationPassport(reversed).digest).toBe(buildIntegrationPassport(s).digest);
        expect(buildIntegrationPassport(reversed).grantedAgents.map((g) => `${g.toolName}|${g.agentId}`)).toEqual([
            `${tool('a_tool')}|agt_1`,
            `${tool('a_tool')}|agt_2`,
            `${tool('b_tool')}|agt_1`,
        ]);
    });

    it('moves when an instant moves, by as little as a millisecond', () => {
        // `canonicalJson` renders a Date as `{}`; a builder that left one in
        // would digest these alike.
        const pinned = build({ pins: [pin('list_users')] });
        const repinned = build({ pins: [pin('list_users', { approvedAt: new Date('2026-10-02T08:00:00.001Z') })] });
        expect(repinned.digest).not.toBe(pinned.digest);

        const granted = build({ grants: [grant('agt_1', 'list_users')] });
        const regranted = build({
            grants: [grant('agt_1', 'list_users', { createdAt: new Date('2026-10-05T00:00:00.000Z') })],
        });
        expect(regranted.digest).not.toBe(granted.digest);
    });
});

// ── What a passport never contains ──────────────────────────────────────────

describe('what a passport never contains', () => {
    it('carries no secret value, no description or schema text, no parameter value', () => {
        // Rows wider than the declared types, as a too-generous Prisma select
        // would hand in. The builder picks fields by name, so none of these can
        // reach the passport.
        const widePin = {
            ...pin('list_users'),
            description: 'DESCRIPTION-TEXT-THE-MODEL-READS',
            inputSchema: { type: 'object', title: 'SCHEMA-TEXT' },
        } as PassportPinRow;
        const wideSet = {
            ...parameterSet('set_1', 'list_users'),
            parameters: { userPrincipalName: 'PARAMETER-VALUE' },
            pendingParameters: { userPrincipalName: 'PENDING-PARAMETER-VALUE' },
            openFields: ['OPEN-FIELD-NAME'],
        } as PassportParameterSetRow;
        const p = buildIntegrationPassport({
            connection: connection({
                secrets: {
                    clientSecret: 'CLIENT-SECRET-VALUE', // pragma: allowlist secret
                    refreshToken: 'REFRESH-TOKEN-VALUE',
                    authorization: 'Bearer STATIC-HEADER-VALUE',
                },
            }),
            pins: [widePin],
            grants: [],
            pairings: [],
            parameterSets: [wideSet],
        });
        const text = canonicalJson(p);
        for (const needle of [
            'CLIENT-SECRET-VALUE', // pragma: allowlist secret
            'REFRESH-TOKEN-VALUE',
            'STATIC-HEADER-VALUE',
            'DESCRIPTION-TEXT-THE-MODEL-READS',
            'SCHEMA-TEXT',
            'PARAMETER-VALUE',
            'OPEN-FIELD-NAME',
        ]) {
            expect(text).not.toContain(needle);
        }
        // Nor a hash of a secret.
        for (const secret of ['CLIENT-SECRET-VALUE', 'REFRESH-TOKEN-VALUE', 'Bearer STATIC-HEADER-VALUE']) { // pragma: allowlist secret
            expect(text).not.toContain(createHash('sha256').update(secret).digest('hex'));
        }
        expect(p.grantKind).toBe('delegated');
    });

    it('declares no parameter value on the row type', () => {
        const row: PassportParameterSetRow = {
            ...parameterSet('set_1', 'list_users'),
            // @ts-expect-error — the row type carries no parameter values.
            parameters: { a: 1 },
        };
        expect(buildIntegrationPassport(sources({ parameterSets: [row] })).parameterSets[0]).not.toHaveProperty(
            'parameters',
        );
    });
});

// ── Write declarations ──────────────────────────────────────────────────────

describe('write declarations are reported from the pins and the pairings', () => {
    it('lists the tools that declare a write, whether each is paired, and the pins with no declaration', () => {
        const p = build({
            pins: [
                pin('disable_user', { declaresWrite: true }),
                pin('reset_password', { declaresWrite: true }),
                pin('list_users', { declaresWrite: false }),
                pin('legacy_tool', { declaresWrite: null }),
            ],
            pairings: [pairing('disable_user', 'list_users')],
        });
        expect(writeDeclarationsOf(p)).toEqual({
            declaredWrite: [
                { toolName: tool('disable_user'), hasPairing: true },
                { toolName: tool('reset_password'), hasPairing: false },
            ],
            declarationNotRecorded: [tool('legacy_tool')],
        });
    });
});

// ── Bundle, body, extraction ────────────────────────────────────────────────

function emitted(passports: readonly IntegrationPassport[]) {
    const bundle = buildPassportBundle(W42, passports);
    const serialised = serialisePassportBundle(bundle);
    const digest = passportBundleDigest(serialised);
    const body = buildPassportArtefactBody(W42, bundle, digest);
    return { bundle, serialised, digest, body };
}

const second = () =>
    buildIntegrationPassport({
        connection: connection({ id: 'cmconnpassport00000000002', name: 'Second', ownerUserId: null }),
        pins: [],
        grants: [],
        pairings: [],
        parameterSets: [],
    });

describe('a week\'s passports are one canonical bundle, embedded in the evidence body', () => {
    it('reads back exactly what was emitted', () => {
        const { bundle, digest, body } = emitted([second(), build()]);
        const read = extractPassportBundle(body.content, digest, W42.start);
        expect(read).toEqual({ ok: true, bundle });
        if (read.ok) {
            expect(read.bundle.connections.map((c) => c.connectionId)).toEqual([CONN, 'cmconnpassport00000000002']);
            expect(read.bundle.periodLabel).toBe('2026-W42');
        }
    });

    it('stores an angle bracket escaped and restores it exactly', () => {
        const hostile = build({ pins: [pin('<script>alert(1)</script>&x')] });
        const { serialised, digest, body } = emitted([hostile]);
        expect(serialised).not.toMatch(/[<>&]/);
        expect(body.content).not.toContain('<script>');
        const read = extractPassportBundle(body.content, digest, W42.start);
        expect(read.ok && read.bundle.connections[0].pinnedTools[0].toolName).toBe(tool('<script>alert(1)</script>&x'));
    });

    it('refuses an edited block by digest', () => {
        const { digest, body } = emitted([build()]);
        const edited = body.content.replace('"enabled":true', '"enabled":false');
        expect(edited).not.toBe(body.content);
        expect(extractPassportBundle(edited, digest, W42.start)).toEqual({ ok: false, reason: 'DIGEST_MISMATCH' });
    });

    it('refuses a block that is not the canonical serialisation, even when the digest matches it', () => {
        const { serialised, body } = emitted([build()]);
        // Same content, keys in insertion order: valid JSON, wrong form.
        const reformatted = JSON.stringify({ periodStart: W42.start.toISOString(), ...JSON.parse(serialised) });
        expect(reformatted).not.toBe(serialised);
        const content = body.content.replace(serialised, reformatted);
        expect(extractPassportBundle(content, passportBundleDigest(reformatted), W42.start)).toEqual({
            ok: false,
            reason: 'NOT_CANONICAL',
        });
    });

    it('refuses a format this build does not read, or a passport with an unknown member', () => {
        const p = build();
        const otherFormat = canonicalJson({ ...buildPassportBundle(W42, [p]), format: 'inflect-integration-passport/2' });
        const wider = canonicalJson({ ...buildPassportBundle(W42, []), connections: [{ ...p, extra: 1 }] });
        for (const block of [otherFormat, wider]) {
            const content = [PASSPORT_BLOCK_BEGIN, block, PASSPORT_BLOCK_END].join('\n');
            expect(extractPassportBundle(content, passportBundleDigest(block), W42.start)).toEqual({
                ok: false,
                reason: 'FORMAT_UNKNOWN',
            });
        }
    });

    it('refuses a bundle of another period', () => {
        const { digest, body } = emitted([build()]);
        expect(extractPassportBundle(body.content, digest, weeklyPeriod(new Date('2026-10-05T00:00:00Z')).start)).toEqual(
            { ok: false, reason: 'PERIOD_MISMATCH' },
        );
    });

    it('refuses a passport whose own digest does not recompute', () => {
        const p = build();
        const forged = buildPassportBundle(W42, [{ ...p, name: 'renamed after the digest' }]);
        const block = serialisePassportBundle(forged);
        const content = [PASSPORT_BLOCK_BEGIN, block, PASSPORT_BLOCK_END].join('\n');
        expect(extractPassportBundle(content, passportBundleDigest(block), W42.start)).toEqual({
            ok: false,
            reason: 'PASSPORT_DIGEST_MISMATCH',
        });
    });

    it('refuses a body with no block, or a block whose end marker is not the next line', () => {
        const { serialised, digest } = emitted([build()]);
        expect(extractPassportBundle('Control: A.5.19\nnothing here', digest, W42.start)).toEqual({
            ok: false,
            reason: 'BLOCK_MISSING',
        });
        const split = [PASSPORT_BLOCK_BEGIN, serialised, '', PASSPORT_BLOCK_END].join('\n');
        expect(extractPassportBundle(split, digest, W42.start)).toEqual({ ok: false, reason: 'BLOCK_MISSING' });
    });

    it('reads the LAST block, so a block forged above the real one is not the one compared', () => {
        const { digest, body } = emitted([build()]);
        const forged = buildPassportBundle(W42, []);
        const content = [PASSPORT_BLOCK_BEGIN, serialisePassportBundle(forged), PASSPORT_BLOCK_END, body.content].join(
            '\n',
        );
        const read = extractPassportBundle(content, digest, W42.start);
        expect(read.ok && read.bundle.connections.map((c) => c.connectionId)).toEqual([CONN]);
    });

    it('refuses a digest that is not the bundle\'s, rather than emit an artefact that never verifies', () => {
        const bundle = buildPassportBundle(W42, [build()]);
        expect(() => buildPassportArtefactBody(W42, bundle, hash('0'))).toThrow(/digest/);
    });

    it('refuses two passports for one connection', () => {
        expect(() => buildPassportBundle(W42, [build(), build()])).toThrow(/appears twice/);
    });
});

describe('the evidence body', () => {
    it('summarises each connection on one line, including the write declarations the pins alone cannot show', () => {
        const p = build({
            connection: connection({ ownerUserId: null, lastTestedAt: null, lastTestStatus: null }),
            pins: [
                pin('disable_user', { declaresWrite: true }),
                pin('reset_password', { declaresWrite: true, approvalSource: 'BASELINE', annotationsHash: null }),
                pin('legacy_tool', { declaresWrite: null }),
            ],
            pairings: [pairing('disable_user', 'list_users')],
        });
        const { body } = emitted([p]);
        const line = body.content.split('\n').find((l) => l.startsWith(`- ${CONN} `));
        expect(line).toBeDefined();
        expect(line).toContain('grant delegated');
        expect(line).toContain('write rung DRY_RUN');
        expect(line).toContain('pinned tools 3 (baseline 1, annotations unattested 1, declare a write 2, ');
        expect(line).toContain('declare a write with no prior-state pairing 1, write declaration not recorded 1)');
        expect(line).toContain('NO accountable owner');
        expect(line).toContain('never tested');
        expect(body.title).toBe('Integration passports — 2026-W42');
        expect(body.content).toContain('REDACTION CONTRACT');
        expect(body.content.endsWith(PASSPORT_BLOCK_END)).toBe(true);
    });

    it('keeps a connection name on its one line, so it cannot forge a marker line', () => {
        const named = withConnection({ name: `x\n${PASSPORT_BLOCK_BEGIN}\n{}\n${PASSPORT_BLOCK_END}\ny` });
        const { body } = emitted([named]);
        const lines = body.content.split('\n');
        expect(lines.filter((l) => l === PASSPORT_BLOCK_BEGIN)).toHaveLength(1);
        expect(lines.filter((l) => l === PASSPORT_BLOCK_END)).toHaveLength(1);
    });

    it('says so when there are no connections', () => {
        const { body } = emitted([]);
        expect(body.content).toContain('External agent connections: 0 (enabled 0, disabled 0)');
    });
});
