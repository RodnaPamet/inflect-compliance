/**
 * The agent page's sections, how they are grouped into tabs, and how a
 * `?tab=` link finds one — for the page and its loading skeleton alike
 * (#5313).
 *
 * A plain module, not `AgentDetailClient.tsx`: a server component (the
 * route's `loading.tsx`) importing a value from a `'use client'` file gets a
 * client reference, not the array. The skeleton counted six while the page
 * rendered eight or nine — the layout shift a skeleton exists to prevent.
 *
 * NINE SECTIONS, FOUR TABS (#5898, owner decision 2026-11-23). Nine tabs in a
 * strip meant a phone reader scrolled it hunting for the one they wanted. The
 * sections are grouped by the question a reader brings:
 *
 *   overview    — Overview
 *   assessment  — Risk assessment, ASI coverage       (how risky, how covered)
 *   authority   — Policy card, Tools, Skills, Behaviour (what it may and should do)
 *   activity    — Runs, Circuit breaker                (what it did, what stops it)
 *
 * The group strip is the page's tab bar; a group with more than one section
 * shows a second, smaller strip of its sections. The cued `ScrollCueStrip`
 * stays the mechanism for both.
 *
 * A section key is still the address of a section: `?tab=runs` opens
 * Activity on Runs, exactly where the nine-tab page put it, and a group key
 * (`?tab=activity`) opens the group on its first section a reader may open.
 */
export const AGENT_DETAIL_TAB_KEYS = [
    'overview', 'risk', 'policy', 'tools', 'skills', 'behaviour', 'coverage', 'runs', 'breaker',
] as const;

/** A section of the page — what each tab was before the grouping. */
export type AgentDetailTabKey = (typeof AGENT_DETAIL_TAB_KEYS)[number];

/** Sections the page shows only in some workspaces: Behaviour, while agent profiles are on. */
export const AGENT_DETAIL_OPTIONAL_TAB_KEYS: readonly AgentDetailTabKey[] = ['behaviour'];

/** The tabs, in order, and the sections each holds, in order. */
export const AGENT_DETAIL_GROUPS = {
    overview: ['overview'],
    assessment: ['risk', 'coverage'],
    authority: ['policy', 'tools', 'skills', 'behaviour'],
    activity: ['runs', 'breaker'],
} as const satisfies Record<string, readonly AgentDetailTabKey[]>;

export type AgentDetailGroupKey = keyof typeof AGENT_DETAIL_GROUPS;

export const AGENT_DETAIL_GROUP_KEYS = Object.keys(AGENT_DETAIL_GROUPS) as AgentDetailGroupKey[];

/** The group a section sits in. */
export function agentDetailGroupOf(tab: AgentDetailTabKey): AgentDetailGroupKey {
    for (const g of AGENT_DETAIL_GROUP_KEYS) {
        if ((AGENT_DETAIL_GROUPS[g] as readonly AgentDetailTabKey[]).includes(tab)) return g;
    }
    return 'overview';
}

/**
 * The section a `?tab=` value opens, given which sections this page shows and
 * which of them the reader may open.
 *
 * A section key opens that section; a group key opens the group's first
 * section the reader may open. A section the reader may not open, or the page
 * does not show, falls back to the first one in its group they may — and an
 * unknown value, or a group with nothing open, to Overview.
 */
export function resolveAgentDetailTab(
    param: string | null | undefined,
    isOpen: (tab: AgentDetailTabKey) => boolean,
): AgentDetailTabKey {
    if (!param) return 'overview';
    const isSection = (AGENT_DETAIL_TAB_KEYS as readonly string[]).includes(param);
    const isGroup = (AGENT_DETAIL_GROUP_KEYS as readonly string[]).includes(param);
    if (isSection && isOpen(param as AgentDetailTabKey)) return param as AgentDetailTabKey;
    const group: AgentDetailGroupKey | null = isSection
        ? agentDetailGroupOf(param as AgentDetailTabKey)
        : isGroup
            ? (param as AgentDetailGroupKey)
            : null;
    if (!group) return 'overview';
    const first = (AGENT_DETAIL_GROUPS[group] as readonly AgentDetailTabKey[]).find(isOpen);
    return first ?? 'overview';
}

/**
 * How many tabs the skeleton draws: one per group. Every workspace sees all
 * four — Behaviour, the one optional section, sits in a group that always has
 * others.
 */
export const AGENT_DETAIL_SKELETON_TAB_COUNT = AGENT_DETAIL_GROUP_KEYS.length;
