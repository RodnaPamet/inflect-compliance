/**
 * What one verified harness report means (#3665): the pure planner.
 *
 * The ingest executes this plan, so the rules are proved here: the level is
 * derived and never read; the register, not the report, decides SHADOW; each
 * finding opens on the condition it names; and a scan closes a finding only on
 * positive evidence.
 */
import {
    UNBOUND_VAULT_REF,
    validIncompleteReportBody,
    validReportBody,
    validV2CompleteReportBody,
    validV2ReportBody,
} from '../../helpers/agent-harness-fake-scanner';
import {
    IDENTITY_BEARING_SOURCE,
    firstSecretShapedMember,
    intakeClaimsByDiscoveredId,
    isHarnessShortfall,
    isIdentityBearingSource,
    isIntakeClaimLinkable,
    orphanCredentialRefOf,
    planHarnessScan,
    reachOf,
    shortfallFinding,
    toolEvidenceSource,
    toolEvidenceSourcesOf,
    type IntakeClaim,
    type PriorHarnessState,
} from '@/lib/agentic/harness-findings';
import { SOURCE_KINDS, type HarnessReportBody, type HarnessReportBodyV2 } from '@/lib/agentic/harness-contract';
import type { HarnessLevel } from '@/lib/agentic/harness-ladder';

