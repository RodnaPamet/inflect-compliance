/**
 * The Tools tab's account of the runtime's `task` tool must describe the
 * delegation that ships (#5304).
 *
 * It said no subagent was declared and delegation was unreachable, while
 * `flue/agent.ts` declared every entry of `SPECIALISTS` and delegation was
 * live. Tying the sentence to the declared list makes the next specialist
 * added or removed fail here until the disclosure says so.
 */
import { FLUE_RUNTIME_TOOLS } from '@/lib/agentic/flue/runtime-tools';
import { SPECIALIST_NAMES } from '@/lib/agentic/flue/subagents';

const task = FLUE_RUNTIME_TOOLS.find((t) => t.name === 'task');

describe('the runtime `task` disclosure', () => {
    it('exists and is present on every run', () => {
        expect(task?.appearsWhen).toBe('always');
    });

    it('names every declared specialist, and states how many there are', () => {
        for (const name of SPECIALIST_NAMES) expect(task?.boundedBy).toContain(name);
        expect(SPECIALIST_NAMES).toHaveLength(4);
        expect(task?.boundedBy).toContain('one of four declared specialists');
    });

    it('does not say delegation is unreachable', () => {
        expect(task?.boundedBy).not.toContain('No subagent is declared');
        expect(task?.boundedBy).toContain('Delegation is live');
    });
});
