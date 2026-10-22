/**
 * `H3.egress_enforced` end to end at the product's layers (#3950, #3952).
 *
 * ═══ WHY THERE IS NO NEW READ TOOL HERE ═══
 *
 * The OpenShell roadmap's phase 2.2 asks for "one read tool returning an agent's
 * sandbox evidence: the verdicts and pointers INGESTED from the scanner report".
 * That tool already exists. `get_discovered_agent` returns
 * `observations: readonly CriterionVerdict[]` — "per-criterion observations, AS
 * REPORTED — not judged" — plus the scan's completeness and sources, and no
 * level. A verdict is `{ criterion, met, evidence }`, so a sandbox's evidence
 * crosses as the evidence pointer on each verdict, which is exactly the shape
 * phase 1.2 says the scanner must report ("pointers, not content").
 *
 * A fifteenth read tool over the same rows would buy a narrower grant and cost
 * two payloads that must not drift. Owner decision: verify the existing path
 * rather than duplicate it. So this suite asserts the PROPERTIES 2.2 wanted,
 * against the tool that already carries them.
 *
 * ═══ WHAT EACH ASSERTION IS FOR ═══
 *
 * The scoring cases are the ones with teeth. Adding a criterion to a rung lowers
 * the level of every agent that has not evidenced it, and the ladder file says
 * that is intended — so the tests that matter are the ones proving the drop
 * happens, and happens only to the rung that gained the criterion.
 */
import {
    ALL_HARNESS_CRITERIA,
    HARNESS_CRITERIA,
    isHarnessCriterionId,
    levelAtLeast,
    rungOf,
    scoreHarness,
    type CriterionVerdict,
    type HarnessCriterionId,
} from '@/lib/agentic/harness-ladder';
import { READ_TOOLS } from '@/lib/mcp/tools/registry';

/** Every criterion up to and including a rung, each evidenced. */
function evidencedThrough(rung: 'H1' | 'H2' | 'H3'): CriterionVerdict[] {
    const rungs: readonly ('H1' | 'H2' | 'H3')[] =
        rung === 'H1' ? ['H1'] : rung === 'H2' ? ['H1', 'H2'] : ['H1', 'H2', 'H3'];
    return rungs.flatMap((r) =>
        (HARNESS_CRITERIA[r] as readonly HarnessCriterionId[]).map((criterion) => ({
            criterion,
            met: true,
            evidence: `ref://${criterion}`,
        })),
    );
}

describe('the criterion exists on the rung it was authored for', () => {
    it('is a criterion the ladder defines', () => {
        // The ingest verifier refuses a verdict whose criterion fails exactly
        // this check, with "not a criterion the harness ladder defines" — which
        // is why a scanner emitting it before the ingest ships loses its WHOLE
        // report, not just the verdict.
        expect(isHarnessCriterionId('H3.egress_enforced')).toBe(true);
        expect(ALL_HARNESS_CRITERIA).toContain('H3.egress_enforced');
    });

    it('sits on H3, not on a rung an agent could reach without it', () => {
        expect(HARNESS_CRITERIA.H3).toContain('H3.egress_enforced');
        for (const rung of ['H1', 'H2', 'H4', 'H5'] as const) {
            expect(HARNESS_CRITERIA[rung]).not.toContain('H3.egress_enforced');
        }
    });
});

