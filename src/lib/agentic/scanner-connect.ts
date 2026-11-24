/**
 * WHAT "CONNECT A SCANNER" HANDS A CUSTOMER (owner decisions, 2026-11-24).
 *
 * The panel on the Harness tab's Scanner keys card creates ONE API key, bound to
 * the scanner's registered agent, carrying the ingest scope of every report the
 * person ticked, and shows what to put into scanent's `config.json` and
 * `scanent.env`. Pure and client-safe: the panel renders all of it in the
 * browser, so the key never travels back to the server inside a snippet.
 *
 * Four rules, each tested in `tests/unit/agentic/scanner-connect.test.ts`:
 *
 *   • ONE KEY, THE TICKED SCOPES AND NO MORE. Each ingest asks only for its own
 *     permission, so one key with several ingest scopes posts every report it
 *     names. This replaces the earlier rule that a key minted for one report
 *     does not post another: the owner chose one key per scanner on 2026-11-24.
 *   • THE REGISTER READ IS TWO THINGS. `mcp:read` on the key, and the key made
 *     to reach `/api/mcp` only through an exchanged token, because scanent
 *     always exchanges the key for a token naming `get_harness_register`. Its
 *     report key, `admin:harness_ingest`, is that tool's resource scope too, so
 *     reading the register implies it.
 *   • ONE VARIABLE PER REPORT, EACH HOLDING THE SAME KEY. scanent 0.17.0
 *     refuses one variable NAME for two reports and never compares values, so
 *     the panel names scanent's own default variables and says to paste the one
 *     key after each. That works with every released scanent.
 *   • NO KEY IN A SNIPPET. The env lines carry a placeholder.
 */

/** scanent's default variable names (`packages/scanner/src/init/plan.ts`). */
export const SCANNER_KEY_ENV = {
    agentReport: 'INFLECT_INGEST_KEY',
    integrations: 'INFLECT_INTEGRATIONS_KEY',
    agentRules: 'INFLECT_AGENT_RULES_KEY',
} as const;

/** What the env lines show where the key goes. */
export const SCANNER_KEY_PLACEHOLDER = '<paste the key shown above>';

/** The reports a scanner posts, and whether it reads the register. */
export interface ScannerConnectSelection {
    readonly agentReport: boolean;
    readonly integrations: boolean;
    readonly agentRules: boolean;
    readonly readRegister: boolean;
}

/** Whether the selection names at least one report to post. */
export function postsAnyReport(sel: ScannerConnectSelection): boolean {
    return sel.agentReport || sel.integrations || sel.agentRules;
}

/**
 * The scopes of the one key, sorted. Reading the register posts through the
 * agent report's key, so it brings `admin:harness_ingest` with it.
 */
export function scannerKeyScopes(sel: ScannerConnectSelection): string[] {
    const scopes = new Set<string>();
    if (sel.agentReport || sel.readRegister) scopes.add('admin:harness_ingest');
    if (sel.integrations) scopes.add('admin:integrations_ingest');
    if (sel.agentRules) scopes.add('admin:agent_rules_ingest');
    if (sel.readRegister) scopes.add('mcp:read');
    return [...scopes].sort();
}

/** A key that reads the register reaches `/api/mcp` only through an exchanged token. */
export function scannerKeyRequiresExchange(sel: ScannerConnectSelection): boolean {
    return sel.readRegister;
}

/**
 * The key's autonomy ceiling: the agent's own level, and never above 1. A
 * scanner posts reports and, at most, makes one read-tool call (the register
 * read, rung 1), so a higher ceiling would only widen what a leaked key could
 * be used for. `createApiKey` refuses a ceiling above the agent's level.
 */
export function scannerKeyCeiling(agentAutonomyLevel: number): number {
    return Math.max(0, Math.min(agentAutonomyLevel, 1));
}

/** The variables the selection's key goes in, in scanent's order. */
export function scannerKeyVariables(sel: ScannerConnectSelection): string[] {
    const names: string[] = [];
    if (sel.agentReport || sel.readRegister) names.push(SCANNER_KEY_ENV.agentReport);
    if (sel.integrations) names.push(SCANNER_KEY_ENV.integrations);
    if (sel.agentRules) names.push(SCANNER_KEY_ENV.agentRules);
    return names;
}

/** The lines for `scanent.env`, each waiting for the one key. */
export function scannerEnvLines(sel: ScannerConnectSelection): string {
    return scannerKeyVariables(sel)
        .map((name) => `${name}=${SCANNER_KEY_PLACEHOLDER}`)
        .join('\n');
}

/**
 * What to merge into scanent's `config.json`: the scanner's register id, the
 * `inflect` block naming only the ticked reports' variables, and the register
 * as a source when it is read. The origin is the one the person reaches
 * Inflect at; scanent takes an https origin with no path.
 */
export function scannerConfigBlock(input: {
    readonly origin: string;
    readonly tenantSlug: string;
    readonly agentId: string;
    readonly sel: ScannerConnectSelection;
}): Record<string, unknown> {
    const { sel } = input;
    const inflect: Record<string, string> = {
        baseUrl: input.origin.replace(/\/+$/, ''),
        tenantSlug: input.tenantSlug,
    };
    if (sel.agentReport || sel.readRegister) inflect.apiKeyEnv = SCANNER_KEY_ENV.agentReport;
    if (sel.integrations) inflect.integrationsApiKeyEnv = SCANNER_KEY_ENV.integrations;
    if (sel.agentRules) inflect.agentRulesApiKeyEnv = SCANNER_KEY_ENV.agentRules;
    const block: Record<string, unknown> = {
        scanner: { agentId: input.agentId },
        inflect,
    };
    if (sel.readRegister) block.sources = [{ kind: 'inflect-register' }];
    return block;
}

/** Why an agent cannot be connected yet, in the order activation asks. */
export type ScannerAgentBlock = 'unclassified' | 'unscored' | 'notActive';

/** The part of a candidate agent the panel reads; computed on the server. */
export interface ScannerAgentCandidate {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly autonomyLevel: number;
    readonly aiSystemClassified: boolean;
    readonly riskScored: boolean;
}

/**
 * Why a candidate cannot carry a key, or null when it can. Only an ACTIVE agent
 * can be bound to a key, and its keys work only while it stays ACTIVE. For any
 * other status the panel names the first thing activation will ask for, in
 * `assertActivatable`'s order, and links to the agent's page; it never
 * activates the agent itself.
 */
export function scannerAgentBlock(agent: ScannerAgentCandidate): ScannerAgentBlock | null {
    if (agent.status === 'ACTIVE') return null;
    if (!agent.aiSystemClassified) return 'unclassified';
    if (!agent.riskScored) return 'unscored';
    return 'notActive';
}
