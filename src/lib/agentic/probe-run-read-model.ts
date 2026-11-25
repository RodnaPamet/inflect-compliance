/**
 * The Probes tab's data, as the server builds it (`getProbeRunInventory`,
 * `getProbeRunDetail`, `getProberKeysView`, `getProbeApproverKeysView`): plain
 * types and one pure function, so a client component can hold it without
 * reaching the contract package, which requires `crypto`.
 *
 * A run is judged by what it ANSWERED, never by what it did not send: a run
 * that reached no target, was stopped or concluded nothing is never stated
 * clean (`probeRunState`).
 */

/** One verified probe run, counts only: no endpoint and no excerpt. */
export interface ProbeRunView {
    readonly runId: string;
    readonly engagementId: string;
    readonly startedAt: string;
    readonly endedAt: string;
    /** Why the run ended early, or null when every planned probe was sent. */
    readonly stopReason: string | null;
    /** Derived at ingest: some outcome was not INCONCLUSIVE. */
    readonly concluded: boolean;
    readonly targetCount: number;
    readonly targetsReached: number;
    readonly outcomeCount: number;
    readonly actedCount: number;
    readonly disclosedCount: number;
    readonly resistedCount: number;
    readonly inconclusiveCount: number;
    readonly findingCount: number;
}

/** One open finding a prober raised, named by probe, class, origin and tool. */
export interface ProbeFindingView {
    readonly findingId: string;
    /** `HIGH` | `MEDIUM`, the Finding's own. */
    readonly severity: string;
    readonly probeId: string;
    readonly probeClass: string;
    /** Scheme and host of the target: never its path. */
    readonly origin: string;
    /** `mcp` | `a2a` | `http-chat`. */
    readonly kind: string;
    /** The MCP tool called, or null. */
    readonly tool: string | null;
    /** The reason that raised it, from the latest outcome that did. */
    readonly verdictReason: string;
}

export interface ProbeRunSection {
    readonly proberAgentId: string;
    /** Null when the prober's register row was deleted. */
    readonly proberName: string | null;
    /** Newest first. */
    readonly runs: readonly ProbeRunView[];
    /** The prober has more runs in the window than the section lists. */
    readonly runsTruncated: boolean;
    /** The prober's open probe findings, most severe first. */
    readonly findings: readonly ProbeFindingView[];
    readonly findingsTruncated: boolean;
}

export interface ProbeRunInventoryView {
    readonly sections: readonly ProbeRunSection[];
    /** Agents holding a live prober key that have no run in the window. */
    readonly probersWithoutRun: readonly { readonly agentId: string; readonly name: string | null }[];
    /** Probers with runs beyond the sections the tab shows. */
    readonly probersNotShown: number;
    /** More runs than the window read. */
    readonly runsTruncated: boolean;
}

/** One target of a run, as the detail read returns it. */
export interface ProbeRunTargetView {
    readonly targetId: string;
    readonly origin: string;
    readonly kind: string;
    readonly reached: boolean;
    /** `REACHED` | `NO_REPLY` | `NO_PROBES_FOR_INTERFACE` | `NOT_RUN`. */
    readonly reason: string;
    /** The full endpoint, decrypted for a register-key holder; null otherwise. */
    readonly endpoint: string | null;
}

/** One outcome of a run, as the detail read returns it. */
export interface ProbeRunOutcomeView {
    readonly outcomeId: string;
    readonly targetId: string;
    readonly probeId: string;
    readonly probeClass: string;
    /** `ACTED` | `DISCLOSED` | `RESISTED` | `INCONCLUSIVE`. */
    readonly verdict: string;
    readonly verdictReason: string;
    readonly tool: string | null;
    /**
     * What the agent said, decrypted for a register-key holder, beside ACTED or
     * DISCLOSED only. Null when there is none OR when it is withheld: read
     * `ProbeRunDetailView.excerptsShown` to tell them apart.
     */
    readonly excerpt: string | null;
    /** The finding this outcome speaks to, while one exists. */
    readonly findingId: string | null;
}

export interface ProbeRunDetailView {
    readonly run: ProbeRunView & {
        readonly proberAgentId: string;
        readonly proberName: string | null;
        readonly catalogueProbes: number;
    };
    readonly targets: readonly ProbeRunTargetView[];
    readonly outcomes: readonly ProbeRunOutcomeView[];
    /** More outcomes than the read returns. */
    readonly outcomesTruncated: boolean;
    /**
     * The viewer holds `admin.agent_registry`, so endpoints and excerpts are
     * shown. False for a reader through the inventory view key alone: the
     * fields are WITHHELD, which the tab says, never empty.
     */
    readonly excerptsShown: boolean;
}

/** A prober key, as its card lists it. */
export interface ProberKeyRow {
    readonly id: string;
    readonly agentId: string;
    /** Null when the agent's register row was deleted. */
    readonly agentName: string | null;
    readonly keyFingerprint: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
}

export interface ProberKeysView {
    readonly keys: { readonly rows: readonly ProberKeyRow[]; readonly truncated: boolean };
    /** Live, non-retired register rows a key may be bound to. */
    readonly candidates: { readonly rows: readonly { readonly id: string; readonly name: string }[]; readonly truncated: boolean };
}

/** An approver key, as its card lists it. */
export interface ApproverKeyRow {
    readonly id: string;
    readonly label: string;
    readonly keyFingerprint: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
}

export interface ApproverKeysView {
    readonly rows: readonly ApproverKeyRow[];
    readonly truncated: boolean;
}

export type ProbeRunState = 'FINDINGS' | 'NOTHING_REACHED' | 'STOPPED' | 'NOT_CONCLUDED' | 'RESISTED' | 'PARTLY_INCONCLUSIVE';

/**
 * What the tab says first about one run. An agent that acted or disclosed
 * comes first, because it is the finding. After that nothing is called clean
 * unless the run reached a target, ran to its end, concluded, and every outcome
 * it holds was RESISTED — in ONE expression, so a run of no outcome is never
 * "resisted" (zero is never complete).
 */
export function probeRunState(run: Pick<
    ProbeRunView,
    'actedCount' | 'disclosedCount' | 'targetsReached' | 'stopReason' | 'concluded' | 'outcomeCount' | 'resistedCount'
>): ProbeRunState {
    if (run.actedCount + run.disclosedCount > 0) return 'FINDINGS';
    if (run.targetsReached === 0) return 'NOTHING_REACHED';
    if (run.stopReason !== null) return 'STOPPED';
    if (!run.concluded) return 'NOT_CONCLUDED';
    if (run.outcomeCount > 0 && run.resistedCount === run.outcomeCount) return 'RESISTED';
    return 'PARTLY_INCONCLUSIVE';
}
