/**
 * `scanent-agent-rules/1` report bodies for Inflect's agent-surface rules
 * ingest tests: MCP servers read in full or in part, and findings on their
 * tools.
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
    type AgentRulesReportBody,
    type AgentRulesServer,
} from '@rodnapamet/scanent-contract/agent-rules-contract';

export const CRM = 'mcp:https://mcp.acme.example/crm/mcp';
export const TICKETS = 'mcp:https://mcp.acme.example/tickets/mcp';

/** A finding of `ruleId` on one tool's field, read from `server`. */
export function ruleFinding(server: string, tool: string, over: Partial<AgentRuleFinding> = {}): AgentRuleFinding {
    const subjectRef = `${server}:tool:${tool}`;
    return {
        code: 'MCP_PROMPT_INJECTION',
        ruleId: 'cisco-mcp:instruction-override',
        severity: 'HIGH',
        subjectKind: 'mcp-tool',
        subjectRef,
        serverRef: server,
        locator: `mcp-tool:${subjectRef}#description`,
        ...over,
    };
}

export const complete = (ref: string, tools: number): AgentRulesServer => ({ ref, status: 'COMPLETE', tools });
export const partial = (ref: string, tools: number, reason: AgentRulesServer['reason'] = 'PAGINATION_TORN'): AgentRulesServer => ({
    ref,
    status: 'INCOMPLETE',
    reason,
    tools,
});

/** A body over `servers` with `findings`; the population and counts follow from them. */
export function agentRulesBody(
    scannerAgentId: string,
    scanId: string,
    servers: AgentRulesServer[] = [complete(CRM, 3), complete(TICKETS, 1)],
    findings: AgentRuleFinding[] = [ruleFinding(CRM, 'lookup_account')],
): AgentRulesReportBody {
    const subjects = servers.reduce((n, s) => n + s.tools, 0);
    const stopped = servers.find((s) => s.status === 'INCOMPLETE');
    return {
        contract: AGENT_RULES_CONTRACT_V1,
        scan: {
            id: scanId,
            asOf: '2026-11-22T03:00:00.000Z',
            scanner: { agentId: scannerAgentId, version: '0.17.0', manifestHash: `sha256:${'a'.repeat(64)}` },
        },
        population: [
            stopped === undefined
                ? { kind: 'mcp-tool', status: 'COMPLETE', subjects }
                : { kind: 'mcp-tool', status: 'INCOMPLETE', reason: stopped.reason ?? 'UNREACHABLE', subjects },
        ],
        servers,
        findings,
        counts: { subjects, flagged: new Set(findings.map((f) => f.subjectRef)).size },
    };
}
