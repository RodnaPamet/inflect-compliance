/**
 * The agent-surface rules ingest (`usecases/agent-rule-scans.ts`), against an
 * in-memory store in place of the database.
 *
 *   1. EACH REFUSAL WRITES NOTHING: the key, an untrusted signer, a tampered
 *      body, another contract's report, a secret, a scanner that names another
 *      agent, a credential bound to another agent, a replay.
 *   2. THE PLAN BECOMES THE ROWS: one scan with its origins and outcome, one
 *      item per finding, and one OBSERVATION finding per rule and field, with
 *      no text of the definition.
 *   3. WHAT A SCAN CLOSES (owner decision, 2026-11-22): a finding closes only
 *      when the SAME scanner reads its SERVER in full and the rule does not
 *      fire again. A server read in part, a server absent from the scan, and
 *      another scanner's scan close nothing; a closed finding raised again is
 *      reopened.
 *   4. THE TAB'S READ: the latest scan per scanner, its origins, and the
 *      scanner's open findings; a read of nothing is NOTHING_READ, never clean.
 *
 * The real database, RLS and the replay's unique index are the integration
 * test's (`tests/integration/agent-rule-scans.test.ts`).
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(store.db)),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordAgentRuleScanOutcome: jest.fn(),
}));

import { logEvent } from '@/app-layer/events/audit';
import { recordAgentRuleScanOutcome } from '@/lib/observability/integration-metrics';
import {
    AGENT_RULE_FINDING_SOURCE_KIND,
    agentRuleFindingSourceRef,
    findingSeverityOf,
    getAgentRuleInventory,
    ingestAgentRuleReport,
} from '@/app-layer/usecases/agent-rule-scans';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import { agentRuleFindingRef } from '@rodnapamet/scanent-contract/agent-rules-findings';

import { makeRequestContext } from '../helpers/make-context';
import { createFakeScanner, validV3ReportBody } from '../helpers/agent-harness-fake-scanner';
import { integrationsBody } from '../helpers/third-party-app-fake-report';
import { agentRulesBody, complete, CRM, partial, REPO, ruleFinding, skillFinding, TICKETS } from '../helpers/agent-rule-fake-report';

// ─── A store just wide enough for the usecase ──────────────────────────────

type Row = Record<string, unknown> & { id: string };

function makeStore() {
    let seq = 0;
    const id = (p: string) => `${p}_${++seq}`;
    const tables = {
        keys: [] as Row[],
        scans: [] as Row[],
        items: [] as Row[],
        findings: [] as Row[],
        agents: [] as Row[],
    };
    const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
        Object.entries(where).every(([k, v]) => {
            if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
                const cond = v as { in?: unknown[]; not?: unknown; endsWith?: string };
                if ('in' in cond) return (cond.in ?? []).includes(row[k]);
                if ('not' in cond) return row[k] !== cond.not;
                if ('endsWith' in cond) return typeof row[k] === 'string' && (row[k] as string).endsWith(cond.endsWith as string);
            }
            return row[k] === v;
        });
    const pick = (row: Row, select?: Record<string, unknown>) => {
        if (!select) return { ...row };
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
    };
    const take = <T>(rows: T[], n?: number) => (n === undefined ? rows : rows.slice(0, n));
    const byAsOf = (x: Row, y: Row) => (y.asOf as Date).getTime() - (x.asOf as Date).getTime() || (y.createdAt as number) - (x.createdAt as number);
    let tick = 0;
    const db = {
        agentHarnessScannerKey: {
            findMany: async (a: { where: Record<string, unknown>; select?: Record<string, unknown>; take?: number; distinct?: string[] }) => {
                const rows = tables.keys.filter((r) => matches(r, a.where));
                const unique = a.distinct ? rows.filter((r, i) => rows.findIndex((o) => o.agentId === r.agentId) === i) : rows;
                return take(unique.map((r) => pick(r, a.select)), a.take);
            },
        },
        registeredAgent: {
            findMany: async (a: { where: Record<string, unknown> }) => tables.agents.filter((r) => matches(r, a.where)).map((r) => ({ ...r })),
        },
        agentRuleScan: {
            findFirst: async (a: { where: Record<string, unknown> }) => tables.scans.find((r) => matches(r, a.where)) ?? null,
            findMany: async (a: { where: Record<string, unknown>; take?: number }) =>
                take(tables.scans.filter((r) => matches(r, a.where)).sort(byAsOf), a.take).map((r) => ({ ...r })),
            create: async (a: { data: Record<string, unknown> }) => {
                const row = { id: id('scan'), createdAt: ++tick, ...a.data } as Row;
                tables.scans.push(row);
                return { ...row };
            },
        },
        agentRuleScanItem: {
            createMany: async (a: { data: Record<string, unknown>[] }) => {
                for (const d of a.data) tables.items.push({ id: id('item'), ...d } as Row);
                return { count: a.data.length };
            },
            groupBy: async (a: { by: string[]; where: Record<string, unknown> }) => {
                const seen = new Map<string, Record<string, unknown>>();
                for (const r of tables.items.filter((x) => matches(x, a.where))) {
                    const g = Object.fromEntries(a.by.map((k) => [k, r[k]]));
                    seen.set(JSON.stringify(g), g);
                }
                return [...seen.values()];
            },
        },
        finding: {
            findMany: async (a: { where: Record<string, unknown>; select?: Record<string, unknown>; take?: number }) =>
                take(tables.findings.filter((r) => matches(r, a.where)).map((r) => pick(r, a.select)), a.take),
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
const OTHER = 'agent_other';
const scanner = createFakeScanner();
const otherScanner = createFakeScanner();
const ctx = (overrides = {}) => makeRequestContext('OWNER', { tenantId: TENANT, ...overrides });

function trust(agentId = SCANNER, publicKey = scanner.publicKeyHex) {
    store.tables.keys.push({ id: `key_${agentId}`, tenantId: TENANT, agentId, publicKey, keyFingerprint: harnessKeyFingerprint(publicKey), revokedAt: null });
    store.tables.agents.push({ id: agentId, tenantId: TENANT, name: `Scanner ${agentId}`, deletedAt: null });
}

const ingest = (body: unknown, c = ctx(), s = scanner) => ingestAgentRuleReport(c, s.serialise(body));
const refOf = (f: ReturnType<typeof ruleFinding>, by = SCANNER) => agentRuleFindingSourceRef(agentRuleFindingRef(f), by);
const statusOf = (ref: string) => store.tables.findings.find((f) => f.sourceRef === ref)?.status;
const written = () => ({ scans: store.tables.scans.length, items: store.tables.items.length, findings: store.tables.findings.length });

beforeEach(() => {
    store = makeStore();
    trust();
    jest.clearAllMocks();
});

describe('1. each refusal writes nothing', () => {
    const nothing = { scans: 0, items: 0, findings: 0 };

    it('a principal without admin.agent_rules_ingest is refused, and the other ingest keys are not this key', async () => {
        await expect(ingest(agentRulesBody(SCANNER, 's1'), makeRequestContext('EDITOR', { tenantId: TENANT }))).rejects.toThrow('admin.agent_rules_ingest');
        const others = makeRequestContext('OWNER', { tenantId: TENANT });
        others.appPermissions.admin.agent_rules_ingest = false;
        expect(others.appPermissions.admin.integrations_ingest).toBe(true);
        await expect(ingest(agentRulesBody(SCANNER, 's1'), others)).rejects.toThrow('admin.agent_rules_ingest');
        expect(written()).toEqual(nothing);
    });

    it('an untrusted signer, a tampered body and another contract are refused by their code', async () => {
        await expect(ingest(agentRulesBody(SCANNER, 's1'), ctx(), createFakeScanner())).rejects.toThrow('agent_rules_report_refused: UNTRUSTED_SIGNER');
        expect(recordAgentRuleScanOutcome).toHaveBeenCalledWith({ outcome: 'refused', reason: 'UNTRUSTED_SIGNER' });
        const wire = JSON.parse(scanner.serialise(agentRulesBody(SCANNER, 's1'))) as { findings: unknown[] };
        wire.findings = [];
        await expect(ingestAgentRuleReport(ctx(), JSON.stringify(wire))).rejects.toThrow('agent_rules_report_refused: BAD_SIGNATURE');
        const harness = validV3ReportBody();
        harness.scan.scanner.agentId = SCANNER;
        await expect(ingest(harness)).rejects.toThrow('agent_rules_report_refused: SCHEMA');
        await expect(ingest(integrationsBody(SCANNER, 's1'))).rejects.toThrow('agent_rules_report_refused: SCHEMA');
        expect(written()).toEqual(nothing);
    });

    it('a secret-shaped value, a scanner naming another agent and a credential bound to another agent are refused', async () => {
        const secret = ['gh', 'p_', 'Q'.repeat(36)].join('');
        const body = agentRulesBody(SCANNER, 's1');
        body.scan.id = `s1-${secret}`;
        await expect(ingest(body)).rejects.toThrow('agent_rules_report_refused:');
        await expect(ingest(body)).rejects.not.toThrow(secret);
        await expect(ingest(agentRulesBody(OTHER, 's1'))).rejects.toThrow('agent_rules_report_refused: SCANNER_MISMATCH');
        await expect(ingest(agentRulesBody(SCANNER, 's1'), ctx({ agentId: OTHER }))).rejects.toThrow('agent_rules_report_refused: SUBMITTER_MISMATCH');
        expect(written()).toEqual(nothing);
    });

    it('a replay is REPLAY, and writes nothing more', async () => {
        await ingest(agentRulesBody(SCANNER, 's1'));
        const before = written();
        await expect(ingest(agentRulesBody(SCANNER, 's1'))).rejects.toThrow('agent_rules_report_refused: REPLAY');
        expect(written()).toEqual(before);
    });
});

describe('2. the plan becomes the rows', () => {
    it('one scan with its origins and outcome, one item and one OBSERVATION per rule and field, no text', async () => {
        const f = ruleFinding(CRM, 'lookup_account');
        const result = await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3), complete(TICKETS, 1)], [f]));
        expect(result).toMatchObject({ scanRef: 's1', complete: true, findingCount: 1, findingsOpened: 1, findingsReopened: 0, findingsResolved: 0 });
        expect(store.tables.scans[0]).toMatchObject({ outcome: 'FINDINGS', subjects: 4, flagged: 1, findingCount: 1, complete: true });
        expect(store.tables.scans[0].originsJson).toEqual([complete(CRM, 3), complete(TICKETS, 1)]);
        expect(store.tables.items).toEqual([expect.objectContaining({ sourceRef: refOf(f), originRef: CRM, code: 'MCP_PROMPT_INJECTION', locator: f.locator })]);
        const finding = store.tables.findings[0];
        expect(finding).toMatchObject({ sourceKind: AGENT_RULE_FINDING_SOURCE_KIND, sourceRef: refOf(f), type: 'OBSERVATION', severity: 'HIGH', status: 'OPEN' });
        expect(finding.title).toBe('Possible prompt injection in an MCP tool definition');
        expect(finding.description).toContain('cisco-mcp:instruction-override');
        expect(finding.description).toContain('a suggestion for a person to confirm');
        expect(recordAgentRuleScanOutcome).toHaveBeenCalledWith({ outcome: 'ingested', complete: true, empty: false });
        expect(logEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ action: 'AGENT_RULE_SCAN_INGESTED' }));
    });

    it('INFO is stored LOW, which FindingSeverity has; nothing is CRITICAL', () => {
        expect(['INFO', 'LOW', 'MEDIUM', 'HIGH'].map(findingSeverityOf)).toEqual(['LOW', 'LOW', 'MEDIUM', 'HIGH']);
    });

    it('a read of nothing is NOTHING_READ, ingested and never called clean', async () => {
        await ingest(agentRulesBody(SCANNER, 's1', [], []));
        expect(store.tables.scans[0]).toMatchObject({ outcome: 'NOTHING_READ', subjects: 0 });
        expect(recordAgentRuleScanOutcome).toHaveBeenCalledWith({ outcome: 'ingested', complete: true, empty: true });
    });
});

describe('3. what a scan closes', () => {
    const f = ruleFinding(CRM, 'lookup_account');

    it('the same scanner reading the finding\'s server in full, without the rule firing, closes it; raising it again reopens it', async () => {
        await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3)], [f]));
        expect(statusOf(refOf(f))).toBe('OPEN');
        const second = await ingest(agentRulesBody(SCANNER, 's2', [complete(CRM, 3)], []));
        expect(second.findingsResolved).toBe(1);
        expect(statusOf(refOf(f))).toBe('CLOSED');
        const third = await ingest(agentRulesBody(SCANNER, 's3', [complete(CRM, 3)], [f]));
        expect(third.findingsReopened).toBe(1);
        expect(statusOf(refOf(f))).toBe('OPEN');
    });

    it('a server read in part closes nothing on it', async () => {
        await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3)], [f]));
        const second = await ingest(agentRulesBody(SCANNER, 's2', [partial(CRM, 1)], []));
        expect(second.findingsResolved).toBe(0);
        expect(statusOf(refOf(f))).toBe('OPEN');
    });

    it('a server absent from the scan closes nothing, even when every server it did read was read in full', async () => {
        await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3), complete(TICKETS, 1)], [f]));
        const second = await ingest(agentRulesBody(SCANNER, 's2', [complete(TICKETS, 1)], []));
        expect(second.findingsResolved).toBe(0);
        expect(statusOf(refOf(f))).toBe('OPEN');
    });

    it('another scanner reading the same server in full closes nothing of this scanner\'s', async () => {
        trust(OTHER, otherScanner.publicKeyHex);
        await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3)], [f]));
        const theirs = await ingest(agentRulesBody(OTHER, 'o1', [complete(CRM, 3)], []), ctx(), otherScanner);
        expect(theirs.findingsResolved).toBe(0);
        expect(statusOf(refOf(f))).toBe('OPEN');
    });

    it('a skill finding closes only on its own code root read in full, never on an MCP-only scan', async () => {
        const skill = skillFinding(REPO, 'skills/report/SKILL.md');
        await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3), complete(REPO, 2)], [skill]));
        expect(statusOf(refOf(skill))).toBe('OPEN');
        // A scan that read the server but not the root says nothing about the skill.
        expect((await ingest(agentRulesBody(SCANNER, 's2', [complete(CRM, 3)], []))).findingsResolved).toBe(0);
        // The root read in part closes nothing either.
        expect((await ingest(agentRulesBody(SCANNER, 's3', [complete(CRM, 3), partial(REPO, 1, 'TIME_BOX')], []))).findingsResolved).toBe(0);
        expect(statusOf(refOf(skill))).toBe('OPEN');
        // The root read in full, with the rule silent: closed.
        expect((await ingest(agentRulesBody(SCANNER, 's4', [complete(CRM, 3), complete(REPO, 2)], []))).findingsResolved).toBe(1);
        expect(statusOf(refOf(skill))).toBe('CLOSED');
    });

    it('a skill finding is titled for a skill, and says to open the skill', async () => {
        const skill = skillFinding(REPO, 'skills/report/SKILL.md');
        await ingest(agentRulesBody(SCANNER, 's1', [complete(REPO, 2)], [skill]));
        const finding = store.tables.findings.find((x) => x.sourceRef === refOf(skill));
        expect(finding?.title).toBe('Possible prompt injection in an agent skill');
        expect(finding?.description).toContain("open the skill's SKILL.md");
        expect(finding?.description).toContain(`read from ${REPO}`);
        expect(store.tables.items).toEqual([expect.objectContaining({ originRef: REPO, locator: skill.locator })]);
    });

    it('the same rule on the same field, listed twice, is one finding and one item', async () => {
        const result = await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3)], [f, f]));
        expect(result.findingCount).toBe(1);
        expect(store.tables.items).toHaveLength(1);
        expect(store.tables.findings).toHaveLength(1);
    });
});

describe('4. the tab\'s read', () => {
    it('each scanner\'s latest scan, its origins, and its open findings; a scanner with a key and no scan is named', async () => {
        trust(OTHER, otherScanner.publicKeyHex);
        const f = ruleFinding(CRM, 'lookup_account');
        const g = ruleFinding(TICKETS, 'close_ticket', { code: 'MCP_TOOL_POISONING', ruleId: 'cisco-mcp:also-does', severity: 'MEDIUM' });
        await ingest(agentRulesBody(SCANNER, 's1', [complete(CRM, 3), complete(TICKETS, 1)], [g, f]));
        const view = await getAgentRuleInventory(ctx());
        expect(view.sections).toHaveLength(1);
        const [section] = view.sections;
        expect(section.scan).toMatchObject({ scanRef: 's1', outcome: 'FINDINGS', complete: true, subjects: 4 });
        expect(section.origins).toEqual([
            { ref: CRM, status: 'COMPLETE', reason: null, subjects: 3 },
            { ref: TICKETS, status: 'COMPLETE', reason: null, subjects: 1 },
        ]);
        expect(section.findings.map((x) => [x.severity, x.code, x.field])).toEqual([
            ['HIGH', 'MCP_PROMPT_INJECTION', 'description'],
            ['MEDIUM', 'MCP_TOOL_POISONING', 'description'],
        ]);
        expect(view.scannersWithoutScan.map((s) => s.agentId)).toEqual([OTHER]);
    });

    it('a partial read says its reason, and nothing is called clean of it', async () => {
        await ingest(agentRulesBody(SCANNER, 's1', [partial(CRM, 1, 'AUTH_FAILED')], []));
        const [section] = (await getAgentRuleInventory(ctx())).sections;
        expect(section.scan).toMatchObject({ outcome: 'NOT_CONCLUDED', complete: false, incompleteReason: 'AUTH_FAILED' });
    });

    it('reading needs the inventory key', async () => {
        const reader = makeRequestContext('EDITOR', { tenantId: TENANT });
        await expect(getAgentRuleInventory(reader)).rejects.toThrow('admin.agent_registry_view');
    });
});
