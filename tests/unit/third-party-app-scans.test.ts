/**
 * The third-party application ingest (`usecases/third-party-app-scans.ts`),
 * against an in-memory store in place of the database.
 *
 *   1. EACH REFUSAL, IN THE CONTRACT'S ORDER, WRITES NOTHING: the key, an
 *      untrusted signer, a tampered body, a harness report given here, a secret,
 *      a scanner that names another agent, a credential bound to another agent,
 *      a replay.
 *   2. THE PLAN BECOMES THE ROWS: one scan, one application row and one item per
 *      application, with the planner's conclusions — never a value the scanner
 *      stated — and a member the product does not expose stored as NULL.
 *   3. RECONCILE: create what the plan raises, reopen a closed one it raises
 *      again, resolve only on positive evidence. An incomplete source, a member
 *      the read did not establish, and an application absent from the scan
 *      close nothing; one scanner's complete read never closes another
 *      scanner's empty-inventory finding.
 *
 * The real database, RLS and the replay's unique index are the integration
 * test's (`tests/integration/third-party-app-scans.test.ts`).
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(store.db)),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordThirdPartyAppScanOutcome: jest.fn(),
}));

import { logEvent } from '@/app-layer/events/audit';
import { recordThirdPartyAppScanOutcome } from '@/lib/observability/integration-metrics';
import {
    getThirdPartyAppInventory,
    ingestThirdPartyAppReport,
    sourceFindingRef,
    THIRD_PARTY_APP_FINDING_SOURCE_KIND,
} from '@/app-layer/usecases/third-party-app-scans';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import { integrationFindingRef } from '@rodnapamet/scanent-contract/integrations-findings';
import type { IntegrationsReportBody } from '@rodnapamet/scanent-contract/integrations-contract';

import { makeRequestContext } from '../helpers/make-context';
import { createFakeScanner, validV3ReportBody } from '../helpers/agent-harness-fake-scanner';
import {
    entraApp,
    ENTRA_COMPLETE,
    githubInstallation,
    integrationsBody,
    oktaApp,
    quietEntraApp,
    threeProductBody,
} from '../helpers/third-party-app-fake-report';

// ─── A store just wide enough for the usecase ──────────────────────────────

type Row = Record<string, unknown> & { id: string };

function makeStore() {
    let seq = 0;
    const id = (p: string) => `${p}_${++seq}`;
    const tables = {
        keys: [] as Row[],
        scans: [] as Row[],
        apps: [] as Row[],
        items: [] as Row[],
        findings: [] as Row[],
        agents: [] as Row[],
    };
    const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
        Object.entries(where).every(([k, v]) => {
            if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
                const cond = v as { in?: unknown[]; not?: unknown };
                if ('in' in cond) return (cond.in ?? []).includes(row[k]);
                if ('not' in cond) return row[k] !== cond.not;
            }
            return row[k] === v;
        });
    const pick = (row: Row, select?: Record<string, unknown>) => {
        if (!select) return { ...row };
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(select)) {
            if (k === 'app') {
                const app = tables.apps.find((a) => a.id === row.appId) as Row;
                out.app = pick(app, (select.app as { select: Record<string, unknown> }).select);
            } else out[k] = row[k];
        }
        return out;
    };
    const take = <T>(rows: T[], n?: number) => (n === undefined ? rows : rows.slice(0, n));
    const db = {
        agentHarnessScannerKey: {
            findMany: async (a: { where: Record<string, unknown>; select?: Record<string, unknown>; take?: number }) =>
                take(tables.keys.filter((r) => matches(r, a.where)).map((r) => pick(r, a.select)), a.take),
        },
        registeredAgent: {
            findMany: async (a: { where: Record<string, unknown> }) =>
                tables.agents.filter((r) => matches(r, a.where)).map((r) => ({ ...r })),
        },
        thirdPartyAppScan: {
            findFirst: async (a: { where: Record<string, unknown> }) => tables.scans.find((r) => matches(r, a.where)) ?? null,
            findMany: async (a: { where: Record<string, unknown>; take?: number }) =>
                take(
                    tables.scans
                        .filter((r) => matches(r, a.where))
                        .sort((x, y) => (y.asOf as Date).getTime() - (x.asOf as Date).getTime()),
                    a.take,
                ),
            create: async (a: { data: Record<string, unknown> }) => {
                const row = { id: id('scan'), createdAt: new Date(), ...a.data } as Row;
                tables.scans.push(row);
                return { ...row };
            },
        },
        discoveredThirdPartyApp: {
            findMany: async (a: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
                tables.apps.filter((r) => matches(r, a.where)).map((r) => pick(r, a.select)),
            createMany: async (a: { data: Record<string, unknown>[] }) => {
                for (const d of a.data) tables.apps.push({ id: id('app'), ...d } as Row);
                return { count: a.data.length };
            },
            updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                const hit = tables.apps.filter((r) => matches(r, a.where));
                for (const r of hit) Object.assign(r, a.data);
                return { count: hit.length };
            },
            update: async (a: { where: { id: string }; data: Record<string, unknown> }) =>
                Object.assign(tables.apps.find((r) => r.id === a.where.id) as Row, a.data),
        },
        thirdPartyAppScanItem: {
            createMany: async (a: { data: Record<string, unknown>[] }) => {
                for (const d of a.data) tables.items.push({ id: id('item'), ...d } as Row);
                return { count: a.data.length };
            },
            findMany: async (a: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
                tables.items.filter((r) => matches(r, a.where)).map((r) => pick(r, a.select)),
        },
        finding: {
            findMany: async (a: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
                tables.findings.filter((r) => matches(r, a.where)).map((r) => pick(r, a.select)),
            create: async (a: { data: Record<string, unknown> }) => {
                const row = { id: id('finding'), deletedAt: null, createdAt: new Date(), ...a.data } as Row;
                tables.findings.push(row);
                return { ...row };
            },
            update: async (a: { where: { id: string }; data: Record<string, unknown> }) =>
                Object.assign(tables.findings.find((r) => r.id === a.where.id) as Row, a.data),
        },
    };
    return { db, tables };
}

let store = makeStore();

const TENANT = 'tenant-1';
const SCANNER = 'agent_scanner';
const OTHER_AGENT = 'agent_other';
const scanner = createFakeScanner();
const ctx = (overrides = {}) => makeRequestContext('OWNER', { tenantId: TENANT, ...overrides });

function trust(agentId = SCANNER, publicKey = scanner.publicKeyHex) {
    store.tables.keys.push({
        id: `key_${agentId}`,
        tenantId: TENANT,
        agentId,
        publicKey,
        keyFingerprint: harnessKeyFingerprint(publicKey),
        revokedAt: null,
    });
    store.tables.agents.push({ id: agentId, tenantId: TENANT, name: `Scanner ${agentId}`, deletedAt: null });
}

const ingest = (body: unknown, c = ctx()) => ingestThirdPartyAppReport(c, scanner.serialise(body));
const openRefs = () =>
    store.tables.findings
        .filter((f) => f.sourceKind === THIRD_PARTY_APP_FINDING_SOURCE_KIND && f.status !== 'CLOSED')
        .map((f) => f.sourceRef as string)
        .sort();
const written = () => ({
    scans: store.tables.scans.length,
    apps: store.tables.apps.length,
    items: store.tables.items.length,
    findings: store.tables.findings.length,
});

beforeEach(() => {
    store = makeStore();
    trust();
    jest.clearAllMocks();
});

describe('1. each refusal writes nothing', () => {
    const nothing = { scans: 0, apps: 0, items: 0, findings: 0 };

    it('a principal without admin.integrations_ingest is refused before anything is read', async () => {
        await expect(ingest(integrationsBody(SCANNER, 's1'), makeRequestContext('EDITOR', { tenantId: TENANT })))
            .rejects.toThrow('admin.integrations_ingest');
        // The harness key is not this key.
        const harnessOnly = makeRequestContext('OWNER', { tenantId: TENANT });
        harnessOnly.appPermissions.admin.integrations_ingest = false;
        expect(harnessOnly.appPermissions.admin.agent_harness_ingest).toBe(true);
        await expect(ingest(integrationsBody(SCANNER, 's1'), harnessOnly)).rejects.toThrow('admin.integrations_ingest');
        expect(written()).toEqual(nothing);
    });

    it('a report no trusted key signed is UNTRUSTED_SIGNER', async () => {
        const stranger = createFakeScanner();
        await expect(ingestThirdPartyAppReport(ctx(), stranger.serialise(integrationsBody(SCANNER, 's1'))))
            .rejects.toThrow('third_party_app_report_refused: UNTRUSTED_SIGNER');
        expect(written()).toEqual(nothing);
        expect(recordThirdPartyAppScanOutcome).toHaveBeenCalledWith({ outcome: 'refused', reason: 'UNTRUSTED_SIGNER' });
    });

    it('a body changed after signing is BAD_SIGNATURE', async () => {
        const wire = JSON.parse(scanner.serialise(integrationsBody(SCANNER, 's1'))) as { applications: unknown[] };
        wire.applications = [];
        await expect(ingestThirdPartyAppReport(ctx(), JSON.stringify(wire)))
            .rejects.toThrow('third_party_app_report_refused: BAD_SIGNATURE');
        expect(written()).toEqual(nothing);
    });

    it('a harness report given here is a SCHEMA refusal: neither verifier reads the other\'s', async () => {
        const harness = validV3ReportBody();
        harness.scan.scanner.agentId = SCANNER;
        await expect(ingest(harness)).rejects.toThrow('third_party_app_report_refused: SCHEMA');
        expect(written()).toEqual(nothing);
    });

    it('a secret-shaped value is refused before anything is written, and never reaches the error', async () => {
        const secret = ['gh', 'p_', 'Q'.repeat(36)].join('');
        const body = integrationsBody(SCANNER, 's1');
        body.scan.id = `s1-${secret}`;
        const refusal = ingest(body);
        await expect(refusal).rejects.toThrow('third_party_app_report_refused:');
        await expect(ingest(body)).rejects.not.toThrow(secret);
        expect(written()).toEqual(nothing);
    });

    it('a report naming another agent as its scanner is SCANNER_MISMATCH', async () => {
        await expect(ingest(integrationsBody(OTHER_AGENT, 's1'))).rejects.toThrow(
            'third_party_app_report_refused: SCANNER_MISMATCH',
        );
        expect(written()).toEqual(nothing);
    });

    it('a credential bound to another agent is SUBMITTER_MISMATCH', async () => {
        await expect(ingest(integrationsBody(SCANNER, 's1'), ctx({ agentId: OTHER_AGENT }))).rejects.toThrow(
            'third_party_app_report_refused: SUBMITTER_MISMATCH',
        );
        expect(written()).toEqual(nothing);
        // The scanner's own key may.
        await expect(ingest(integrationsBody(SCANNER, 's1'), ctx({ agentId: SCANNER }))).resolves.toMatchObject({
            scanRef: 's1',
        });
    });

    it('a revoked key verifies nothing', async () => {
        store.tables.keys[0].revokedAt = new Date();
        // The fake store filters on `revokedAt: null` as the usecase asks.
        await expect(ingest(integrationsBody(SCANNER, 's1'))).rejects.toThrow('UNTRUSTED_SIGNER');
        expect(written()).toEqual(nothing);
    });

    it('a replay is REPLAY, and writes nothing more', async () => {
        await ingest(integrationsBody(SCANNER, 's1'));
        const after = written();
        await expect(ingest(integrationsBody(SCANNER, 's1'))).rejects.toThrow('third_party_app_report_refused: REPLAY');
        expect(written()).toEqual(after);
    });
});

describe('2. the plan becomes the rows', () => {
    it('writes one scan, one application and one item each, with the planner\'s conclusions', async () => {
        const result = await ingest(threeProductBody(SCANNER, 's1'));
        expect(result).toMatchObject({ scanRef: 's1', complete: true, applicationCount: 3 });
        expect(store.tables.scans).toHaveLength(1);
        expect(store.tables.scans[0]).toMatchObject({ scannerAgentId: SCANNER, unusedDays: 90, complete: true });

        const byApp = new Map(
            store.tables.items.map((i) => [
                (store.tables.apps.find((a) => a.id === i.appId) as Row).applicationId as string,
                i,
            ]),
        );
        expect(byApp.get(entraApp(1).id)).toMatchObject({
            privilege: 'HIGH',
            usage: 'UNUSED',
            publisherVerified: false,
            ownerCount: 0,
            anyGrant: true,
        });
        expect((byApp.get(entraApp(1).id)?.classes as string[])).toEqual(expect.arrayContaining(['MAIL', 'WRITE']));
        // Okta and GitHub expose no owner, publisher or sign-in: stored as NULL, never as "none".
        for (const app of [oktaApp(), githubInstallation()]) {
            expect(byApp.get(app.id)).toMatchObject({ publisherVerified: null, ownerCount: null, usage: 'NOT_CONCLUDED' });
        }
        // Names and classes only: no role id is stored.
        const stored = JSON.stringify(store.tables.items.map((i) => i.grantsJson));
        expect(stored).not.toContain('e2a3a72e-5f79-4c64-b1b1-878b674786c9');
        expect(stored).toContain('Mail.ReadWrite');

        expect(store.tables.apps.map((a) => a.displayName).sort()).toEqual(
            ['Acme Mail Sync 1', 'Acme Provisioning', 'acme-deploy-bot'].sort(),
        );
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'THIRD_PARTY_APP_SCAN_INGESTED' }),
        );
        expect(recordThirdPartyAppScanOutcome).toHaveBeenCalledWith({ outcome: 'ingested', complete: true, empty: false });
    });

    it('a second scan of a known application adds an item and keeps one application row', async () => {
        await ingest(integrationsBody(SCANNER, 's1'));
        await ingest(integrationsBody(SCANNER, 's2', { applications: [entraApp(1, { displayName: 'Renamed' })] }));
        expect(store.tables.apps).toHaveLength(1);
        expect(store.tables.apps[0]).toMatchObject({ displayName: 'Renamed' });
        expect(store.tables.items).toHaveLength(2);
    });
});

describe('3. reconcile', () => {
    const allFour = (appId: string) =>
        (['INTEGRATION_HIGH_PRIVILEGE_GRANT', 'INTEGRATION_NO_OWNER', 'INTEGRATION_UNUSED', 'INTEGRATION_UNVERIFIED_PUBLISHER'] as const)
            .map((c) => integrationFindingRef(c, appId))
            .sort();

    it('creates what the plan raises, and does not duplicate it on the next scan', async () => {
        const first = await ingest(integrationsBody(SCANNER, 's1'));
        expect(first.findingsOpened).toBe(4);
        expect(openRefs()).toEqual(allFour(entraApp(1).id));
        const second = await ingest(integrationsBody(SCANNER, 's2'));
        expect(second).toMatchObject({ findingsOpened: 0, findingsReopened: 0, findingsResolved: 0 });
        expect(store.tables.findings).toHaveLength(4);
    });

    it('resolves what a COMPLETE source no longer raises, and reopens it when raised again', async () => {
        await ingest(integrationsBody(SCANNER, 's1'));
        const quiet = quietEntraApp(1);
        const resolved = await ingest(integrationsBody(SCANNER, 's2', { applications: [quiet] }));
        expect(resolved.findingsResolved).toBe(4);
        expect(openRefs()).toEqual([]);

        const reopened = await ingest(integrationsBody(SCANNER, 's3'));
        expect(reopened).toMatchObject({ findingsOpened: 0, findingsReopened: 4 });
        expect(openRefs()).toEqual(allFour(entraApp(1).id));
    });

    it('an INCOMPLETE source closes nothing, even for an application it lists cleanly', async () => {
        await ingest(integrationsBody(SCANNER, 's1'));
        const result = await ingest(
            integrationsBody(SCANNER, 's2', {
                sources: [{ ...ENTRA_COMPLETE, status: 'INCOMPLETE', reason: 'RATE_LIMITED' }],
                applications: [quietEntraApp(1)],
            }),
        );
        expect(result.findingsResolved).toBe(0);
        expect(openRefs()).toEqual(allFour(entraApp(1).id));
    });

    it('a member the read did not establish closes nothing: owners not read, sign-in not read', async () => {
        await ingest(integrationsBody(SCANNER, 's1'));
        // Its own directory's now (so the publisher question is answered), still
        // holding Mail.Read (MAIL: high), owners NOT READ, sign-in NOT READ.
        const result = await ingest(
            integrationsBody(SCANNER, 's2', {
                applications: [
                    quietEntraApp(1, {
                        owners: null,
                        signIn: { read: false, lastSeen: null },
                        delegatedGrants: entraApp(1).delegatedGrants,
                    }),
                ],
                sources: [{ ...ENTRA_COMPLETE, signInActivity: { status: 'NOT_READ' } }],
            }),
        );
        expect(result.findingsResolved).toBe(1);
        expect(openRefs()).toEqual(
            [
                integrationFindingRef('INTEGRATION_HIGH_PRIVILEGE_GRANT', entraApp(1).id),
                integrationFindingRef('INTEGRATION_NO_OWNER', entraApp(1).id),
                integrationFindingRef('INTEGRATION_UNUSED', entraApp(1).id),
            ].sort(),
        );
    });

    it('an application ABSENT from a complete scan closes nothing about it', async () => {
        await ingest(integrationsBody(SCANNER, 's1'));
        const result = await ingest(integrationsBody(SCANNER, 's2', { applications: [quietEntraApp(2)] }));
        expect(result.findingsResolved).toBe(0);
        expect(openRefs()).toEqual(allFour(entraApp(1).id));
    });

    it('an empty complete source is a finding scoped to its scanner, closed only by the same scanner', async () => {
        const other = createFakeScanner();
        trust(OTHER_AGENT, other.publicKeyHex);
        const empty = await ingest(integrationsBody(SCANNER, 's1', { applications: [] }));
        expect(empty.findingsOpened).toBe(1);
        const ref = sourceFindingRef(integrationFindingRef('INTEGRATION_EMPTY_INVENTORY', 'entra-integrations'), SCANNER);
        expect(openRefs()).toEqual([ref]);

        // Another scanner's complete read of ITS directory does not close it.
        await ingestThirdPartyAppReport(ctx(), other.serialise(integrationsBody(OTHER_AGENT, 'o1', { applications: [quietEntraApp(3)] })));
        expect(openRefs()).toEqual([ref]);

        // The same scanner finding an application does.
        const found = await ingest(integrationsBody(SCANNER, 's2', { applications: [quietEntraApp(4)] }));
        expect(found.findingsResolved).toBe(1);
        expect(openRefs()).toEqual([]);
    });

    it('an INCOMPLETE empty source raises no empty-inventory finding', async () => {
        const result = await ingest(
            integrationsBody(SCANNER, 's1', {
                sources: [{ ...ENTRA_COMPLETE, status: 'INCOMPLETE', reason: 'AUTH_FAILED' }],
                applications: [],
            }),
        );
        expect(result).toMatchObject({ complete: false, findingsOpened: 0 });
        expect(recordThirdPartyAppScanOutcome).toHaveBeenCalledWith({ outcome: 'ingested', complete: false, empty: true });
    });
});

describe('4. the inventory read', () => {
    it('names no scan as a condition, and a trusted scanner with no scan', async () => {
        const view = await getThirdPartyAppInventory(ctx());
        expect(view.sections).toEqual([]);
        expect(view.scannersWithoutScan.rows).toEqual([{ agentId: SCANNER, name: `Scanner ${SCANNER}` }]);
    });

    it('is the inventory read: a member without the view key is refused', async () => {
        await expect(getThirdPartyAppInventory(makeRequestContext('EDITOR', { tenantId: TENANT }))).rejects.toThrow(
            'admin.agent_registry_view',
        );
    });

    it('reads the latest scan: coverage, rows worst first, not-exposed members, open findings', async () => {
        await ingest(threeProductBody(SCANNER, 's1'));
        const view = await getThirdPartyAppInventory(ctx());
        expect(view.sections).toHaveLength(1);
        const [section] = view.sections;
        expect(section.scan.completeness).toBe('COMPLETE');
        expect(section.sources?.map((s) => [s.kind, s.status, s.product])).toEqual([
            ['entra-integrations', 'COMPLETE', 'Microsoft Entra ID'],
            ['okta-integrations', 'COMPLETE', 'Okta'],
            ['github-integrations', 'COMPLETE', 'GitHub'],
        ]);
        const entra = section.rows.find((r) => r.applicationId === entraApp(1).id);
        expect(entra).toMatchObject({
            privilege: 'HIGH',
            publisher: { state: 'READ', verified: false },
            owners: { state: 'READ', count: 0 },
            signIn: 'READ',
            usage: 'UNUSED',
        });
        expect(entra?.openFindings.map((f) => f.code).sort()).toEqual([
            'INTEGRATION_HIGH_PRIVILEGE_GRANT',
            'INTEGRATION_NO_OWNER',
            'INTEGRATION_UNUSED',
            'INTEGRATION_UNVERIFIED_PUBLISHER',
        ]);
        // The row with the most open findings comes first.
        expect(section.rows[0].applicationId).toBe(entraApp(1).id);
        const okta = section.rows.find((r) => r.applicationId === oktaApp().id);
        expect(okta).toMatchObject({
            publisher: { state: 'NOT_EXPOSED' },
            owners: { state: 'NOT_EXPOSED' },
            signIn: 'NOT_EXPOSED',
        });
        expect(view.scannersWithoutScan.rows).toEqual([]);
    });

    it('an empty complete scan is EMPTY, never complete', async () => {
        await ingest(integrationsBody(SCANNER, 's1', { applications: [] } as Partial<IntegrationsReportBody>));
        const view = await getThirdPartyAppInventory(ctx());
        expect(view.sections[0].scan.completeness).toBe('EMPTY');
        expect(view.sections[0].sources?.[0].openFindings.map((f) => f.code)).toEqual(['INTEGRATION_EMPTY_INVENTORY']);
    });
});
