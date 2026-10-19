/**
 * What one verified harness report means (#3665): the pure planner.
 *
 * The ingest executes this plan, so the rules are proved here: the level is
 * derived and never read; the register, not the report, decides SHADOW; each
 * finding opens on the condition it names; and a scan closes a finding only on
 * positive evidence.
 */
import { validReportBody, validIncompleteReportBody } from '../../helpers/agent-harness-fake-scanner';
import {
    firstSecretShapedMember,
    intakeClaimsByDiscoveredId,
    isHarnessShortfall,
    isIntakeClaimLinkable,
    planHarnessScan,
    reachOf,
    shortfallFinding,
    type IntakeClaim,
    type PriorHarnessState,
} from '@/lib/agentic/harness-findings';
import type { HarnessReportBody } from '@/lib/agentic/harness-contract';
import type { HarnessLevel } from '@/lib/agentic/harness-ladder';

function prior(over: Partial<PriorHarnessState> = {}): PriorHarnessState {
    return {
        previousLevels: new Map<string, HarnessLevel>(),
        registeredAgentIds: new Set(['agt_registered_1']),
        acceptedShortfalls: new Set<string>(),
        intakeClaims: new Map<string, IntakeClaim>(),
        ...over,
    };
}

const refs = (xs: readonly { sourceRef: string }[]) => xs.map((x) => x.sourceRef).sort();

describe('levels are derived by the ladder, never read', () => {
    it('scores each agent from its verdicts', () => {
        const plan = planHarnessScan(validReportBody(), prior());
        const byId = Object.fromEntries(plan.agents.map((a) => [a.discoveredId, a]));
        expect(byId['entra:sp:registered-1'].level).toBe('H2');
        expect(byId['entra:sp:registered-1'].blockingNextRung).toContain('H3.manifests_pinned');
        expect(byId['entra:sp:shadow-1'].level).toBe('H0');
    });

    it('a "met" with no evidence is not met', () => {
        const body = validReportBody();
        body.agents[0].verdicts = body.agents[0].verdicts.map((v) => (v.criterion === 'H1.owner' ? { ...v, evidence: null } : v));
        expect(planHarnessScan(body, prior()).agents[0].level).toBe('H0');
    });
});

describe('the register decides SHADOW, whatever the report claims', () => {
    it('a registered agent the register knows is linked', () => {
        const plan = planHarnessScan(validReportBody(), prior());
        expect(plan.agents[0].registeredAgentId).toBe('agt_registered_1');
        expect(plan.resolve).toContain('SHADOW_AGENT:entra:sp:registered-1');
    });

    it('a claimed register id the register does not hold is SHADOW', () => {
        const plan = planHarnessScan(validReportBody(), prior({ registeredAgentIds: new Set() }));
        expect(plan.agents[0].registeredAgentId).toBeNull();
        expect(refs(plan.assert)).toContain('SHADOW_AGENT:entra:sp:registered-1');
    });

    it('an unregistered agent is SHADOW', () => {
        expect(refs(planHarnessScan(validReportBody(), prior()).assert)).toContain('SHADOW_AGENT:entra:sp:shadow-1');
    });
});

describe('reach', () => {
    const tool = (readOnlyHint: boolean | null) => ({ server: 'https://m.example/x', name: 't', manifestHash: null, pinned: true, readOnlyHint });

    it('an undeclared hint is a write', () => {
        expect(reachOf({ tools: [tool(null)] }, true)).toBe('WRITE_OR_EXTERNAL');
    });

    it('read-only only when every tool says so AND the mcp source was read in full', () => {
        expect(reachOf({ tools: [tool(true)] }, true)).toBe('READ_ONLY');
        expect(reachOf({ tools: [tool(true)] }, false)).toBe('UNKNOWN');
        expect(reachOf({ tools: [] }, false)).toBe('UNKNOWN');
    });

    it('unknown reach is held to the higher bar', () => {
        expect(isHarnessShortfall('H2', 'READ_ONLY')).toBe(false);
        expect(isHarnessShortfall('H2', 'UNKNOWN')).toBe(true);
        expect(isHarnessShortfall('H2', 'WRITE_OR_EXTERNAL')).toBe(true);
        expect(isHarnessShortfall('H3', 'WRITE_OR_EXTERNAL')).toBe(false);
    });
});

