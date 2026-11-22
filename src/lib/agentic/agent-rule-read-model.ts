/**
 * The Agent surface tab's data, as the server builds it
 * (`getAgentRuleInventory`): plain types and one pure function, so a client
 * component can hold it without reaching the contract package, which requires
 * `crypto`.
 */

/** What one scan concluded about the surface as a whole. Never "clean" of a read of nothing. */
export type AgentRuleOutcome = 'FINDINGS' | 'NO_FINDING_ON_A_COMPLETE_READ' | 'NOTHING_READ' | 'NOT_CONCLUDED';

export interface AgentRuleServerView {
    /** `mcp:<server URL>`, or `mcp:sha256-<32 hex>`. */
    readonly ref: string;
    readonly status: 'COMPLETE' | 'INCOMPLETE';
    /** The contract's reason when INCOMPLETE; null when COMPLETE. */
    readonly reason: string | null;
    readonly tools: number;
}

/** One open finding the scanner raised, as its latest scan listed it. */
export interface AgentRuleFindingView {
    readonly findingId: string;
    readonly code: string;
    readonly ruleId: string;
    /** `HIGH` | `MEDIUM` | `LOW`, the Finding's own (a reported `INFO` is stored `LOW`). */
    readonly severity: string;
    readonly serverRef: string;
    readonly subjectRef: string;
    /** `mcp-tool:<subject>#<field>`. */
    readonly locator: string;
    /** The field the rule fired on: `description` or `inputSchema`. */
    readonly field: string;
}

export interface AgentRuleScanView {
    readonly scanRef: string;
    readonly asOf: string;
    readonly scannerVersion: string;
    readonly complete: boolean;
    readonly outcome: AgentRuleOutcome;
    readonly subjects: number;
    readonly flagged: number;
    readonly findingCount: number;
    /** The population's reason when the read was not complete. */
    readonly incompleteReason: string | null;
}

export interface AgentRuleSection {
    readonly scannerAgentId: string;
    readonly scannerName: string | null;
    readonly scan: AgentRuleScanView;
    readonly servers: readonly AgentRuleServerView[];
    /** The scanner's open agent-rule findings, most severe first. */
    readonly findings: readonly AgentRuleFindingView[];
    /** More open findings than the tab lists. */
    readonly findingsTruncated: boolean;
}

export interface AgentRuleInventoryView {
    readonly sections: readonly AgentRuleSection[];
    /** Registered scanners holding a key that have no agent-rules scan in the window. */
    readonly scannersWithoutScan: readonly { readonly agentId: string; readonly name: string | null }[];
    /** Scanners with a scan beyond the sections the tab shows. */
    readonly scannersNotShown: number;
    /** More scans than the window read. */
    readonly scansTruncated: boolean;
}

/**
 * What the tab says first about one scan, in ONE expression with the planner's
 * rule: clean only of a complete read that held at least one tool.
 */
export function agentRuleScanState(scan: Pick<AgentRuleScanView, 'outcome'>): 'FINDINGS' | 'CLEAN' | 'NOTHING_READ' | 'NOT_CONCLUDED' {
    switch (scan.outcome) {
        case 'FINDINGS':
            return 'FINDINGS';
        case 'NO_FINDING_ON_A_COMPLETE_READ':
            return 'CLEAN';
        case 'NOTHING_READ':
            return 'NOTHING_READ';
        default:
            return 'NOT_CONCLUDED';
    }
}
