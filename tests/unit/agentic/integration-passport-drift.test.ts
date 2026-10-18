/**
 * Which difference between two weeks' passports is a finding, and whose (#3672).
 *
 * The planner is pure, so every rule `docs/integration-passport.md` states is
 * proved here: a changed grant kind, pin and rung each raise one finding at the
 * stated severity; nothing changed raises nothing; a connection with no owner
 * raises CONNECTION_OWNER_MISSING and hands every other finding to the OWNER
 * role; a first passport raises only absences; and a prior that does not
 * verify is a finding, never a silent baseline.
 */
import { createHash } from 'crypto';

import { weeklyPeriod } from '@/lib/agentic/evidence-artefact';
import {
    buildIntegrationPassport,
    endpointUrlOf,
    buildPassportBundle,
    type IntegrationPassport,
    type PassportConnectionSource,
    type PassportGrantRow,
    type PassportPairingRow,
    type PassportParameterSetRow,
    type PassportPinRow,
    type PassportSources,
} from '@/lib/agentic/integration-passport';
import {
    OWNER_ROLE_FALLBACK,
    SELF_MADE_SENTENCE,
    accountableOwners,
    intendedAssignee,
    planPassportFindings,
    reassignedDescription,
    type PassportAuditEntry,
    type PassportPlanInput,
    type PassportPrior,
    type PlannedPassportFinding,
} from '@/lib/agentic/integration-passport-drift';

const CONN = 'cmconnpassport00000000001';
const GUID = '11111111-2222-3333-4444-555555555555';
const tool = (name: string) => `mcp__${CONN}__${name}`;
const hash = (ch: string) => ch.repeat(64);
const W41 = weeklyPeriod(new Date('2026-10-11T05:45:00.000Z'));
const W42 = weeklyPeriod(new Date('2026-10-18T05:45:00.000Z'));
const EMITTED_W41 = new Date('2026-10-11T05:45:30.000Z');

// ── Fixtures: a healthy connection, so a test changes exactly one thing ──────