describe('each finding opens on the condition it names', () => {
    it('the fake scanner’s shadow agent raises SHADOW, UNPINNED and SHORTFALL', () => {
        const plan = planHarnessScan(validReportBody(), prior());
        expect(refs(plan.assert)).toEqual([
            'HARNESS_SHORTFALL:entra:sp:shadow-1',
            'SHADOW_AGENT:entra:sp:shadow-1',
            'UNPINNED_WRITE_TOOL:entra:sp:shadow-1',
        ]);
        const shortfall = plan.assert.find((f) => f.code === 'HARNESS_SHORTFALL');
        expect(shortfall?.title).toMatch(/H0, bar H3/);
    });

    it('a read-only agent at H2 meets its bar; one at H1 falls short at H2', () => {
        const body = validReportBody();
        body.agents = [body.agents[0]];
        expect(refs(planHarnessScan(body, prior()).assert)).toEqual([]);
        body.agents[0].verdicts = body.agents[0].verdicts.filter((v) => !v.criterion.startsWith('H2.'));
        const f = planHarnessScan(body, prior()).assert.find((x) => x.code === 'HARNESS_SHORTFALL');
        expect(f?.title).toMatch(/H1, bar H2/);
        expect(f?.severity).toBe('MEDIUM');
    });

    it('LEVEL_DROP fires when the level fell since the last scan, keyed by the scan', () => {
        const plan = planHarnessScan(validReportBody(), prior({ previousLevels: new Map([['entra:sp:registered-1', 'H3']]) }));
        expect(refs(plan.assert)).toContain('LEVEL_DROP:entra:sp:registered-1:scan_01JFAKE');
        // …and never on a rise or a hold.
        const same = planHarnessScan(validReportBody(), prior({ previousLevels: new Map([['entra:sp:registered-1', 'H2']]) }));
        expect(refs(same.assert).some((r) => r.startsWith('LEVEL_DROP'))).toBe(false);
    });

    it('an active acceptance holds the shortfall back without resolving it', () => {
        const plan = planHarnessScan(validReportBody(), prior({ acceptedShortfalls: new Set(['entra:sp:shadow-1']) }));
        expect(refs(plan.assert)).not.toContain('HARNESS_SHORTFALL:entra:sp:shadow-1');
        expect(plan.resolve).not.toContain('HARNESS_SHORTFALL:entra:sp:shadow-1');
    });
});

describe('zero is never clean', () => {
    it('a scan with no agents raises EMPTY_SCAN', () => {
        const body: HarnessReportBody = { ...validReportBody(), agents: [], findings: [] };
        const plan = planHarnessScan(body, prior());
        expect(refs(plan.assert)).toEqual(['EMPTY_SCAN:agt_scanner']);
        expect(plan.resolve).not.toContain('EMPTY_SCAN:agt_scanner');
    });

    it('a non-empty scan resolves it', () => {
        expect(planHarnessScan(validReportBody(), prior()).resolve).toContain('EMPTY_SCAN:agt_scanner');
    });
});

describe('a scan closes a finding only on positive evidence', () => {
    it('an incomplete source raises INCOMPLETE_SOURCE and resolves only the complete ones', () => {
        const body = validIncompleteReportBody();
        const plan = planHarnessScan(body, prior());
        const incomplete = body.population.sources.filter((s) => s.status === 'INCOMPLETE').map((s) => `INCOMPLETE_SOURCE:agt_scanner:${s.kind}`);
        expect(incomplete.length).toBeGreaterThan(0);
        for (const r of incomplete) {
            expect(refs(plan.assert)).toContain(r);
            expect(plan.resolve).not.toContain(r);
        }
    });

    it('no unpinned write tool resolves UNPINNED only when every MCP server was read', () => {
        const body = validReportBody();
        body.agents[1].tools = [];
        expect(planHarnessScan(body, prior()).resolve).toContain('UNPINNED_WRITE_TOOL:entra:sp:shadow-1');
        body.population.sources = body.population.sources.map((s) =>
            s.kind === 'mcp' ? { kind: 'mcp', status: 'INCOMPLETE', reason: 'TIME_BOX', rows: 1 } : s,
        );
        expect(planHarnessScan(body, prior()).resolve).not.toContain('UNPINNED_WRITE_TOOL:entra:sp:shadow-1');
    });

    it('an agent absent from a scan resolves nothing about it', () => {
        const body = validReportBody();
        body.agents = [body.agents[0]];
        const plan = planHarnessScan(body, prior());
        expect(plan.resolve.some((r) => r.includes('shadow-1'))).toBe(false);
    });
});

