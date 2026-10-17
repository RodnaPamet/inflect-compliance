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
    isHarnessShortfall,
    planHarnessScan,
    reachOf,
    shortfallFinding,
    type PriorHarnessState,
} from '@/lib/agentic/harness-findings';
import type { HarnessReportBody } from '@/lib/agentic/harness-contract';
import type { HarnessLevel } from '@/lib/agentic/harness-ladder';

function prior(over: Partial<PriorHarnessState> = {}): PriorHarnessState {
    return {
        previousLevels: new Map<string, HarnessLevel>(),
        registeredAgentIds: new Set(['agt_registered_1']),
        acceptedShortfalls: new Set<string>(),
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

describe('the shortfall finding is described one way', () => {
    it('names the level, the bar and that it never blocks the agent', () => {
        const f = shortfallFinding('entra:sp:x', 'H1', 'WRITE_OR_EXTERNAL', 'The latest harness scan');
        expect(f.sourceRef).toBe('HARNESS_SHORTFALL:entra:sp:x');
        expect(f.title).toBe('Agent entra:sp:x is below the harness bar (H1, bar H3)');
        expect(f.description).toMatch(/never blocks the agent/);
    });
});
