/**
 * Why the setup wizard refused a request (#4701).
 *
 * Each refusal travels in `error.details.reason`, beside an English
 * `error.message`. The wizard maps a known reason to its own translated
 * sentence (`onboarding.wizard.refused.<reason>`) and falls back to the
 * server's message for anything else, so a Bulgarian Owner is not shown
 * English for a refusal the wizard can name.
 *
 * Client-safe: no server imports.
 */

export const ONBOARDING_REFUSALS = [
    'ONBOARDING_ADMIN_ONLY',
    'ONBOARDING_NOT_STARTED',
    'ONBOARDING_NOT_IN_PROGRESS',
    'ONBOARDING_NO_FRAMEWORK',
    'ONBOARDING_NO_PACK',
    'ONBOARDING_UNKNOWN_PACK',
    /** An answer to, or completion of, a NIS2 run that is already finalised (#4734). */
    'NIS2_RUN_FINALISED',
] as const;

export type OnboardingRefusal = (typeof ONBOARDING_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(ONBOARDING_REFUSALS);

export function isOnboardingRefusal(value: unknown): value is OnboardingRefusal {
    return typeof value === 'string' && KNOWN.has(value);
}