describe('the intake\'s own record links an agent the report links to nothing (#3712)', () => {
    const SHADOW = 'entra:sp:shadow-1';
    const REGISTERED = 'entra:sp:registered-1';
    const claim = (over: Partial<IntakeClaim> = {}): IntakeClaim => ({
        registeredAgentId: 'agt_intake',
        status: 'DRAFT',
        deleted: false,
        ...over,
    });
    const withIntake = (discoveredId: string, c: IntakeClaim = claim()) =>
        prior({ intakeClaims: new Map([[discoveredId, c]]) });
    const agentOf = (plan: ReturnType<typeof planHarnessScan>, id: string) => {
        const a = plan.agents.find((x) => x.discoveredId === id);
        if (!a) throw new Error(`no planned agent ${id}`);
        return a;
    };

    it('a complete scan with no claimed id links the intake\'s register row and closes the SHADOW_AGENT finding', () => {
        const body = validReportBody();
        expect(body.agents[1].registeredAgentId).toBeNull();
        const plan = planHarnessScan(body, withIntake(SHADOW));
        expect(agentOf(plan, SHADOW)).toMatchObject({ registeredAgentId: 'agt_intake', linkBasis: 'INTAKE' });
        expect(plan.resolve).toContain(`SHADOW_AGENT:${SHADOW}`);
        expect(refs(plan.assert)).not.toContain(`SHADOW_AGENT:${SHADOW}`);
        expect(plan.intakeConflicts).toEqual([]);
        // The pair proves the branch: the same scan without the intake row
        // raises the finding and links nothing.
        const bare = planHarnessScan(body, prior());
        expect(agentOf(bare, SHADOW)).toMatchObject({ registeredAgentId: null, linkBasis: null });
        expect(refs(bare.assert)).toContain(`SHADOW_AGENT:${SHADOW}`);
    });

    it('a claimed id the register does not hold is no link at all, so the intake\'s record links', () => {
        const body = validReportBody();
        body.agents[1].registeredAgentId = 'agt_not_in_register';
        const plan = planHarnessScan(body, withIntake(SHADOW));
        expect(agentOf(plan, SHADOW)).toMatchObject({ registeredAgentId: 'agt_intake', linkBasis: 'INTAKE' });
        expect(plan.intakeConflicts).toEqual([]);
    });

    it('a report naming a different register row is not overridden by the intake link, and the conflict is returned', () => {
        const plan = planHarnessScan(validReportBody(), withIntake(REGISTERED));
        expect(agentOf(plan, REGISTERED)).toMatchObject({ registeredAgentId: 'agt_registered_1', linkBasis: 'REPORT' });
        expect(plan.resolve).toContain(`SHADOW_AGENT:${REGISTERED}`);
        expect(plan.intakeConflicts).toEqual([
            { discoveredId: REGISTERED, reportedRegisteredAgentId: 'agt_registered_1', intakeRegisteredAgentId: 'agt_intake' },
        ]);
    });

    it('a report naming the intake\'s own row is the report\'s link and no conflict', () => {
        const plan = planHarnessScan(validReportBody(), withIntake(REGISTERED, claim({ registeredAgentId: 'agt_registered_1' })));
        expect(agentOf(plan, REGISTERED)).toMatchObject({ registeredAgentId: 'agt_registered_1', linkBasis: 'REPORT' });
        expect(plan.intakeConflicts).toEqual([]);
    });

    it('a retired intake row is never linked — nor a deleted one, nor a status the allowlist does not name', () => {
        for (const c of [claim({ status: 'RETIRED' }), claim({ deleted: true }), claim({ status: 'ARCHIVED' })]) {
            const plan = planHarnessScan(validReportBody(), withIntake(SHADOW, c));
            expect(agentOf(plan, SHADOW)).toMatchObject({ registeredAgentId: null, linkBasis: null });
            expect(refs(plan.assert)).toContain(`SHADOW_AGENT:${SHADOW}`);
            expect(plan.resolve).not.toContain(`SHADOW_AGENT:${SHADOW}`);
        }
        // …and a retired intake row is no conflict with a report either.
        const reported = planHarnessScan(validReportBody(), withIntake(REGISTERED, claim({ status: 'RETIRED' })));
        expect(reported.intakeConflicts).toEqual([]);
    });

    it('every live, non-retired status links', () => {
        for (const status of ['DRAFT', 'ACTIVE', 'SUSPENDED']) {
            expect(isIntakeClaimLinkable({ status, deleted: false })).toBe(true);
            expect(isIntakeClaimLinkable({ status, deleted: true })).toBe(false);
        }
        expect(isIntakeClaimLinkable({ status: 'RETIRED', deleted: false })).toBe(false);
    });

    it('an incomplete scan links the agent but neither raises nor resolves its SHADOW_AGENT finding', () => {
        const plan = planHarnessScan(validIncompleteReportBody(), withIntake(SHADOW));
        expect(agentOf(plan, SHADOW)).toMatchObject({ registeredAgentId: 'agt_intake', linkBasis: 'INTAKE' });
        expect(plan.resolve).not.toContain(`SHADOW_AGENT:${SHADOW}`);
        expect(refs(plan.assert)).not.toContain(`SHADOW_AGENT:${SHADOW}`);
        // A link the REPORT claimed is still resolved on an incomplete scan,
        // as before: that rule is unchanged.
        expect(plan.resolve).toContain(`SHADOW_AGENT:${REGISTERED}`);
    });

    it('an agent absent from the scan is untouched by its intake row', () => {
        const body = validReportBody();
        body.agents = [body.agents[0]];
        const plan = planHarnessScan(body, withIntake(SHADOW));
        expect(plan.agents.map((a) => a.discoveredId)).toEqual([REGISTERED]);
        expect([...plan.resolve, ...refs(plan.assert)].some((r) => r.includes('shadow-1'))).toBe(false);
    });

    it('keys intake rows by discovered id, and drops a row naming a discovered agent the scan did not load', () => {
        const known = [
            { id: 'da_1', discoveredId: SHADOW },
            { id: 'da_2', discoveredId: REGISTERED },
        ];
        const claims = intakeClaimsByDiscoveredId(known, [
            { id: 'agt_a', status: 'DRAFT', deletedAt: null, intakeDiscoveredAgentId: 'da_1' },
            { id: 'agt_b', status: 'RETIRED', deletedAt: new Date(), intakeDiscoveredAgentId: 'da_2' },
            // Another tenant's discovered agent, or one this scan does not report.
            { id: 'agt_c', status: 'ACTIVE', deletedAt: null, intakeDiscoveredAgentId: 'da_other_tenant' },
            { id: 'agt_d', status: 'ACTIVE', deletedAt: null, intakeDiscoveredAgentId: null },
        ]);
        expect([...claims.entries()]).toEqual([
            [SHADOW, { registeredAgentId: 'agt_a', status: 'DRAFT', deleted: false }],
            [REGISTERED, { registeredAgentId: 'agt_b', status: 'RETIRED', deleted: true }],
        ]);
    });
});