function connection(over: Partial<PassportConnectionSource> = {}): PassportConnectionSource {
    const merged: PassportConnectionSource = {
        id: CONN,
        name: 'Entra MCP',
        isEnabled: true,
        configJson: {
            url: 'https://mcp.example.test/enterprise',
            tenantId: GUID,
            clientId: 'client-1',
            scope: 'api://srv/.default',
        },
        secrets: { clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value' }, // pragma: allowlist secret
        externalWriteMode: 'DRY_RUN',
        externalWriteModeSince: new Date('2026-10-01T09:00:00.000Z'),
        lastTestedAt: new Date('2026-10-01T10:00:00.000Z'),
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

function pairing(write: string, read: string, over: Partial<PassportPairingRow> = {}): PassportPairingRow {
    return {
        writeToolName: tool(write),
        readToolName: tool(read),
        approvedByUserId: 'usr_owner',
        updatedAt: new Date('2026-10-04T08:00:00.000Z'),
        ...over,
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
        targetPopulation: 'ACTIVE_EMPLOYEES',
        pendingHash: null,
        ...over,
    };
}

function sources(over: Partial<PassportSources> = {}): PassportSources {
    return {
        connection: connection(),
        pins: [pin('list_users'), pin('disable_user', { declaresWrite: true })],
        grants: [grant('agt_1', 'list_users')],
        pairings: [pairing('disable_user', 'list_users')],
        parameterSets: [parameterSet('set_1', 'disable_user')],
        ...over,
    };
}

const passport = (over: Partial<PassportSources> = {}) => buildIntegrationPassport(sources(over));
const healthy = () => passport();
const withConnection = (over: Partial<PassportConnectionSource>) => passport({ connection: connection(over) });

function verified(passports: readonly IntegrationPassport[]): PassportPrior {
    return { status: 'VERIFIED', bundle: buildPassportBundle(W41, passports), emittedAt: EMITTED_W41 };
}

function plan(over: Partial<PassportPlanInput> = {}) {
    return planPassportFindings({
        period: W42,
        current: [],
        prior: { status: 'NONE' },
        citations: [],
        citationsTruncated: false,
        notEvidenced: [],
        ...over,
    });
}

/** Week 1 → week 2, for one connection. */
function drift(before: IntegrationPassport, after: IntegrationPassport, over: Partial<PassportPlanInput> = {}) {
    return plan({ current: [after], prior: verified([before]), ...over });
}

const events = (p: { assert: readonly PlannedPassportFinding[] }) => p.assert.filter((f) => f.nature === 'EVENT');
const only = (p: { assert: readonly PlannedPassportFinding[] }) => {
    const e = events(p);
    expect(e).toHaveLength(1);
    return e[0];
};

function audit(id: string, over: Partial<PassportAuditEntry>): PassportAuditEntry {
    return {
        id,
        action: 'INTEGRATION_CONNECTION_UPDATED',
        entity: 'IntegrationConnection',
        entityId: CONN,
        userId: 'usr_admin',
        createdAt: new Date('2026-10-14T12:00:00.000Z'),
        detailsJson: {},
        metadataJson: null,
        ...over,
    };
}

// ── The issue's three drift cases ───────────────────────────────────────────

describe('a changed grant kind is a finding, HIGH when it leaves delegated', () => {
    // Every arm keeps the same stored scope, so only P3 moves where it can.
    const delegated = () => healthy();
    const appOnly = () => withConnection({ secrets: { clientSecret: 'client-secret-value' } }); // pragma: allowlist secret
    const staticHeader = () =>
        withConnection({ configJson: { url: 'https://mcp.example.test/enterprise' }, secrets: { authorization: 'Bearer x' } });
    const invalid = () => withConnection({ secrets: { refreshToken: 'refresh-token-value' } });

    it('delegated → app-only: HIGH, keyed by connection, field, rule and week', () => {
        expect(appOnly().grantKind).toBe('app-only');
        const f = only(drift(delegated(), appOnly()));
        expect(f).toMatchObject({
            code: 'GRANT_KIND_CHANGED',
            field: 'P3',
            severity: 'HIGH',
            type: 'OBSERVATION',
            sourceRef: `${CONN}:P3:GRANT_KIND_CHANGED@2026-W42`,
            assigneeUserId: 'usr_owner',
        });
        expect(f.description).toContain('delegated → app-only');
        expect(f.description).toContain('The ceiling of a named person is removed');
    });

    it('delegated → invalid is HIGH too', () => {
        expect(invalid().grantKind).toBe('invalid');
        const f = events(drift(delegated(), invalid())).find((x) => x.code === 'GRANT_KIND_CHANGED');
        expect(f?.severity).toBe('HIGH');
    });

    it('app-only → static-header and app-only → invalid are MEDIUM', () => {
        const toStatic = events(drift(appOnly(), staticHeader())).find((x) => x.code === 'GRANT_KIND_CHANGED');
        expect(toStatic?.severity).toBe('MEDIUM');
        expect(toStatic?.description).toContain('app-only → static-header');
        const toInvalid = events(
            drift(appOnly(), withConnection({ secrets: {}, configJson: { url: 'https://mcp.example.test/enterprise', tenantId: GUID } })),
        ).find((x) => x.code === 'GRANT_KIND_CHANGED');
        expect(toInvalid?.severity).toBe('MEDIUM');
    });

    it('moves the scope and audience findings with it when the new grant mints nothing', () => {
        const codes = events(drift(appOnly(), staticHeader())).map((f) => f.code).sort();
        expect(codes).toEqual(['AUDIENCE_CHANGED', 'EFFECTIVE_SCOPE_CHANGED', 'GRANT_KIND_CHANGED']);
    });
});

describe('a changed pin is one finding per tool, naming what moved', () => {
    const at = (over: Partial<PassportPinRow>) => passport({ pins: [pin('list_users', over)] });
    const base = () => at({});

    it('a moved description is HIGH, and names the hashes, the approver and the replaced manifest hash', () => {
        const f = only(
            drift(
                base(),
                at({
                    revision: 2,
                    descriptionHash: hash('1'),
                    manifestHash: hash('2'),
                    previousManifestHash: hash('c'),
                    approvedByUserId: 'usr_reviewer',
                }),
            ),
        );
        expect(f).toMatchObject({
            code: 'PIN_CHANGED',
            field: 'P6',
            severity: 'HIGH',
            item: tool('list_users'),
            sourceRef: `${CONN}:P6:PIN_CHANGED:list_users@2026-W42`,
        });
        expect(f.description).toContain('from revision 1 to 2');
        expect(f.description).toContain(`descriptionHash ${hash('a')} → ${hash('1')}`);
        expect(f.description).toContain(`manifestHash ${hash('c')} → ${hash('2')}`);
        expect(f.description).toContain('Approved by usr_reviewer');
        expect(f.description).toContain(`replaced previousManifestHash ${hash('c')}`);
    });

    it('a moved annotations hash alone is HIGH, and a write tool redeclared read-only says so', () => {
        const before = passport({ pins: [pin('disable_user', { declaresWrite: true })] });
        const after = passport({
            pins: [pin('disable_user', { revision: 2, annotationsHash: hash('9'), declaresWrite: false })],
        });
        const f = only(drift(before, after));
        expect(f.severity).toBe('HIGH');
        expect(f.description).toContain('Redeclared read-only: the tool leaves the external write ladder.');
    });

    it('a moved schema alone is MEDIUM', () => {
        const f = only(drift(base(), at({ revision: 2, schemaHash: hash('3'), manifestHash: hash('4') })));
        expect(f.code).toBe('PIN_CHANGED');
        expect(f.severity).toBe('MEDIUM');
    });

    it('a hash that moved with no revision bump is still raised, and the description says the revision did not move', () => {
        const f = only(drift(base(), at({ schemaHash: hash('3') })));
        expect(f.code).toBe('PIN_CHANGED');
        expect(f.description).toContain('The revision did not move');
    });

    it('a revision that moved with no hash is raised, MEDIUM', () => {
        const f = only(drift(base(), at({ revision: 2 })));
        expect(f).toMatchObject({ code: 'PIN_CHANGED', severity: 'MEDIUM' });
    });

    it('a pin added or removed is MEDIUM, one finding per tool', () => {
        const added = only(drift(passport({ pins: [] }), base()));
        expect(added).toMatchObject({ code: 'PIN_ADDED', severity: 'MEDIUM', sourceRef: `${CONN}:P6:PIN_ADDED:list_users@2026-W42` });
        const removed = only(drift(base(), passport({ pins: [] })));
        expect(removed).toMatchObject({ code: 'PIN_REMOVED', severity: 'MEDIUM' });
    });

    it('an approval time that moved with nothing else is not drift', () => {
        expect(events(drift(base(), at({ approvedAt: new Date('2026-10-09T00:00:00.000Z') })))).toEqual([]);
    });

    it('cites the approval entries for that tool and no other', () => {
        const f = only(
            drift(base(), at({ revision: 2, descriptionHash: hash('1') }), {
                citations: [
                    audit('aud_pin', { action: 'MCP_TOOL_MANIFEST_APPROVED', entity: 'McpToolManifestPin', entityId: tool('list_users') }),
                    audit('aud_other', { action: 'MCP_TOOL_MANIFEST_APPROVED', entity: 'McpToolManifestPin', entityId: tool('other') }),
                ],
            }),
        );
        expect(f.description).toContain('aud_pin MCP_TOOL_MANIFEST_APPROVED by usr_admin at 2026-10-14T12:00:00.000Z');
        expect(f.description).not.toContain('aud_other');
    });
});

describe('a changed rung is a finding: HIGH widening, LOW narrowing, citing the move', () => {
    const rung = (mode: string) => withConnection({ externalWriteMode: mode, externalWriteModeSince: new Date('2026-10-15T00:00:00.000Z') });
    const move = audit('aud_rung', { action: 'EXTERNAL_WRITE_MODE_CHANGED', userId: 'usr_admin' });

    it('DRY_RUN → PROPOSE_ONLY is HIGH and cites EXTERNAL_WRITE_MODE_CHANGED', () => {
        const f = only(
            drift(rung('DRY_RUN'), rung('PROPOSE_ONLY'), {
                citations: [move, audit('aud_elsewhere', { action: 'EXTERNAL_WRITE_MODE_CHANGED', entityId: 'cmconnother' })],
            }),
        );
        expect(f).toMatchObject({
            code: 'WRITE_RUNG_WIDENED',
            field: 'P8',
            severity: 'HIGH',
            sourceRef: `${CONN}:P8:WRITE_RUNG_WIDENED@2026-W42`,
        });
        expect(f.description).toContain('DRY_RUN → PROPOSE_ONLY');
        expect(f.description).toContain('aud_rung EXTERNAL_WRITE_MODE_CHANGED by usr_admin');
        expect(f.description).not.toContain('aud_elsewhere');
    });

    it('AUTOMATIC → DRY_RUN is LOW', () => {
        expect(only(drift(rung('AUTOMATIC'), rung('DRY_RUN')))).toMatchObject({
            code: 'WRITE_RUNG_NARROWED',
            severity: 'LOW',
        });
    });

    it('a rung re-entered (only `since` moved) is not drift', () => {
        expect(events(drift(withConnection({ externalWriteMode: 'DRY_RUN' }), rung('DRY_RUN')))).toEqual([]);
    });

    it('says so when no audit entry in the window records the move', () => {
        const f = only(drift(rung('DRY_RUN'), rung('AUTOMATIC')));
        expect(f.description).toContain('No audit entry in the window since 2026-10-11T05:45:30.000Z records this change.');
    });
});

// ── Nothing changed ─────────────────────────────────────────────────────────

describe('no finding when nothing changed', () => {
    it('raises nothing for an identical, healthy passport, and resolves every state condition', () => {
        const p = healthy();
        const result = drift(p, p);
        expect(result.assert).toEqual([]);
        expect(result.compared).toBe(true);
        expect(result.resolve.map((r) => r.sourceRef).sort()).toEqual(
            [
                `${CONN}:P11:OWNER_MISSING`,
                `${CONN}:P12:NEVER_TESTED`,
                `${CONN}:P6:ANNOTATIONS_UNATTESTED:disable_user`,
                `${CONN}:P6:ANNOTATIONS_UNATTESTED:list_users`,
                `${CONN}:P6:BASELINE:disable_user`,
                `${CONN}:P6:BASELINE:list_users`,
                `${CONN}:P8:UNRECOGNISED`,
                'tenant:NOT_EVIDENCED:BUNDLE_TOO_LARGE',
                'tenant:NOT_EVIDENCED:NO_TARGET_CONTROL',
                'tenant:NOT_EVIDENCED:POPULATION_TRUNCATED',
            ].sort(),
        );
    });

    it('raises nothing for a rename: the name is carried for readability, not compared', () => {
        const before = healthy();
        const after = withConnection({ name: 'Renamed' });
        expect(after.digest).not.toBe(before.digest);
        expect(drift(before, after).assert).toEqual([]);
    });

    it('raises nothing for a pending parameter-set edit, which is not in force', () => {
        const after = passport({ parameterSets: [parameterSet('set_1', 'disable_user', { pendingHash: hash('7') })] });
        expect(drift(healthy(), after).assert).toEqual([]);
    });
});

// ── No owner ────────────────────────────────────────────────────────────────

describe('a connection with no owner raises a finding, and its other findings fall to the OWNER role', () => {
    it('raises CONNECTION_OWNER_MISSING, HIGH, with no assignee and the role named', () => {
        const result = plan({ current: [withConnection({ ownerUserId: null })] });
        const f = result.assert.find((x) => x.code === 'CONNECTION_OWNER_MISSING');
        expect(f).toMatchObject({
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            assigneeUserId: null,
            sourceRef: `${CONN}:P11:OWNER_MISSING`,
            nature: 'STATE',
        });
        expect(f?.description).toContain("the tenant's OWNER role (the holders of admin.tenant_lifecycle)");
    });

    it('gives every other finding on that connection no assignee and the fallback sentence', () => {
        const before = withConnection({ ownerUserId: null, lastTestedAt: null, lastTestStatus: null });
        const after = buildIntegrationPassport(
            sources({
                connection: connection({ ownerUserId: null, lastTestedAt: null, lastTestStatus: null, externalWriteMode: 'AUTOMATIC' }),
                pins: [pin('list_users', { approvalSource: 'BASELINE', approvedByUserId: null }), pin('disable_user', { declaresWrite: true })],
            }),
        );
        const result = drift(before, after);
        const others = result.assert.filter((f) => f.code !== 'CONNECTION_OWNER_MISSING');
        // A BASELINE source with no revision or hash move is not PIN_CHANGED.
        expect(others.map((f) => f.code).sort()).toEqual(['CONNECTION_NEVER_TESTED', 'PIN_BASELINE', 'WRITE_RUNG_WIDENED']);
        for (const f of others) {
            expect(f.assigneeUserId).toBeNull();
            // LAST, so the sweep can rewrite exactly this tail when an owner is named.
            expect(f.description.endsWith(` ${OWNER_ROLE_FALLBACK}`)).toBe(true);
        }
    });

    it('treats an owner who holds no active membership as no owner', () => {
        const result = plan({ current: [withConnection({ ownerMembershipActive: false, lastTestedAt: null })] });
        const missing = result.assert.find((x) => x.code === 'CONNECTION_OWNER_MISSING');
        expect(missing?.assigneeUserId).toBeNull();
        expect(missing?.description).toContain('User usr_owner is named as its owner but holds no active membership');
        const untested = result.assert.find((x) => x.code === 'CONNECTION_NEVER_TESTED');
        expect(untested?.assigneeUserId).toBeNull();
    });

    it('assigns a finding to the accountable owner when there is one', () => {
        const result = plan({ current: [withConnection({ lastTestedAt: null })] });
        expect(result.assert.map((f) => [f.code, f.assigneeUserId])).toEqual([['CONNECTION_NEVER_TESTED', 'usr_owner']]);
        expect(result.assert[0].description).not.toContain('OWNER role');
    });
});

// ── Rule 1 — a first passport is a baseline ─────────────────────────────────

describe('a first passport raises the absence findings and no "added" ones', () => {
    const first = () =>
        buildIntegrationPassport(
            sources({
                connection: connection({ ownerUserId: null, lastTestedAt: null, lastTestStatus: null, externalWriteMode: 'PROPOSE' }),
                pins: [pin('list_users', { approvalSource: 'BASELINE', annotationsHash: null })],
            }),
        );

    it('with no prior at all', () => {
        const result = plan({ current: [first()] });
        expect(result.compared).toBe(false);
        expect(events(result)).toEqual([]);
        expect(result.assert.map((f) => [f.code, f.severity]).sort()).toEqual(
            [
                ['CONNECTION_NEVER_TESTED', 'LOW'],
                ['CONNECTION_OWNER_MISSING', 'HIGH'],
                ['PIN_ANNOTATIONS_UNATTESTED', 'HIGH'],
                ['PIN_BASELINE', 'HIGH'],
                ['WRITE_RUNG_UNRECOGNISED', 'MEDIUM'],
            ].sort(),
        );
        const rung = result.assert.find((f) => f.code === 'WRITE_RUNG_UNRECOGNISED');
        expect(rung?.description).toContain('"PROPOSE"');
        expect(rung?.description).toContain('reads as DISABLED');
    });

    it('for a connection new since a verified prior', () => {
        const other = buildIntegrationPassport({ ...sources(), connection: connection({ id: 'cmconnolder000000000000' }) });
        const result = plan({ current: [other, first()], prior: verified([other]) });
        expect(result.compared).toBe(true);
        expect(events(result)).toEqual([]);
        expect(result.assert.filter((f) => f.connectionId === CONN).map((f) => f.code)).toContain('PIN_BASELINE');
    });
});

// ── Rule 4 — a vanished connection ──────────────────────────────────────────

describe('a connection present last week and absent this week', () => {
    it('is HIGH, a nonconformity, owned by the OWNER role, keyed once', () => {
        const result = plan({ current: [], prior: verified([healthy()]) });
        expect(result.assert).toHaveLength(1);
        expect(result.assert[0]).toMatchObject({
            code: 'CONNECTION_VANISHED',
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            assigneeUserId: null,
            sourceRef: `${CONN}:VANISHED`,
        });
        expect(result.assert[0].description).toContain("the tenant's OWNER role");
    });
});

// ── The other fields ────────────────────────────────────────────────────────

describe('the remaining drift rules', () => {
    it('P1: any endpoint change is HIGH, and the finding names origins only', () => {
        const f = only(drift(healthy(), withConnection({ configJson: { ...(connection().configJson as object), url: 'https://elsewhere.test' } })));
        expect(f).toMatchObject({ code: 'ENDPOINT_CHANGED', severity: 'HIGH' });
        expect(f.description).toContain('https://mcp.example.test → https://elsewhere.test');
        expect(f.description).not.toContain('/enterprise');
    });

    it('P1: a path that moved inside one origin is HIGH too, and neither path is repeated', () => {
        const at = (key: string) =>
            withConnection({ configJson: { ...(connection().configJson as object), url: `https://mcp.example.test/s/${key}/mcp` } });
        const f = only(drift(at('sk_before_canary'), at('sk_after_canary')));
        expect(f).toMatchObject({ code: 'ENDPOINT_CHANGED', severity: 'HIGH' });
        expect(f.description).toContain('within origin https://mcp.example.test');
        expect(f.description).not.toContain('sk_before_canary');
        expect(f.description).not.toContain('sk_after_canary');
        expect(events(drift(at('sk_same'), at('sk_same')))).toEqual([]);
    });

    it('P2: re-enabling is MEDIUM, disabling LOW', () => {
        const off = withConnection({ isEnabled: false });
        expect(only(drift(off, healthy()))).toMatchObject({ code: 'CONNECTION_REENABLED', severity: 'MEDIUM' });
        expect(only(drift(healthy(), off))).toMatchObject({ code: 'CONNECTION_DISABLED', severity: 'LOW' });
    });

    it('P4/P5: a scope change is MEDIUM and the audience change it causes is HIGH', () => {
        const wider = withConnection({ configJson: { ...(connection().configJson as object), scope: 'api://srv/.default api://other/.default' } });
        const result = events(drift(healthy(), wider));
        expect(result.map((f) => [f.code, f.severity]).sort()).toEqual([
            ['AUDIENCE_CHANGED', 'HIGH'],
            ['EFFECTIVE_SCOPE_CHANGED', 'MEDIUM'],
        ]);
        expect(result.find((f) => f.code === 'AUDIENCE_CHANGED')?.description).toContain('[api://srv] → [api://other, api://srv]');
    });

    it('P7: a new grant is MEDIUM, a removed one LOW, and a re-grant counts as new', () => {
        const two = passport({ grants: [grant('agt_1', 'list_users'), grant('agt_2', 'list_users')] });
        const added = only(
            drift(healthy(), two, {
                citations: [
                    audit('aud_grant', {
                        action: 'AGENT_TOOL_GRANTED',
                        entity: 'RegisteredAgent',
                        entityId: 'agt_2',
                        detailsJson: { after: { toolName: tool('list_users'), agentId: 'agt_2' } },
                    }),
                    audit('aud_grant_other_tool', {
                        action: 'AGENT_TOOL_GRANTED',
                        entity: 'RegisteredAgent',
                        entityId: 'agt_2',
                        detailsJson: { after: { toolName: tool('something_else') } },
                    }),
                ],
            }),
        );
        expect(added).toMatchObject({ code: 'GRANT_ADDED', severity: 'MEDIUM', sourceRef: `${CONN}:P7:GRANT_ADDED:agt_2%2Flist_users@2026-W42` });
        expect(added.description).toContain('aud_grant AGENT_TOOL_GRANTED');
        expect(added.description).not.toContain('aud_grant_other_tool');
        expect(only(drift(two, healthy()))).toMatchObject({ code: 'GRANT_REMOVED', severity: 'LOW' });
        const regranted = passport({ grants: [grant('agt_1', 'list_users', { createdAt: new Date('2026-10-16T00:00:00.000Z') })] });
        expect(only(drift(healthy(), regranted))).toMatchObject({ code: 'GRANT_ADDED', severity: 'MEDIUM' });
    });

    it('P9: a pairing added, removed or pointed elsewhere is MEDIUM, citing the entry for that write tool', () => {
        const none = passport({ pairings: [] });
        const set = audit('aud_pair', {
            action: 'EXTERNAL_PRIOR_STATE_READ_SET',
            metadataJson: { writeToolName: tool('disable_user'), readToolName: tool('list_users') },
        });
        const added = only(drift(none, healthy(), { citations: [set] }));
        expect(added).toMatchObject({ code: 'PAIRING_ADDED', severity: 'MEDIUM' });
        expect(added.description).toContain('aud_pair EXTERNAL_PRIOR_STATE_READ_SET');
        expect(only(drift(healthy(), none))).toMatchObject({ code: 'PAIRING_REMOVED', severity: 'MEDIUM' });
        const repointed = passport({ pairings: [pairing('disable_user', 'get_user')] });
        expect(only(drift(healthy(), repointed))).toMatchObject({ code: 'PAIRING_REPOINTED', severity: 'MEDIUM' });
    });

    it('P10: a set added, removed or revised is MEDIUM; a changed target population is HIGH', () => {
        const none = passport({ parameterSets: [] });
        expect(only(drift(none, healthy()))).toMatchObject({ code: 'PARAMETER_SET_ADDED', severity: 'MEDIUM' });
        expect(only(drift(healthy(), none))).toMatchObject({ code: 'PARAMETER_SET_REMOVED', severity: 'MEDIUM' });
        const revised = passport({ parameterSets: [parameterSet('set_1', 'disable_user', { revision: 2, parametersHash: hash('8') })] });
        expect(only(drift(healthy(), revised))).toMatchObject({ code: 'PARAMETER_SET_REVISED', severity: 'MEDIUM' });
        const retargeted = passport({ parameterSets: [parameterSet('set_1', 'disable_user', { targetPopulation: 'ALL_EMPLOYEES' })] });
        const f = only(drift(healthy(), retargeted));
        expect(f).toMatchObject({ code: 'PARAMETER_SET_TARGET_CHANGED', severity: 'HIGH' });
        expect(f.description).toContain('ACTIVE_EMPLOYEES → ALL_EMPLOYEES');
    });

    it('P11: a new owner is MEDIUM and assigned to the new owner; removing the owner raises OWNER_MISSING only', () => {
        const noOwner = withConnection({ ownerUserId: null });
        const toX = only(drift(noOwner, healthy()));
        expect(toX).toMatchObject({ code: 'OWNER_CHANGED', severity: 'MEDIUM', assigneeUserId: 'usr_owner' });
        const toY = only(drift(healthy(), withConnection({ ownerUserId: 'usr_next' })));
        expect(toY).toMatchObject({ code: 'OWNER_CHANGED', assigneeUserId: 'usr_next' });
        const cleared = drift(healthy(), noOwner);
        expect(events(cleared)).toEqual([]);
        expect(cleared.assert.map((f) => f.code)).toEqual(['CONNECTION_OWNER_MISSING']);
    });

    it('P11: says so when every cited change was made by the assignee', () => {
        const f = only(
            drift(healthy(), withConnection({ ownerUserId: 'usr_next' }), {
                citations: [audit('aud_owner', { action: 'INTEGRATION_CONNECTION_OWNER_SET', userId: 'usr_next' })],
            }),
        );
        expect(f.description).toContain('This change was made by the assignee.');
        const byOther = only(
            drift(healthy(), withConnection({ ownerUserId: 'usr_next' }), {
                citations: [audit('aud_owner', { action: 'INTEGRATION_CONNECTION_OWNER_SET', userId: 'usr_admin' })],
            }),
        );
        expect(byOther.description).not.toContain('made by the assignee');
    });

    it('P12: ok → error is MEDIUM and cites nothing, because the Test button writes no audit entry', () => {
        const failed = withConnection({ lastTestedAt: new Date('2026-10-16T00:00:00.000Z'), lastTestStatus: 'error' });
        const f = only(drift(healthy(), failed));
        expect(f).toMatchObject({ code: 'CONNECTION_TEST_FAILED', severity: 'MEDIUM' });
        expect(f.description).toContain('The Test button writes no audit entry');
        const retested = withConnection({ lastTestedAt: new Date('2026-10-16T00:00:00.000Z') });
        expect(events(drift(healthy(), retested))).toEqual([]);
    });
});

describe('citations', () => {
    it('lists at most ten, then a count, and says when the read was capped', () => {
        const many = Array.from({ length: 12 }, (_, i) => audit(`aud_${String(i).padStart(2, '0')}`, {}));
        const f = only(
            drift(healthy(), withConnection({ isEnabled: false }), { citations: many, citationsTruncated: true }),
        );
        expect(f.description).toContain('aud_09 INTEGRATION_CONNECTION_UPDATED');
        expect(f.description).not.toContain('aud_10');
        expect(f.description).toContain('(+2 more)');
        expect(f.description).toContain('this list may be incomplete');
    });
});

// ── When events are planned at all ──────────────────────────────────────────

describe('events are planned only against a verified prior, in a pass that emits', () => {
    const before = healthy();
    const after = withConnection({ externalWriteMode: 'AUTOMATIC' });

    it('a prior that does not verify is a HIGH finding, and nothing is compared', () => {
        const result = plan({
            current: [after],
            prior: { status: 'UNVERIFIABLE', periodLabel: '2026-W41', reason: 'DIGEST_MISMATCH' },
        });
        expect(result.compared).toBe(false);
        expect(events(result).map((f) => [f.code, f.severity, f.type, f.assigneeUserId, f.sourceRef])).toEqual([
            ['PASSPORT_PRIOR_UNVERIFIABLE', 'HIGH', 'NONCONFORMITY', null, 'tenant:PRIOR_UNVERIFIABLE:2026-W41'],
        ]);
        expect(events(result)[0].description).toContain('DIGEST_MISMATCH');
    });

    it('a pass that does not emit raises the reason, resolves the others, and compares nothing', () => {
        const result = drift(before, after, { notEvidenced: ['NO_TARGET_CONTROL'] });
        expect(result.compared).toBe(false);
        expect(events(result)).toEqual([]);
        expect(result.assert.map((f) => [f.code, f.sourceRef, f.severity])).toEqual([
            ['PASSPORT_NOT_EVIDENCED', 'tenant:NOT_EVIDENCED:NO_TARGET_CONTROL', 'MEDIUM'],
        ]);
        expect(result.resolve.map((r) => r.sourceRef)).toContain('tenant:NOT_EVIDENCED:BUNDLE_TOO_LARGE');
        expect(result.resolve.map((r) => r.sourceRef)).not.toContain('tenant:NOT_EVIDENCED:NO_TARGET_CONTROL');
    });

    it('a truncated read raises its own finding and the state of the rows it read — no events, no VANISHED, no resolutions', () => {
        const other = buildIntegrationPassport({ ...sources(), connection: connection({ id: 'cmconnpastthecap0000000' }) });
        const read = buildIntegrationPassport(
            sources({
                connection: connection({ ownerUserId: null, externalWriteMode: 'AUTOMATIC', lastTestedAt: null, lastTestStatus: null }),
                pins: [pin('list_users', { approvalSource: 'BASELINE', annotationsHash: null })],
            }),
        );
        // `other` was in the prior and lies past the cap now; `read` widened.
        const result = plan({
            current: [read],
            prior: verified([before, other]),
            notEvidenced: ['POPULATION_TRUNCATED', 'NO_TARGET_CONTROL'],
        });
        expect(result.assert.map((f) => f.sourceRef).sort()).toEqual(
            [
                'tenant:NOT_EVIDENCED:POPULATION_TRUNCATED',
                `${CONN}:P11:OWNER_MISSING`,
                `${CONN}:P12:NEVER_TESTED`,
                `${CONN}:P6:BASELINE:list_users`,
                `${CONN}:P6:ANNOTATIONS_UNATTESTED:list_users`,
            ].sort(),
        );
        expect(events(result)).toEqual([]);
        expect(result.resolve).toEqual([]);
        expect(result.compared).toBe(false);
        expect(result.assert.find((f) => f.code === 'PASSPORT_NOT_EVIDENCED')?.description).toContain('are still raised');
    });

    it('event keys carry the week and state keys do not', () => {
        const result = drift(before, withConnection({ externalWriteMode: 'AUTOMATIC', lastTestedAt: null }));
        const byNature = (n: 'STATE' | 'EVENT') => result.assert.filter((f) => f.nature === n).map((f) => f.sourceRef);
        expect(byNature('EVENT')).toEqual([`${CONN}:P8:WRITE_RUNG_WIDENED@2026-W42`]);
        expect(byNature('STATE')).toEqual([`${CONN}:P12:NEVER_TESTED`]);
    });
});

describe('a state finding closes only on positive evidence', () => {
    it('does not resolve a BASELINE pin that is merely absent this week', () => {
        const before = passport({ pins: [pin('list_users', { approvalSource: 'BASELINE' })] });
        const result = drift(before, passport({ pins: [] }));
        expect(result.resolve.map((r) => r.sourceRef)).not.toContain(`${CONN}:P6:BASELINE:list_users`);
        expect(events(result).map((f) => f.code)).toEqual(['PIN_REMOVED']);
    });

    it('resolves it when the pin is present and APPROVED, naming the evidence', () => {
        const result = plan({ current: [passport({ pins: [pin('list_users', { revision: 2 })] })] });
        const r = result.resolve.find((x) => x.sourceRef === `${CONN}:P6:BASELINE:list_users`);
        expect(r?.because).toBe('pin approved at revision 2 by usr_approver');
    });
});

// ── Rule 3, held while a finding is open ────────────────────────────────────

describe('an open finding follows the connection\'s accountable owner', () => {
    const owners = accountableOwners([
        healthy(),
        buildIntegrationPassport({ ...sources(), connection: connection({ id: 'cmconnunowned00000000000', ownerUserId: null }) }),
        buildIntegrationPassport({ ...sources(), connection: connection({ id: 'cmconnleft0000000000000', ownerMembershipActive: false }) }),
    ]);

    it('to the owner, or to the OWNER role when there is none or the named one left', () => {
        expect(intendedAssignee(`${CONN}:P12:NEVER_TESTED`, owners)).toBe('usr_owner');
        expect(intendedAssignee(`${CONN}:P8:WRITE_RUNG_WIDENED@2026-W41`, owners)).toBe('usr_owner');
        expect(intendedAssignee('cmconnunowned00000000000:P12:NEVER_TESTED', owners)).toBeNull();
        expect(intendedAssignee('cmconnleft0000000000000:P6:BASELINE:x', owners)).toBeNull();
    });

    it('except OWNER_MISSING and VANISHED, which are always the OWNER role\'s', () => {
        expect(intendedAssignee(`${CONN}:P11:OWNER_MISSING`, owners)).toBeNull();
        expect(intendedAssignee(`${CONN}:VANISHED`, owners)).toBeNull();
    });

    it('and leaves alone a tenant finding, or one about a connection not in this week\'s passports', () => {
        expect(intendedAssignee('tenant:NOT_EVIDENCED:NO_TARGET_CONTROL', owners)).toBeUndefined();
        expect(intendedAssignee('cmconnpastthecap0000000:P12:NEVER_TESTED', owners)).toBeUndefined();
        expect(intendedAssignee('no-colon', owners)).toBeUndefined();
    });

    it('rewrites only the ownership tail of the description', () => {
        const fallback = ` ${OWNER_ROLE_FALLBACK}`;
        const body = 'Connection X has never been tested. A person added this line.';
        expect(reassignedDescription(`${body}${fallback}`, null, 'usr_owner')).toBe(body);
        expect(reassignedDescription(body, 'usr_owner', null)).toBe(`${body}${fallback}`);
        expect(reassignedDescription(body, 'usr_owner', 'usr_next')).toBe(body);
        // Round trip: unowned → owned → unowned leaves the text as it began.
        expect(reassignedDescription(reassignedDescription(`${body}${fallback}`, null, 'usr_owner'), 'usr_owner', null)).toBe(
            `${body}${fallback}`,
        );
    });

    it('restates a self-made sentence about the person it was true of', () => {
        const cited = 'The rung moved. Audit entries in the window since x: aud_1 EXTERNAL_WRITE_MODE_CHANGED by usr_owner at y.';
        expect(reassignedDescription(`${cited}${SELF_MADE_SENTENCE}`, 'usr_owner', 'usr_next')).toBe(
            `${cited} This change was made by usr_owner, its assignee when it was raised.`,
        );
        expect(reassignedDescription(`${cited}${SELF_MADE_SENTENCE}`, 'usr_owner', null)).toBe(
            `${cited} This change was made by usr_owner, its assignee when it was raised. ${OWNER_ROLE_FALLBACK}`,
        );
    });

    it('a planned event whose citations were all made by the assignee ends with the self-made sentence', () => {
        const f = only(
            drift(healthy(), withConnection({ ownerUserId: 'usr_next' }), {
                citations: [audit('aud_owner', { action: 'INTEGRATION_CONNECTION_OWNER_SET', userId: 'usr_next' })],
            }),
        );
        expect(f.description.endsWith(SELF_MADE_SENTENCE)).toBe(true);
    });
});