describe('what the new criterion does to a level', () => {
    it('an agent evidencing all of H3 EXCEPT egress drops to H2', () => {
        const verdicts = evidencedThrough('H3').filter(
            (v) => v.criterion !== 'H3.egress_enforced',
        );
        const score = scoreHarness(verdicts);
        expect(score.level).toBe('H2');
        expect(score.blockingNextRung).toEqual(['H3.egress_enforced']);
    });

    it('the same agent WITH the evidence keeps H3', () => {
        expect(scoreHarness(evidencedThrough('H3')).level).toBe('H3');
    });

    it("an H2 agent keeps its LEVEL, and gains one entry in what blocks the next rung", () => {
        /*
            THE ROADMAP SAYS "agents at H1 and H2 are unaffected". That is true
            of their LEVEL and not of everything they report, and the first
            version of this test asserted the stronger claim and failed.

            `blockingNextRung` is what stands between an agent and the rung
            above, so an H2 agent's gap to H3 legitimately grows by the new
            criterion. That is correct behaviour rather than a regression — but
            it IS visible, because findings name blocking criteria. So the
            honest statement of the blast radius is: no agent changes level
            without the evidence it already lacked, and every H2 agent's stated
            gap to H3 gets one item longer.
        */
        const before = scoreHarness(evidencedThrough('H2'));
        expect(before.level).toBe('H2');
        expect(before.blockingNextRung).toContain('H3.egress_enforced');
        // The whole H3 rung is what blocks it, which is what being at H2 means.
        expect([...before.blockingNextRung].sort()).toEqual(
            [...(HARNESS_CRITERIA.H3 as readonly string[])].sort(),
        );
    });

    it('an H1 agent is not told about an H3 criterion at all', () => {
        // The rung-by-rung property: `blockingNextRung` names the NEXT rung's
        // unmet criteria, not every unmet criterion above. An H1 agent's gap is
        // H2's list, so the new criterion must not appear there.
        const h1 = scoreHarness(evidencedThrough('H1'));
        expect(h1.level).toBe('H1');
        expect(h1.blockingNextRung).not.toContain('H3.egress_enforced');
    });

    it('a verdict present but NOT met is not evidence', () => {
        // Audit mode is the case this protects: a policy that logs and forwards
        // produces a reported verdict whose `met` is false, and a scorer that
        // counted the verdict's PRESENCE rather than its value would raise the
        // level on a policy that enforces nothing.
        const verdicts = evidencedThrough('H3').map((v) =>
            v.criterion === 'H3.egress_enforced' ? { ...v, met: false } : v,
        );
        expect(scoreHarness(verdicts).level).toBe('H2');
    });

    it('a met verdict whose evidence is null is not evidence either', () => {
        // `evidence` is `string | null` — required but nullable — and the ladder
        // spells the consequence out: "A `met` with no evidence counts as not
        // met". `criterionState` returns MET_UNEVIDENCED, which is not
        // EVIDENCED, so the rung is not reached. This is the shape a scanner
        // produces when it believes a criterion holds and cannot say where it
        // saw that.
        const verdicts = evidencedThrough('H3').map((v) =>
            v.criterion === 'H3.egress_enforced'
                ? { criterion: v.criterion, met: true, evidence: null }
                : v,
        );
        expect(scoreHarness(verdicts).level).toBe('H2');
    });

    it('comparison stays ordinal', () => {
        // The ladder's rule: nothing compares two levels by any route but
        // `rungOf` / `levelAtLeast`. A drop from H3 to H2 must read as a drop.
        expect(rungOf('H2')).toBeLessThan(rungOf('H3'));
        expect(levelAtLeast('H2', 'H3')).toBe(false);
        expect(levelAtLeast('H3', 'H3')).toBe(true);
    });
});

describe('the evidence reaches a model only through the read funnel', () => {
    it('get_discovered_agent is registered, and carries the per-criterion observations', () => {
        // Driven from the REGISTRY, never a hand-written count: the read-tool
        // list has already grown from nine to twelve to fourteen, and a test
        // pinning a number would have to be edited by whoever grows it next —
        // which is how a count stops meaning anything.
        const names = READ_TOOLS.map((t) => t.name);
        expect(names).toContain('get_discovered_agent');
        expect(names.length).toBeGreaterThanOrEqual(14);
    });

    it('every read tool names a resource scope — none is reachable unscoped', () => {
        /*
            `authorize.keys` is OPTIONAL on `McpToolAuthorization`, so asserting
            every tool carries one overreached and the compiler said so. Some
            tools express their authorization by a different member of that
            block, and inventing a rule the type does not hold would make this a
            guard against the shape rather than against the risk.

            `resourceScope` IS required, and it is what `runReadTool` enforces,
            so that is the property worth asserting across the whole registry.
            The key for the tool this phase relies on is asserted by name below.
        */
        for (const tool of READ_TOOLS) {
            expect(tool.resourceScope.resource.length).toBeGreaterThan(0);
            expect(tool.resourceScope.action.length).toBeGreaterThan(0);
        }
    });

    it('the tool that carries sandbox evidence is gated on the agent-registry read', () => {
        const tool = READ_TOOLS.find((t) => t.name === 'get_discovered_agent');
        expect(tool).toBeDefined();
        expect(tool!.authorize.keys ?? []).toContain('admin.agent_registry_view');
        // `mirrors` names the human read admitting the same key, so the tool and
        // the page cannot drift into different answers about who may look.
        expect(tool!.authorize.mirrors).toContain('harness-scans');
    });

    it('no read tool advertises a write', () => {
        // The funnel's own invariant, asserted from the registry so a tool added
        // later inherits it: a read tool whose name says it mutates would reach
        // a model through `runReadTool`, which never writes.
        for (const tool of READ_TOOLS) {
            expect(tool.name).not.toMatch(/^(create|update|delete|set|propose)_/);
        }
    });
});
