/**
 * `scanent-agent-rules/1` report bodies for Inflect's agent-surface rules
 * ingest tests: origins (MCP servers and code roots) read in full or in part,
 * and findings on a tool or a skill read there.
 *
 * Typed against the installed contract package, so a contract change fails
 * `tsc` here first. Reports are signed with the harness fake scanner
 * (`createFakeScanner`): every scanent contract signs the same canonical JSON
 * with the same Ed25519 key, which is why one registered scanner key verifies
 * all three of a scanner's reports.
 */
import {
    AGENT_RULES_CONTRACT_V1,
    type AgentRuleFinding,
    type AgentRulesOrigin,
    type AgentRulesPopulation,
    type AgentRulesReportBody,
} from '@rodnapamet/scanent-contract/agent-rules-contract';

export const CRM = 'mcp:https://mcp.acme.example/crm/mcp';
export const TICKETS = 'mcp:https://mcp.acme.example/tickets/mcp';
/** A code root, as the `code` source names it. */
export const REPO = 'code:support-repo';

/** A finding of `ruleId` on one tool's field, read from `server`. */
export function ruleFinding(server: string, tool: string, over: Partial<AgentRuleFinding> = {}): AgentRuleFinding {
    const subjectRef = `${server}:tool:${tool}`;
    return {
        code: 'MCP_PROMPT_INJECTION',
        ruleId: 'cisco-mcp:instruction-override',
        severity: 'HIGH',
        subjectKind: 'mcp-tool',
        subjectRef,
        originRef: server,
        locator: `mcp-tool:${subjectRef}#description`,
        ...over,
    };
}

/** A finding of a skill rule on a SKILL.md's instructions, read from the code root `root`. */
export function skillFinding(root: string, path: string, over: Partial<AgentRuleFinding> = {}): AgentRuleFinding {
    const subjectRef = `${root}/${path}`;
    return {
        code: 'SKILL_PROMPT_INJECTION',
        ruleId: 'cisco-skill:ignore-instructions',
        severity: 'HIGH',
        subjectKind: 'skill',
        subjectRef,
        originRef: root,
        locator: `skill:${subjectRef}#instructions`,
        ...over,
    };
}

export const complete = (ref: string, subjects: number): AgentRulesOrigin => ({ ref, status: 'COMPLETE', subjects });
export const partial = (ref: string, subjects: number, reason: AgentRulesOrigin['reason'] = 'PAGINATION_TORN'): AgentRulesOrigin => ({
    ref,
    status: 'INCOMPLETE',
    reason,
    subjects,
});

/** The populations of one family, read from its origins: a code root's subjects are all counted as skills. */
function populationsOf(origins: readonly AgentRulesOrigin[], family: 'mcp' | 'code'): AgentRulesPopulation[] {
    const of = origins.filter((o) => o.ref.startsWith(`${family}:`));
    if (of.length === 0) return [];
    const subjects = of.reduce((n, o) => n + o.subjects, 0);
    const stopped = of.find((o) => o.status === 'INCOMPLETE');
    const one = (kind: AgentRulesPopulation['kind'], n: number): AgentRulesPopulation =>
        stopped === undefined ? { kind, status: 'COMPLETE', subjects: n } : { kind, status: 'INCOMPLETE', reason: stopped.reason ?? 'UNREACHABLE', subjects: n };
    return family === 'mcp' ? [one('mcp-tool', subjects)] : [one('skill', subjects), one('skill-file', 0)];
}

/** A body over `origins` with `findings`; the populations and counts follow from them. */
export function agentRulesBody(
    scannerAgentId: string,
    scanId: string,
    origins: AgentRulesOrigin[] = [complete(CRM, 3), complete(TICKETS, 1)],
    findings: AgentRuleFinding[] = [ruleFinding(CRM, 'lookup_account')],
): AgentRulesReportBody {
    const read = [...populationsOf(origins, 'mcp'), ...populationsOf(origins, 'code')];
    // A scan that read no origin still read a kind: an MCP source that listed no server's tool.
    const population: AgentRulesPopulation[] = read.length > 0 ? read : [{ kind: 'mcp-tool', status: 'COMPLETE', subjects: 0 }];
    const subjects = population.reduce((n, p) => n + p.subjects, 0);
    return {
        contract: AGENT_RULES_CONTRACT_V1,
        scan: {
            id: scanId,
            asOf: '2026-11-22T03:00:00.000Z',
            scanner: { agentId: scannerAgentId, version: '0.17.0', manifestHash: `sha256:${'a'.repeat(64)}` },
        },
        population,
        origins,
        findings,
        counts: { subjects, flagged: new Set(findings.map((f) => f.subjectRef)).size },
    };
}
