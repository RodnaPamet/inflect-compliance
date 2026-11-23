/**
 * The agentic control tests' and audit procedures' names — the English the
 * server stores and returns, and the reader's language on the page.
 *
 * A check's title (`AGENTIC_CHECKS[id].title`) is returned with its status and
 * written into the name of the test plan that runs it ("Agent assurance:
 * <title>"); an audit procedure's plan is named "Audit procedure: <title>
 * (<id>)". Those stored names stay English — a plan name is the key a
 * crash-orphaned plan is recognised by, and an evidence row's title is
 * evidence. The page shows them in the reader's language instead:
 *
 *   agentChecks.title.<CHECK_ID>                          — a check's title
 *   audits.workpaperReviews.procedureName.<id with _>     — a procedure's name
 *
 * A plan name is translated only while it is still the stock name the setup
 * wrote; one a person renamed is shown as written.
 *
 * Client-safe on purpose — no server imports.
 */

/** The checks' English titles. `AGENTIC_CHECKS` in `agent-control-tests.ts` reads these. */
export const AGENTIC_CHECK_TITLES = {
    AGENTIC_POLICY_CARD_CONFORMANCE: 'Agent policy cards still match what was approved',
    AGENTIC_TOOL_MANIFEST_INTEGRITY: 'Every pinned tool manifest still matches the live definition',
    AGENTIC_REVIEW_QUALITY: 'Agent proposal reviews show no automation-bias signal',
    AGENTIC_KILL_SWITCH_DRILL: 'The most recent kill-switch drill passed',
    AGENTIC_A2A_INTEGRITY: 'Peer agents still match their approved cards, keys and receipts',
} as const;

export type AgenticCheckTitleId = keyof typeof AGENTIC_CHECK_TITLES;

/** How the assurance setup names a check's plan. */
export const ASSURANCE_PLAN_PREFIX = 'Agent assurance: ';

/** How the audit pilot names a procedure's plan: `<prefix><title> (<id>)`. */
export const PROCEDURE_PLAN_PREFIX = 'Audit procedure: ';

/** A procedure id is dotted (`iam.leaver_timeliness`); a message key cannot be. */
export function procedureNameKey(procedureId: string): string {
    return procedureId.replace(/\./g, '_');
}

/** A translator with next-intl's optional `has`. */
export interface LabelTranslator {
    (key: string, values?: Record<string, string | number>): string;
    has?: (key: string) => boolean;
}

const known = (t: LabelTranslator, key: string) => typeof t.has === 'function' && t.has(key);

/** A check's title; `t` is rooted at `agentChecks`. */
export function localizedCheckTitle(checkId: string, storedTitle: string, t: LabelTranslator): string {
    return known(t, `title.${checkId}`) ? t(`title.${checkId}`) : storedTitle;
}

/** A procedure's name; `t` is rooted at `audits.workpaperReviews.procedureName`. */
export function localizedProcedureName(procedureId: string, storedTitle: string, t: LabelTranslator): string {
    const key = procedureNameKey(procedureId);
    return known(t, key) ? t(key) : storedTitle;
}

const PROCEDURE_PLAN = /^Audit procedure: (.+) \(([a-z][a-z0-9_]*\.[a-z0-9_.]+)\)$/;

/**
 * A test plan's name. The stock names the assurance setup and the audit pilot
 * write are shown in the reader's language (`tChecks` rooted at `agentChecks`,
 * `tProcedures` at `audits.workpaperReviews.procedureName`); any other name,
 * including a stock one a person edited, is shown as stored.
 */
export function localizedPlanName(name: string, tChecks: LabelTranslator, tProcedures: LabelTranslator): string {
    if (name.startsWith(ASSURANCE_PLAN_PREFIX)) {
        const title = name.slice(ASSURANCE_PLAN_PREFIX.length);
        const id = (Object.keys(AGENTIC_CHECK_TITLES) as AgenticCheckTitleId[]).find(
            (k) => AGENTIC_CHECK_TITLES[k] === title,
        );
        if (id && known(tChecks, `title.${id}`)) {
            return tChecks('planName.assurance', { title: tChecks(`title.${id}`) });
        }
        return name;
    }
    const procedure = PROCEDURE_PLAN.exec(name);
    if (procedure) {
        const key = procedureNameKey(procedure[2]);
        if (known(tProcedures, key)) {
            return tChecks('planName.procedure', { title: tProcedures(key), id: procedure[2] });
        }
    }
    return name;
}
