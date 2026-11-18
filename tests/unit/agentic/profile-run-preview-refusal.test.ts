/**
 * The flow editor's preview names a version every engine refuses (#5764).
 *
 * The Tool Runner runs sub-agents (Step 2e) and deferred tools (Step 2f), so
 * neither refuses a version on every engine, and the preview's sub-agent and
 * deferral refusals, worded "no engine in this build runs them", were dead
 * text. They are gone. Should either brake be pulled, admission still refuses
 * by name and the preview says the general, then true, "no engine runs this
 * version": never a code the editor has no sentence for.
 */
const brakes = { subagents: false, deferrals: false };

jest.mock('@/lib/agentic/agent-profile', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-profile');
    return {
        ...actual,
        runsSubagents: (driver: string) => (brakes.subagents ? false : actual.runsSubagents(driver)),
        runsDeferrals: (driver: string) => (brakes.deferrals ? false : actual.runsDeferrals(driver)),
    };
});

import { refusedOnEveryEngine } from '@/app-layer/usecases/agent-profile-runs';
import type { ProfileRunSpec } from '@/lib/agentic/workflow-types';

const en = jest.requireActual('../../../messages/en.json') as { agentFlow: { compiled: { refused: Record<string, string> } } };
const bg = jest.requireActual('../../../messages/bg.json') as { agentFlow: { compiled: { refused: Record<string, string> } } };

function spec(over: Partial<ProfileRunSpec> = {}): ProfileRunSpec {
    return {
        profileId: 'p1',
        agentId: 'a1',
        versionId: 'v1',
        version: 1,
        instructions: 'Read the risks.',
        instructionsHash: 'h',
        toolNames: ['list_risks', 'propose_risks'],
        skillRefs: [],
        modelTier: 'BALANCED',
        effort: 'MEDIUM',
        maxTurns: 8,
        outputKind: 'SUMMARY',
        allowedTriggers: ['MANUAL'],
        ...over,
    } as ProfileRunSpec;
}

const withSubagents = spec({
    subagents: [{ name: 'reader', instructions: 'Read.', toolNames: ['list_risks'], skillRefs: [], maxTurns: 3 }] as unknown as ProfileRunSpec['subagents'],
});
const withDeferrals = spec({ deferredToolNames: ['propose_risks'] });

afterEach(() => {
    brakes.subagents = false;
    brakes.deferrals = false;
});

describe('refusedOnEveryEngine', () => {
    it('refuses neither a version with sub-agents nor one with deferred tools: the Tool Runner runs both', () => {
        expect(refusedOnEveryEngine(withSubagents)).toBeNull();
        expect(refusedOnEveryEngine(withDeferrals)).toBeNull();
    });

    it('with a brake pulled, answers the general refusal, never a sub-agent or deferral code', () => {
        brakes.subagents = true;
        expect(refusedOnEveryEngine(withSubagents)).toBe('PROFILE_ENGINE_CANNOT_RUN_PROFILES');
        brakes.subagents = false;
        brakes.deferrals = true;
        expect(refusedOnEveryEngine(withDeferrals)).toBe('PROFILE_ENGINE_CANNOT_RUN_PROFILES');
    });

    it('every refusal it can answer has a sentence in the flow editor, in both languages', () => {
        brakes.subagents = true;
        brakes.deferrals = true;
        const answers = [withSubagents, withDeferrals].map(refusedOnEveryEngine);
        for (const code of answers) {
            expect(code).not.toBeNull();
            expect(typeof en.agentFlow.compiled.refused[code as string]).toBe('string');
            expect(typeof bg.agentFlow.compiled.refused[code as string]).toBe('string');
        }
    });
});
