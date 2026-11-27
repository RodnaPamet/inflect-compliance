/**
 * An audit checklist item's prompt, as shown (#5996).
 *
 * The prompt is a stored English sentence that `createAudit` builds around a
 * catalogue title ("Verify A.5.1 — <requirement title>: confirm implementation
 * and evidence", or the control form when the audit has no framework). The
 * content lookup is keyed by exact catalogue text, so it can only know the
 * title inside the sentence: the lookup is asked for that part and the
 * sentence around it is shown as stored. Display only.
 */
const REQUIREMENT_PROMPT = /^(Verify .+? — )(.+)(: confirm implementation and evidence)$/;
const CONTROL_PROMPT = /^(Verify control ")(.+)(" \(.*\): check implementation status and evidence)$/;

export function checklistPromptText(prompt: string, tc: (text: string) => string): string {
    const match = REQUIREMENT_PROMPT.exec(prompt) ?? CONTROL_PROMPT.exec(prompt);
    return match ? `${match[1]}${tc(match[2])}${match[3]}` : prompt;
}