function prior(over: Partial<PriorHarnessState> = {}): PriorHarnessState {
    return {
        previousLevels: new Map<string, HarnessLevel>(),
        registeredAgentIds: new Set(['agt_registered_1']),
        acceptedShortfalls: new Set<string>(),
        intakeClaims: new Map<string, IntakeClaim>(),
        openOrphanCredentials: new Set<string>(),
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

describe('model endpoints are carried as reported, and absence stays absence (#3759)', () => {
    it('an agent\'s models are planned as reported, and an agent reported without them plans null', () => {
        const v2 = Object.fromEntries(planHarnessScan(validV2ReportBody(), prior()).agents.map((a) => [a.discoveredId, a]));
        expect(v2['entra:sp:registered-1'].models).toEqual(validV2ReportBody().agents[0].models);
        expect(v2['entra:sp:shadow-1'].models).toBeNull();
        for (const a of planHarnessScan(validReportBody(), prior()).agents) expect(a.models).toBeNull();
    });

    it('reported empty is planned as [], not as null', () => {
        const body = validV2ReportBody();
        body.agents[0].models = [];
        expect(planHarnessScan(body, prior()).agents[0].models).toEqual([]);
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

describe('"no unpinned write tool" is judged by the read that would have seen the tool (#3754, owner answer 2026-10-19)', () => {
    type Agent = HarnessReportBodyV2['agents'][number];
    type Tool = Agent['tools'][number];
    type Status = 'COMPLETE' | 'INCOMPLETE' | 'ABSENT';
    const HASH = `sha256:${'c'.repeat(64)}`;
    /** A tool the agent defines in its own code. Declared read-only, so not a write. */
    const codeTool: Tool = { server: 'code://app/agents/support.py#L12', name: 'lookup_order', manifestHash: null, pinned: false, readOnlyHint: true };
    /** A tool an MCP server serves. A write, but pinned. */
    const mcpTool: Tool = { server: 'https://mcp.internal.example/crm', name: 'update_opportunity', manifestHash: HASH, pinned: true, readOnlyHint: false };
    const agent = (discoveredVia: Agent['discoveredVia'], tools: Tool[]): Agent => ({
        discoveredId: 'code:app/agents/support.py#agent',
        discoveredVia,
        registeredAgentId: null,
        owner: null,
        credentials: [],
        tools,
        skills: [],
        verdicts: [],
    });
    const REF = 'UNPINNED_WRITE_TOOL:code:app/agents/support.py#agent';
    /** A complete `/2` body reporting only `a`, with the code and mcp sources as given. */
    const scan = (a: Agent, sources: { code: Status; mcp: Status }): HarnessReportBodyV2 => {
        const body = validV2CompleteReportBody();
        body.agents = [a];
        body.unboundCredentials = [];
        body.population.sources = body.population.sources.filter((s) => s.kind !== 'code' && s.kind !== 'mcp');
        for (const kind of ['code', 'mcp'] as const) {
            const status = sources[kind];
            if (status === 'COMPLETE') body.population.sources.push({ kind, status, rows: 3 });
            if (status === 'INCOMPLETE') body.population.sources.push({ kind, status, reason: 'TIME_BOX', rows: 1 });
        }
        return body;
    };
    const closes = (a: Agent, sources: { code: Status; mcp: Status }) => {
        const plan = planHarnessScan(scan(a, sources), prior());
        expect(refs(plan.assert)).not.toContain(REF);
        return plan.resolve.includes(REF);
    };

    it('a tool is judged by its server: a code:// locator by the code source, anything else by mcp', () => {
        expect(toolEvidenceSource(codeTool)).toBe('code');
        expect(toolEvidenceSource({ server: 'code://app/mcp.json#L4' })).toBe('code');
        expect(toolEvidenceSource(mcpTool)).toBe('mcp');
        expect(toolEvidenceSource({ server: 'langsmith://api.smith.langchain.com/projects/p1' })).toBe('mcp');
        // A tool left out is judged where it would have been.
        expect([...toolEvidenceSourcesOf(agent(['code'], []))]).toEqual(['code']);
        expect([...toolEvidenceSourcesOf(agent(['entra-sp', 'vault'], []))]).toEqual(['mcp']);
        expect([...toolEvidenceSourcesOf(agent(['code'], [codeTool, mcpTool]))].sort()).toEqual(['code', 'mcp']);
    });

    it('a code-defined agent\'s tools close on a complete code read, with no mcp source at all', () => {
        expect(closes(agent(['code'], [codeTool]), { code: 'COMPLETE', mcp: 'ABSENT' })).toBe(true);
        // …and with no tools left in its definition.
        expect(closes(agent(['code'], []), { code: 'COMPLETE', mcp: 'ABSENT' })).toBe(true);
    });

    it('a code-defined tool is not closed when code is INCOMPLETE, even with mcp read in full', () => {
        expect(closes(agent(['code'], [codeTool]), { code: 'INCOMPLETE', mcp: 'COMPLETE' })).toBe(false);
        expect(closes(agent(['code'], [codeTool]), { code: 'ABSENT', mcp: 'COMPLETE' })).toBe(false);
        expect(closes(agent(['code'], []), { code: 'INCOMPLETE', mcp: 'COMPLETE' })).toBe(false);
    });

    it('an MCP-served tool is NOT closed by a complete code read', () => {
        // On a code-defined agent: the code read sees the reference, not the server's tools.
        expect(closes(agent(['code'], [mcpTool]), { code: 'COMPLETE', mcp: 'ABSENT' })).toBe(false);
        expect(closes(agent(['code'], [mcpTool]), { code: 'COMPLETE', mcp: 'INCOMPLETE' })).toBe(false);
        // On any other agent, whose left-out tools would be on an MCP server.
        expect(closes(agent(['entra-sp'], [mcpTool]), { code: 'COMPLETE', mcp: 'INCOMPLETE' })).toBe(false);
        expect(closes(agent(['entra-sp'], []), { code: 'COMPLETE', mcp: 'ABSENT' })).toBe(false);
        // The pair proves the branch: the same reports with mcp read in full close.
        expect(closes(agent(['code'], [mcpTool]), { code: 'COMPLETE', mcp: 'COMPLETE' })).toBe(true);
        expect(closes(agent(['entra-sp'], [mcpTool]), { code: 'ABSENT', mcp: 'COMPLETE' })).toBe(true);
    });

    it('an agent with both kinds of tool closes only when both sources were read in full', () => {
        const both = agent(['code'], [codeTool, mcpTool]);
        expect(closes(both, { code: 'COMPLETE', mcp: 'INCOMPLETE' })).toBe(false);
        expect(closes(both, { code: 'INCOMPLETE', mcp: 'COMPLETE' })).toBe(false);
        expect(closes(both, { code: 'COMPLETE', mcp: 'COMPLETE' })).toBe(true);
    });

    it('an unpinned write tool still opens the finding, whatever was read', () => {
        const unpinned = agent(['code'], [{ ...codeTool, readOnlyHint: null }]);
        const plan = planHarnessScan(scan(unpinned, { code: 'COMPLETE', mcp: 'COMPLETE' }), prior());
        expect(refs(plan.assert)).toContain(REF);
        expect(plan.resolve).not.toContain(REF);
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

describe('ORPHAN_CREDENTIAL is derived from unboundCredentials[], on positive evidence only (#3754)', () => {
    const SCANNER = 'agt_scanner';
    const VAULT_ORPHAN = orphanCredentialRefOf(SCANNER, 'vault', UNBOUND_VAULT_REF);
    const orphans = (plan: ReturnType<typeof planHarnessScan>) =>
        plan.assert.filter((f) => f.code === 'ORPHAN_CREDENTIAL').map((f) => f.sourceRef);
    const resolvedOrphans = (plan: ReturnType<typeof planHarnessScan>) => plan.resolve.filter((r) => r.startsWith('ORPHAN_CREDENTIAL:'));
    const withOpen = (...refs: string[]) => prior({ openOrphanCredentials: new Set(refs) });
    /**
     * The `/2` body with every other source read in full and the vault's
     * status replaced, or the vault removed.
     */
    const vault = (status: 'COMPLETE' | 'INCOMPLETE' | 'ABSENT', unbound = true): HarnessReportBodyV2 => {
        const body = validV2CompleteReportBody();
        if (status === 'ABSENT') {
            body.population.sources = body.population.sources.filter((s) => s.kind !== 'vault');
            body.agents.forEach((a) => (a.discoveredVia = a.discoveredVia.filter((k) => k !== 'vault')));
            body.unboundCredentials = [];
            return body;
        }
        if (status === 'INCOMPLETE') {
            body.population.sources = body.population.sources.map((s) =>
                s.kind === 'vault' ? { kind: 'vault', status: 'INCOMPLETE', reason: 'TIME_BOX', rows: 12 } : s,
            );
        }
        if (!unbound) body.unboundCredentials = [];
        return body;
    };

    it('opens for a credential its source, read in full, saw bound to no agent — keyed by scanner, source and reference', () => {
        const plan = planHarnessScan(vault('COMPLETE'), prior());
        expect(orphans(plan)).toEqual([`ORPHAN_CREDENTIAL:${SCANNER}:vault:${UNBOUND_VAULT_REF}`]);
        expect(plan.assert.find((f) => f.code === 'ORPHAN_CREDENTIAL')).toMatchObject({
            severity: 'MEDIUM',
            type: 'OBSERVATION',
            title: `Credential ${UNBOUND_VAULT_REF} is bound to no agent`,
        });
    });

    it('does not open when the source that saw it stopped early', () => {
        const plan = planHarnessScan(vault('INCOMPLETE'), prior());
        expect(orphans(plan)).toEqual([]);
        // The source's own incompleteness is still a finding.
        expect(plan.assert.map((f) => f.sourceRef)).toContain(`INCOMPLETE_SOURCE:${SCANNER}:vault`);
    });

    it('closes only when the same source, read in full, no longer sees it unbound', () => {
        const fixed = planHarnessScan(vault('COMPLETE', false), withOpen(VAULT_ORPHAN));
        expect(resolvedOrphans(fixed)).toEqual([VAULT_ORPHAN]);
        // Still unbound: asserted again, never resolved.
        const still = planHarnessScan(vault('COMPLETE'), withOpen(VAULT_ORPHAN));
        expect(orphans(still)).toEqual([VAULT_ORPHAN]);
        expect(resolvedOrphans(still)).toEqual([]);
    });

    it('an absent source closes nothing, and neither does an incomplete one', () => {
        expect(resolvedOrphans(planHarnessScan(vault('ABSENT'), withOpen(VAULT_ORPHAN)))).toEqual([]);
        expect(resolvedOrphans(planHarnessScan(vault('INCOMPLETE', false), withOpen(VAULT_ORPHAN)))).toEqual([]);
        // The pair proves the branch: the same scan with the vault read in full closes it.
        expect(resolvedOrphans(planHarnessScan(vault('COMPLETE', false), withOpen(VAULT_ORPHAN)))).toEqual([VAULT_ORPHAN]);
    });

    it('the report\'s own ORPHAN_CREDENTIAL finding is not acted on', () => {
        const body = validReportBody();
        body.findings = [{ code: 'ORPHAN_CREDENTIAL', discoveredId: null, severity: 'CRITICAL', evidence: 'kv://prod/agents/x' }];
        expect(orphans(planHarnessScan(body, prior()))).toEqual([]);
        const v2 = vault('COMPLETE', false);
        v2.findings = body.findings;
        expect(orphans(planHarnessScan(v2, prior()))).toEqual([]);
    });

    it('another scanner\'s open finding is never this scanner\'s to close, even for the same source and reference', () => {
        const theirs = orphanCredentialRefOf('agt_other_scanner', 'vault', UNBOUND_VAULT_REF);
        expect(resolvedOrphans(planHarnessScan(vault('COMPLETE', false), withOpen(theirs)))).toEqual([]);
    });

    it('one source read in full closes only its own kind\'s findings', () => {
        const codeOrphan = orphanCredentialRefOf(SCANNER, 'code', 'env://OPENAI_API_KEY');
        // The code source is INCOMPLETE (UNPARSEABLE) in the /2 fixture.
        const body = validV2ReportBody();
        body.unboundCredentials = [];
        const plan = planHarnessScan(body, withOpen(VAULT_ORPHAN, codeOrphan));
        expect(resolvedOrphans(plan)).toEqual([VAULT_ORPHAN]);
    });

    it('a reference that holds colons is keyed and closed whole', () => {
        const ref = 'azure-kv://acme.vault.azure.net/secrets/a:b:c';
        const body = vault('COMPLETE', false);
        body.unboundCredentials = [{ ref, sourceKind: 'vault' }];
        expect(orphans(planHarnessScan(body, prior()))).toEqual([orphanCredentialRefOf(SCANNER, 'vault', ref)]);
        expect(resolvedOrphans(planHarnessScan(vault('COMPLETE', false), withOpen(orphanCredentialRefOf(SCANNER, 'vault', ref))))).toEqual([
            orphanCredentialRefOf(SCANNER, 'vault', ref),
        ]);
    });

    describe('opening also needs every identity-bearing source in the scan read in full (owner answer, 2026-10-19)', () => {
        /** The complete body with one more source, or one of its own, stopped early. */
        const withIncomplete = (kind: (typeof SOURCE_KINDS)[number]): HarnessReportBodyV2 => {
            const body = vault('COMPLETE');
            const stopped = { kind, status: 'INCOMPLETE' as const, reason: 'TIME_BOX' as const, rows: 1 };
            body.population.sources = body.population.sources.some((s) => s.kind === kind)
                ? body.population.sources.map((s) => (s.kind === kind ? stopped : s))
                : [...body.population.sources, stopped];
            return body;
        };

        it('an incomplete identity source holds it back though the credential\'s own source was read in full; with both read it opens', () => {
            // The fixture: the vault read in full lists the credential, the code source stopped early.
            const held = validV2ReportBody();
            expect(held.population.sources.find((s) => s.kind === 'vault')?.status).toBe('COMPLETE');
            expect(held.population.sources.find((s) => s.kind === 'code')?.status).toBe('INCOMPLETE');
            expect(held.unboundCredentials).toEqual([{ ref: UNBOUND_VAULT_REF, sourceKind: 'vault' }]);
            const plan = planHarnessScan(held, prior());
            expect(orphans(plan)).toEqual([]);
            expect(refs(plan.assert)).toContain(`INCOMPLETE_SOURCE:${SCANNER}:code`);
            // The same report with code read in full opens it.
            expect(orphans(planHarnessScan(validV2CompleteReportBody(), prior()))).toEqual([VAULT_ORPHAN]);
        });

        it('every identity-bearing kind holds it back when stopped early; mcp does not', () => {
            for (const kind of SOURCE_KINDS) {
                if (kind === 'vault') continue;
                const expected = IDENTITY_BEARING_SOURCE[kind] ? [] : [VAULT_ORPHAN];
                expect({ kind, orphans: orphans(planHarnessScan(withIncomplete(kind), prior())) }).toEqual({ kind, orphans: expected });
            }
        });

        it('an identity-bearing kind the scan does not list holds nothing back', () => {
            const body = vault('COMPLETE');
            const listed = body.population.sources.map((s) => s.kind);
            for (const kind of ['okta-app', 'runtime', 'cicd'] as const) expect(listed).not.toContain(kind);
            expect(orphans(planHarnessScan(body, prior()))).toEqual([VAULT_ORPHAN]);
        });

        it('a credential the source still lists is neither reopened nor closed while an identity source is incomplete', () => {
            const plan = planHarnessScan(validV2ReportBody(), withOpen(VAULT_ORPHAN));
            expect(orphans(plan)).toEqual([]);
            expect(resolvedOrphans(plan)).toEqual([]);
        });

        it('closing is unchanged: the source read in full that no longer lists it closes it, whatever else stopped early', () => {
            const body = validV2ReportBody();
            body.unboundCredentials = [];
            expect(resolvedOrphans(planHarnessScan(body, withOpen(VAULT_ORPHAN)))).toEqual([VAULT_ORPHAN]);
        });

        it('the classification covers every source kind, and only mcp is not identity-bearing', () => {
            expect(Object.keys(IDENTITY_BEARING_SOURCE).sort()).toEqual([...SOURCE_KINDS].sort());
            expect(Object.entries(IDENTITY_BEARING_SOURCE).filter(([, bearing]) => !bearing).map(([kind]) => kind)).toEqual(['mcp']);
            expect(isIdentityBearingSource('mcp')).toBe(false);
            expect(isIdentityBearingSource('entra-sp')).toBe(true);
            // A kind the table does not name is treated as identity-bearing: the side that opens nothing.
            expect(isIdentityBearingSource('a-kind-added-later')).toBe(true);
            expect(isIdentityBearingSource('constructor')).toBe(true);
        });
    });
});
