/**
 * The agentic notifications' titles — the English the emitter STORES on each
 * row, and the key a reader's bell shows instead.
 *
 * A bell row is written once, at emit time, for recipients whose language the
 * server does not know (the UI locale is a per-browser cookie), so the row
 * carries English. The title is fixed per notification TYPE, though, so the
 * client can show it in the reader's language: a stored title that still
 * equals its type's English title is the product's sentence and is rendered
 * from `notificationTitles.<TYPE>`. Rows written before this existed carry the
 * same English, so they render translated too.
 *
 * The BODY is not covered: it interpolates the subject and a type-specific
 * detail into prose at emit time, and the parts are not stored separately.
 *
 * Client-safe on purpose — no server imports — since the bell and the
 * notifications page read it.
 */

export type AgenticNotificationKind =
    | 'AGENT_KILL_SWITCH_ENGAGED'
    | 'AGENT_PROPOSAL_QUARANTINED'
    | 'AGENT_CIRCUIT_BREAKER_TRIPPED'
    | 'AGENT_TOOL_MANIFEST_PIN_CHANGED'
    | 'AGENT_RISK_ASSESSMENT_STALE'
    | 'AGENT_OWNER_DEPARTED';

export const AGENTIC_NOTIFICATION_TITLES: Readonly<Record<AgenticNotificationKind, string>> = {
    AGENT_KILL_SWITCH_ENGAGED: 'An agent kill switch was engaged',
    AGENT_PROPOSAL_QUARANTINED: 'An agent proposal was quarantined',
    AGENT_CIRCUIT_BREAKER_TRIPPED: "An agent's circuit breaker tripped",
    AGENT_TOOL_MANIFEST_PIN_CHANGED: 'A tool definition was approved for this workspace',
    AGENT_RISK_ASSESSMENT_STALE: "An agent's risk assessment is out of date",
    AGENT_OWNER_DEPARTED: "An agent's owner has left the workspace",
};

function isAgenticKind(type: string): type is AgenticNotificationKind {
    return Object.prototype.hasOwnProperty.call(AGENTIC_NOTIFICATION_TITLES, type);
}

/**
 * The title to show. `t` is rooted at `notificationTitles`. Any title that is
 * not its type's stock English — another emitter's, or one a future emitter
 * writes differently — is shown as stored.
 */
export function localizedNotificationTitle(
    type: string,
    storedTitle: string,
    t: (key: string) => string,
): string {
    if (isAgenticKind(type) && storedTitle === AGENTIC_NOTIFICATION_TITLES[type]) return t(type);
    return storedTitle;
}
