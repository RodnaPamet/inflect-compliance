/**
 * Which reason an AI switch is off — and the ORDER the reasons are tried in.
 *
 * This is the file that pins the lesson of #3909. There, a control rendered
 * from one predicate while the request behind it was refused by another, so a
 * reader saw an available feature and was refused every time they used it. The
 * fix is not "show fewer controls"; it is that a control which cannot work says
 * which layer stopped it, because that decides what the reader should do next.
 *
 * Priority is the contract:
 *   platform → nothing on this page helps, it needs a deploy
 *   master   → the fix is the switch above, not this row
 *   tenant   → their own choice, and the only one this row undoes
 *
 * Each case below sets up a state where SEVERAL reasons are true at once, so a
 * wrong order is a failure rather than a coin flip. A test that only ever
 * presented one true reason would pass under any ordering.
 */
import type { AiToggleState } from '@/app-layer/usecases/ai-feature-toggles';
import { displayFor } from '@/app/t/[tenantSlug]/(app)/admin/ai-features/ai-feature-display';

function state(over: Partial<AiToggleState> = {}): AiToggleState {
    return {
        key: 'assistant',
        tenantEnabled: true,
        envEnabled: true,
        effective: true,
        forcedOffByEnv: false,
        ...over,
    };
}

describe('displayFor', () => {
    it('on when the env and the tenant both allow', () => {
        expect(displayFor(state(), true)).toEqual({ kind: 'on', actionable: true });
    });

    it('off-by-tenant when only the tenant turned it off', () => {
        expect(displayFor(state({ tenantEnabled: false }), true)).toEqual({
            kind: 'off-by-tenant',
            actionable: true,
        });
    });

    it('off-by-master when the feature is on but the workspace master is off', () => {
        // ACTIONABLE: it is this workspace's own switch and flipping it is
        // meaningful once the master is back on. The row explains what else is
        // needed rather than disabling a control that does what it says.
        expect(displayFor(state({ tenantEnabled: true }), false)).toEqual({
            kind: 'off-by-master',
            actionable: true,
        });
    });

    it('off-by-platform OUTRANKS both other reasons', () => {
        // All three are true here: the deploy forbids it, the master is off, and
        // the tenant switch is off. Only the platform answer tells the reader
        // the truth — that nothing they can do on this page changes it.
        const result = displayFor(
            state({ envEnabled: false, tenantEnabled: false, forcedOffByEnv: true }),
            false,
        );
        expect(result).toEqual({ kind: 'off-by-platform', actionable: false });
    });

    it('off-by-master OUTRANKS off-by-tenant', () => {
        // Both true. Naming the tenant switch would send the reader to flip the
        // row they are already looking at, which would change nothing visible.
        expect(displayFor(state({ tenantEnabled: false }), false)).toEqual({
            kind: 'off-by-master',
            actionable: true,
        });
    });

    it('the MASTER row never reports off-by-master', () => {
        // "AI is off because AI is off" explains nothing. With the master key
        // the tenant answer is the real one.
        expect(displayFor(state({ key: 'ai', tenantEnabled: false }), false)).toEqual({
            kind: 'off-by-tenant',
            actionable: true,
        });
        expect(displayFor(state({ key: 'ai' }), false)).toEqual({ kind: 'on', actionable: true });
    });

    it('the platform answer is the only non-actionable one', () => {
        // The whole point of `actionable` is deciding whether to render a
        // control. If a second kind ever became non-actionable, this page would
        // silently stop offering a switch an owner is entitled to flip.
        const kinds = [
            displayFor(state(), true),
            displayFor(state({ tenantEnabled: false }), true),
            displayFor(state({ tenantEnabled: true }), false),
            displayFor(state({ envEnabled: false, forcedOffByEnv: true }), true),
        ];
        expect(kinds.filter((k) => !k.actionable).map((k) => k.kind)).toEqual(['off-by-platform']);
    });
});
