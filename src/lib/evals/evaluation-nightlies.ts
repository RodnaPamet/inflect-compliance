/**
 * The platform's two LLM evaluation nightlies, as static typed content for the
 * organization settings page's "Evaluations" card (owner decision 2026-11-12).
 *
 * Both run as GitHub Actions against a throwaway copy of the app built on the
 * CI runner, never against production, and both are switched by GitHub
 * REPOSITORY variables. Nothing in the product can read either: so this module
 * holds no live state and the card makes no network call. It describes the
 * workflows, and `tests/unit/evaluation-nightlies.test.ts` holds every fact
 * here to the workflow file and budget file it is copied from, so a moved cron
 * or a renamed variable fails CI instead of leaving the card wrong.
 *
 * Client-safe: no imports.
 */

/** The one place the repository's address is spelled. */
export const EVALS_REPOSITORY_URL = 'https://github.com/RodnaPamet/inflect-compliance';

/** Where an admin of the repository sets the two switch variables. */
export const EVALS_ACTIONS_VARIABLES_URL = `${EVALS_REPOSITORY_URL}/settings/variables/actions`;

/** A workflow's own runs page on GitHub. */
export function evalWorkflowRunsUrl(workflowFile: string): string {
    return `${EVALS_REPOSITORY_URL}/actions/workflows/${workflowFile}`;
}

/** The value a switch variable must hold for the nightly to run. */
export const EVAL_SWITCH_ON_VALUE = 'true';

/**
 * The shared key secret each nightly falls back to. These constants hold the
 * NAMES of GitHub Actions secrets, which the card displays; no value is ever
 * in this file, hence the secret-scan pragma on each line.
 */
export const EVAL_SHARED_KEY_SECRET = 'ANTHROPIC_API_KEY'; // pragma: allowlist secret -- a GitHub secret's NAME shown on the card, never a value

export type EvalNightlyKey = 'garak' | 'inspect';

export interface EvalNightly {
    readonly key: EvalNightlyKey;
    /** Under `.github/workflows/`. */
    readonly workflowFile: string;
    /** The roadmap the workflow names as its source of intent. */
    readonly roadmapDoc: string;
    /** The scheduled time, UTC, `HH:MM`. */
    readonly scheduleUtc: string;
    /** The nightly spend cap this workflow is held to, in USD. */
    readonly budgetUsd: number;
    /** The cap that budget is a share of, when it is a share. */
    readonly sharedCapUsd: number | null;
    /** The owner decision that set the budget. */
    readonly budgetDecision: string;
    /** The repository variable that switches the scheduled run on. */
    readonly switchVariable: string;
    /** The dedicated key secret, used before the shared one. */
    readonly dedicatedKeySecret: string;
}

export const EVAL_NIGHTLIES: readonly EvalNightly[] = [
    {
        key: 'garak',
        workflowFile: 'garak.yml',
        roadmapDoc: 'docs/ai-architecture/garak.md',
        scheduleUtc: '01:15',
        budgetUsd: 2.5,
        sharedCapUsd: 5,
        budgetDecision: 'D-EV-11',
        switchVariable: 'GARAK_ENABLED',
        dedicatedKeySecret: 'GARAK_CI_ANTHROPIC_KEY', // pragma: allowlist secret -- a GitHub secret's NAME shown on the card, never a value
    },
    {
        key: 'inspect',
        workflowFile: 'agent-evals.yml',
        roadmapDoc: 'docs/ai-architecture/inspect.md',
        scheduleUtc: '02:20',
        budgetUsd: 10,
        sharedCapUsd: null,
        budgetDecision: 'D-EV-6',
        switchVariable: 'AGENT_EVALS_ENABLED',
        dedicatedKeySecret: 'INSPECT_CI_ANTHROPIC_KEY', // pragma: allowlist secret -- a GitHub secret's NAME shown on the card, never a value
    },
];

/** `2.5` → `2.50`, `10` → `10`: whole dollars stay whole. */
export function formatEvalUsd(amount: number): string {
    return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}
