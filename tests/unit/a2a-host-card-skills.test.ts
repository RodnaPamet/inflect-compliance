/**
 * WHAT THE HOST-CONSUMER CARD ADVERTISES, at the source (#3862).
 *
 * `advertisedA2aSkills` is the whole disclosure decision in one function, so
 * these assertions are about what it REFUSES to publish as much as what it
 * publishes: a workflow with no reviewed copy, a tool name, an id that no
 * caller could invoke.
 */
import { advertisedA2aSkills } from '@/lib/agentic/a2a/host-card-skills';
import { listWorkflowDefinitions, getWorkflowDefinition } from '@/lib/agentic/workflow-registry';

const skills = () => advertisedA2aSkills();

describe('the advertised set', () => {
    it('is not empty, or every assertion below passes vacuously', () => {
        expect(skills().length).toBeGreaterThan(0);
    });

    it('is a STRICT SUBSET of the registry — most workflows are not advertised', () => {
        // The denominator, printed by being asserted. If a later change made
        // every definition advertisable this would fail, which is the point:
        // the card growing silently is the risk.
        const all = listWorkflowDefinitions().length;
        expect(all).toBeGreaterThan(skills().length);
    });

    it('contains exactly the definitions carrying `a2aSkill`', () => {
        const expected = listWorkflowDefinitions()
            .filter((d) => d.a2aSkill)
            .map((d) => d.key)
            .sort();
        expect(skills().map((s) => s.id)).toEqual(expected);
    });

    it('omits every definition that carries no `a2aSkill`', () => {
        const silent = listWorkflowDefinitions().filter((d) => !d.a2aSkill).map((d) => d.key);
        expect(silent.length).toBeGreaterThan(0);
        const advertised = new Set(skills().map((s) => s.id));
        for (const key of silent) expect(advertised.has(key)).toBe(false);
    });

    it('is sorted by id, so the signed card’s bytes do not depend on registry order', () => {
        const ids = skills().map((s) => s.id);
        expect(ids).toEqual([...ids].sort());
    });

    it('is stable across calls', () => {
        expect(JSON.stringify(skills())).toBe(JSON.stringify(skills()));
    });
});

describe('every advertised skill is one a host can actually invoke', () => {
    it('uses the workflow key as the skill id', () => {
        // A host sends the id back as `workflowKey`. An id that is not a key is
        // an advertisement for something that cannot be called.
        for (const s of skills()) {
            expect(getWorkflowDefinition(s.id)).toBeDefined();
        }
    });

    it('needs no input the caller could not know', () => {
        // The criterion the advertised set was chosen on: a workflow whose
        // `requiredInput` is an internal Inflect id (an access-review id, a
        // discovered-agent id) would be refused at admission for every host
        // that tried it. Only `periodLabel` — a string the caller supplies —
        // is admissible here.
        const ALLOWED_INPUTS = new Set(['periodLabel']);
        for (const s of skills()) {
            const def = getWorkflowDefinition(s.id)!;
            for (const input of def.requiredInput ?? []) {
                expect(ALLOWED_INPUTS.has(input)).toBe(true);
            }
        }
    });

    it('is read-only — the public card offers nothing that proposes or changes', () => {
        for (const s of skills()) {
            const def = getWorkflowDefinition(s.id)!;
            expect(def.readOnly).toBe(true);
            expect(def.steps.some((step) => step.kind === 'PROPOSE')).toBe(false);
        }
    });
});

describe('R19 — the copy discloses nothing internal', () => {
    it('names no tool used by any workflow in the registry', () => {
        // Scanned against the REAL tool names, gathered from every definition,
        // not a hand-listed sample.
        const tools = new Set<string>();
        for (const def of listWorkflowDefinitions()) {
            for (const step of def.steps) {
                if ('tool' in step && typeof step.tool === 'string') tools.add(step.tool);
            }
        }
        expect(tools.size).toBeGreaterThan(0);
        const text = JSON.stringify(skills());
        for (const tool of tools) expect(text).not.toContain(tool);
    });

    it('carries no snake_case identifier at all, which is what a tool name looks like', () => {
        const text = JSON.stringify(skills());
        expect(text).not.toMatch(/[a-z]+_[a-z]+/);
    });

    it('supplies the A2A-required members on every skill', () => {
        for (const s of skills()) {
            expect(typeof s.id).toBe('string');
            expect(typeof s.name).toBe('string');
            expect(typeof s.description).toBe('string');
            expect(Array.isArray(s.tags)).toBe(true);
            expect(s.tags.length).toBeGreaterThan(0);
        }
    });
});
