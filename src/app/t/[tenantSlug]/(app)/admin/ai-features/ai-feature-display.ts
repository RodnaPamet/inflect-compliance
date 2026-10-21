/**
 * Which of the four reasons a switch is off — decided here, not in JSX.
 *
 * ═══ WHY THIS IS A FUNCTION AND NOT A TERNARY IN THE COMPONENT ═══
 *
 * The thing worth getting right about this page is NOT that a toggle renders.
 * It is that a toggle which cannot work says so. The launcher bug (#3909) was
 * exactly this: a control rendered from one predicate while the request behind
 * it was refused by another, so a reader saw an available feature and got a
 * refusal every time they used it.
 *
 * A ternary inside the markup can only be tested by mounting the page and
 * arranging four fixtures. A pure function can be driven with the failing input
 * directly — which is the difference between a test that proves the forced-off
 * case is handled and a test that renders the happy path and passes.
 *
 * @module admin/ai-features/ai-feature-display
 */
import type { AiToggleState } from '@/app-layer/usecases/ai-feature-toggles';

export type ToggleDisplayKind =
    /** Effective. */
    | 'on'
    /** The deploy forbids it. No permission on this page can change that. */
    | 'off-by-platform'
    /** The workspace master switch is off, so this feature cannot run. */
    | 'off-by-master'
    /** This workspace turned this feature off. */
    | 'off-by-tenant';

export interface ToggleDisplay {
    kind: ToggleDisplayKind;
    /** May the admin flip this switch here at all? */
    actionable: boolean;
}

/**
 * ORDER IS THE CONTRACT, not an implementation detail.
 *
 * A switch can be off for more than one reason at once, and the reader needs
 * the one that decides what to DO:
 *
 *   1. platform — nothing on this page helps; it needs a deploy. Stated first
 *      because every other explanation would send the reader to flip a switch
 *      that changes nothing.
 *   2. master   — the fix is the master switch above, not this row.
 *   3. tenant   — their own choice, and the only one this row undoes.
 *
 * The master key itself skips rule 2: "AI is off because AI is off" explains
 * nothing.
 */
export function displayFor(state: AiToggleState, tenantMasterEnabled: boolean): ToggleDisplay {
    if (!state.envEnabled) {
        // NOT actionable. The write would be ACCEPTED by the API — the usecase
        // deliberately stores intent the env currently forbids — but offering it
        // here would show a control whose success changes nothing a reader can
        // see. That is the trap this whole module exists to avoid.
        return { kind: 'off-by-platform', actionable: false };
    }
    if (state.key !== 'ai' && !tenantMasterEnabled) {
        // ACTIONABLE even so: it is this workspace's own setting and flipping it
        // is meaningful once the master is back on. The row says what else is
        // needed rather than disabling a control that does what it says.
        return { kind: 'off-by-master', actionable: true };
    }
    if (!state.tenantEnabled) return { kind: 'off-by-tenant', actionable: true };
    return { kind: 'on', actionable: true };
}
