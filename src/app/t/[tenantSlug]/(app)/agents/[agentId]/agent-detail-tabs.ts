/**
 * The agent page's tabs, in order, for the page and its loading skeleton
 * alike (#5313).
 *
 * A plain module, not `AgentDetailClient.tsx`: a server component (the
 * route's `loading.tsx`) importing a value from a `'use client'` file gets a
 * client reference, not the array. The skeleton counted six while the page
 * rendered eight or nine — the layout shift a skeleton exists to prevent.
 *
 * See `AgentDetailClient.tsx` for why each tab sits where it does.
 */
export const AGENT_DETAIL_TAB_KEYS = [
    'overview', 'risk', 'policy', 'tools', 'skills', 'behaviour', 'coverage', 'runs', 'breaker',
] as const;

export type AgentDetailTabKey = (typeof AGENT_DETAIL_TAB_KEYS)[number];

/** Tabs the page shows only in some workspaces: Behaviour, while agent profiles are on. */
export const AGENT_DETAIL_OPTIONAL_TAB_KEYS: readonly AgentDetailTabKey[] = ['behaviour'];

/**
 * How many tabs the skeleton draws: every tab every workspace sees. The
 * loading route has no tenant to ask about agent profiles, so it promises the
 * shape every workspace gets; Behaviour, where it is on, adds one.
 */
export const AGENT_DETAIL_SKELETON_TAB_COUNT = AGENT_DETAIL_TAB_KEYS.filter(
    (k) => !AGENT_DETAIL_OPTIONAL_TAB_KEYS.includes(k),
).length;
