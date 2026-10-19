/**
 * The Register action's gate IS the intake's gate (#3712).
 *
 * `/agents/reports` shows the shadow list's Register action only when
 * `canRunRegistrationIntake(ctx)` is true, and the usecase's own assertion
 * calls the same predicate. This pins that the two cannot disagree, for every
 * built-in role: where the predicate says no, the usecase refuses 403 before
 * it reads the body; where it says yes, the usecase gets past the gate and
 * refuses the empty body on its schema instead.
 */
import { makeRequestContext } from '../helpers/make-context';
import { canRunRegistrationIntake, registerShadowAgent } from '@/app-layer/usecases/agent-registration-intake';

const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'] as const;

async function gateOutcome(role: (typeof ROLES)[number]): Promise<'FORBIDDEN' | 'PAST_THE_GATE'> {
    try {
        await registerShadowAgent(makeRequestContext(role), {});
    } catch (err) {
        return (err as { status?: number }).status === 403 ? 'FORBIDDEN' : 'PAST_THE_GATE';
    }
    throw new Error('an empty intake body was accepted');
}

describe('canRunRegistrationIntake is the usecase\'s own gate', () => {
    it.each(ROLES.map((r) => [r] as const))('%s: the action is shown exactly where the usecase would take it', async (role) => {
        const shown = canRunRegistrationIntake(makeRequestContext(role));
        expect(await gateOutcome(role)).toBe(shown ? 'PAST_THE_GATE' : 'FORBIDDEN');
    });

    it('the register key on READER\'s rung (AI_ADMIN) may run it; a plain READER may not', () => {
        expect(canRunRegistrationIntake(makeRequestContext('AI_ADMIN'))).toBe(true);
        expect(canRunRegistrationIntake(makeRequestContext('READER'))).toBe(false);
        expect(canRunRegistrationIntake(makeRequestContext('OWNER'))).toBe(true);
    });

    it('the coarse write tier without the register key is not enough', () => {
        const ctx = makeRequestContext('ADMIN');
        const withoutKey = { ...ctx, appPermissions: { ...ctx.appPermissions, admin: { ...ctx.appPermissions.admin, agent_registry: false } } };
        expect(canRunRegistrationIntake(withoutKey)).toBe(false);
    });
});
