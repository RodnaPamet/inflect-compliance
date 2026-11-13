/**
 * Inline sub-agents of a profile version, the parts with no database (Step 2e
 * of `docs/claude-tool-runner-design.md`, "Delegation → 1", #4594).
 *
 *   1. The subset rules are refusals by name, and the canonical form does not
 *      depend on the order the editor sent.
 *   2. A stored list is read back strictly: anything not canonical, not a
 *      subset, or not parseable is nothing, never "no sub-agents".
 *   3. The content hash: every existing form is byte for byte what it was,
 *      and changing one sub-agent's text changes the hash.
 *   4. Which engines run them: classified for every driver.
 */
jest.mock('@/env', () => ({ env: {} }));

import { createHash } from 'crypto';

import {
    PROFILE_MAX_SUBAGENTS,
    checkProfileSubagents,
    describeSubagentsForReview,
    parseStoredProfileSubagents,
    runsSubagents,
    serializeProfileSubagents,
    type ProfileSubagent,
} from '@/lib/agentic/agent-profile';
import { AGENT_DRIVERS } from '@/lib/agentic/agent-driver';
import { profileContentHash, profileInstructionsHash } from '@/app-layer/usecases/agent-profiles';
import { AgentProfileVersionSchema } from '@/app-layer/schemas/agent-profile.schemas';

const VERSION = {
    toolNames: ['list_controls', 'list_risks'],
    skillRefs: [{ origin: 'repository' as const, name: 'nhi-ownership-attribution' }],
    maxTurns: 8,
};
const LIMITS = { instructionsMaxChars: 16_000 };
const sub = (over: Partial<ProfileSubagent> = {}): ProfileSubagent => ({
    name: 'risk_reader',
    instructions: 'Read the risks.',
    toolNames: ['list_risks'],
    skillRefs: [],
    maxTurns: 4,
    ...over,
});

describe('1. the subset rules, by name', () => {
    const reasonOf = (list: ProfileSubagent[]) => {
        const r = checkProfileSubagents(list, VERSION, LIMITS);
        return r.ok ? 'OK' : r.reason;
    };

    it('refuses each rule with its own reason', () => {
        expect(reasonOf(Array.from({ length: PROFILE_MAX_SUBAGENTS + 1 }, (_, i) => sub({ name: `s${i}x` })))).toBe('SUBAGENTS_TOO_MANY');
        expect(reasonOf([sub({ name: 'x' })])).toBe('SUBAGENT_NAME_INVALID');
        expect(reasonOf([sub({ name: '9lives' })])).toBe('SUBAGENT_NAME_INVALID');
        expect(reasonOf([sub({ name: 'risk-reader' })])).toBe('SUBAGENT_NAME_INVALID');
        expect(reasonOf([sub({ name: `a${'b'.repeat(40)}` })])).toBe('SUBAGENT_NAME_INVALID');
        expect(reasonOf([sub(), sub()])).toBe('SUBAGENT_NAME_DUPLICATE');
        expect(reasonOf([sub({ instructions: '   ' })])).toBe('SUBAGENT_INSTRUCTIONS_EMPTY');
        expect(reasonOf([sub({ instructions: 'x'.repeat(16_001) })])).toBe('SUBAGENT_INSTRUCTIONS_TOO_LONG');
        expect(reasonOf([sub({ toolNames: [] })])).toBe('SUBAGENT_NAMES_NO_TOOL');
        expect(reasonOf([sub({ toolNames: ['list_findings'] })])).toBe('SUBAGENT_TOOL_NOT_IN_VERSION');
        expect(reasonOf([sub({ skillRefs: [{ origin: 'tenant', name: 'nhi-ownership-attribution' }] })])).toBe('SUBAGENT_SKILL_NOT_IN_VERSION');
        expect(reasonOf([sub({ maxTurns: 9 })])).toBe('SUBAGENT_MAX_TURNS_ABOVE_VERSION');
        expect(reasonOf([sub({ maxTurns: 0 })])).toBe('SUBAGENT_MAX_TURNS_ABOVE_VERSION');
        // The positive control: the cap itself, every rule satisfied.
        expect(reasonOf(Array.from({ length: PROFILE_MAX_SUBAGENTS }, (_, i) => sub({ name: `s${i}x` })))).toBe('OK');
    });

    it('is canonical: the same sub-agents in another order store the same string', () => {
        const a = sub({ name: 'b_reader', toolNames: ['list_risks', 'list_controls', 'list_risks'] });
        const b = sub({ name: 'a_reader' });
        const one = checkProfileSubagents([a, b], VERSION, LIMITS);
        const two = checkProfileSubagents([b, a], VERSION, LIMITS);
        if (!one.ok || !two.ok) throw new Error('expected ok');
        expect(serializeProfileSubagents(one.subagents)).toBe(serializeProfileSubagents(two.subagents));
        expect(one.subagents.map((s) => s.name)).toEqual(['a_reader', 'b_reader']);
        expect(one.subagents[1].toolNames).toEqual(['list_controls', 'list_risks']);
        expect(serializeProfileSubagents([])).toBeNull();
    });

    it('the request schema has no description field, and is strict', () => {
        const body = {
            instructions: 'x',
            toolNames: ['list_risks'],
            skillRefs: [],
            modelTier: 'balanced',
            effort: 'medium',
            maxTurns: 3,
            outputKind: 'ANSWER_ONLY',
            allowedTriggers: ['TEST_RUN'],
        };
        expect(AgentProfileVersionSchema.safeParse({ ...body, subagents: [sub()] }).success).toBe(true);
        expect(AgentProfileVersionSchema.safeParse({ ...body, subagents: [{ ...sub(), description: 'Reads risks.' }] }).success).toBe(false);
        const withFlow = AgentProfileVersionSchema.safeParse({
            ...body,
            toolNames: undefined,
            flow: { nodes: [], edges: [] },
            subagents: [sub()],
        });
        expect(withFlow.success).toBe(false);
        expect(JSON.stringify(withFlow.error?.issues)).toContain('SUBAGENTS_WITH_FLOW');
    });
});