describe('a secret-shaped value anywhere is found, and named by path', () => {
    // Built at runtime so no literal credential pattern sits in this file.
    const secret = () => ['gh', 'p_', 'Q'.repeat(36)].join('');

    it('a valid report carries none', () => {
        expect(firstSecretShapedMember(validReportBody())).toBeNull();
    });

    it('finds one in a member the contract does not check, and names the path, not the value', () => {
        const body = validReportBody();
        body.agents[1].tools[0].name = secret();
        const at = firstSecretShapedMember(body);
        expect(at).toBe('agents[1].tools[0].name');
        expect(at).not.toContain(secret());
    });

    it('reaches every depth: an evidence pointer and a source reason', () => {
        const a = validReportBody();
        a.agents[0].verdicts[0] = { ...a.agents[0].verdicts[0], evidence: `kv://x/${secret()}` };
        expect(firstSecretShapedMember(a)).toBe('agents[0].verdicts[0].evidence');
        const b = validReportBody();
        b.scan.scanner.version = secret();
        expect(firstSecretShapedMember(b)).toBe('scan.scanner.version');
    });
});

describe('the shortfall finding is described one way', () => {
    it('names the level, the bar and that it never blocks the agent', () => {
        const f = shortfallFinding('entra:sp:x', 'H1', 'WRITE_OR_EXTERNAL', 'The latest harness scan');
        expect(f.sourceRef).toBe('HARNESS_SHORTFALL:entra:sp:x');
        expect(f.title).toBe('Agent entra:sp:x is below the harness bar (H1, bar H3)');
        expect(f.description).toMatch(/never blocks the agent/);
    });
});