describe('2. a stored list is read back strictly', () => {
    const stored = serializeProfileSubagents([sub()])!;

    it('reads back what was written', () => {
        expect(parseStoredProfileSubagents(stored, VERSION)).toEqual([sub()]);
    });

    it('refuses anything not canonical, not a subset, or unparseable, rather than reading it as none', () => {
        expect(parseStoredProfileSubagents('not json', VERSION)).toBeNull();
        expect(parseStoredProfileSubagents('[]', VERSION)).toBeNull();
        expect(parseStoredProfileSubagents(stored.replace('"maxTurns":4', '"maxTurns":4,"extra":1'), VERSION)).toBeNull();
        expect(parseStoredProfileSubagents(` ${stored}`, VERSION)).toBeNull();
        expect(parseStoredProfileSubagents(stored, { ...VERSION, toolNames: ['list_controls'] })).toBeNull();
        expect(parseStoredProfileSubagents(stored, { ...VERSION, maxTurns: 3 })).toBeNull();
    });

    it('renders every field and every word for the approver, in name order', () => {
        const text = describeSubagentsForReview([sub({ name: 'z_last' }), sub({ name: 'a_first', instructions: 'Line one.\nLine two.' })]);
        expect(text.indexOf('Sub-agent: a_first')).toBeLessThan(text.indexOf('Sub-agent: z_last'));
        expect(text).toContain('Line one.\nLine two.');
        expect(text).toContain('Tools: list_risks');
        expect(text).toContain('Turn limit: 4');
    });
});

describe('3. the content hash', () => {
    const INSTRUCTIONS = 'Summarise the open risks.';
    const FLOW = '{"nodes":[],"edges":[]}';

    it('every existing form is byte for byte what it was', () => {
        // No flow, no sub-agents: the bare text's hash.
        expect(profileContentHash(INSTRUCTIONS, null)).toBe(createHash('sha256').update(INSTRUCTIONS, 'utf8').digest('hex'));
        expect(profileContentHash(INSTRUCTIONS, null, null)).toBe(profileInstructionsHash(INSTRUCTIONS));
        // A flow, no sub-agents: domain 1, exactly as before Step 2e.
        const flowHash = createHash('sha256')
            .update(JSON.stringify(['inflect-agent-profile-content/1', INSTRUCTIONS, FLOW]), 'utf8')
            .digest('hex');
        expect(profileContentHash(INSTRUCTIONS, FLOW)).toBe(flowHash);
        expect(profileContentHash(INSTRUCTIONS, FLOW, null)).toBe(flowHash);
    });

    it('sub-agents take a second domain, and changing one sub-agent\'s text changes the hash', () => {
        const one = serializeProfileSubagents([sub()])!;
        const other = serializeProfileSubagents([sub({ instructions: 'Read the risks, briefly.' })])!;
        const h = profileContentHash(INSTRUCTIONS, null, one);
        expect(h).toBe(
            createHash('sha256')
                .update(JSON.stringify(['inflect-agent-profile-content/2', INSTRUCTIONS, null, one]), 'utf8')
                .digest('hex'),
        );
        expect(profileContentHash(INSTRUCTIONS, null, other)).not.toBe(h);
        expect(h).not.toBe(profileContentHash(INSTRUCTIONS, null));
    });
});

describe('4. which engines run sub-agents', () => {
    it('the Tool Runner runs them (Step 2e, its own commit)', () => {
        expect(runsSubagents('tool-runner')).toBe(true);
    });

    it('is classified for every driver, and Flue and the static engine run none', () => {
        expect(AGENT_DRIVERS.map((d) => [d, typeof runsSubagents(d)])).toEqual(AGENT_DRIVERS.map((d) => [d, 'boolean']));
        expect(runsSubagents('static')).toBe(false);
        expect(runsSubagents('flue')).toBe(false);
    });
});
