/**
 * Which parts of a cross-domain dashboard payload belong to which domain.
 *
 * `get_compliance_posture` and `get_tenant_context` are the two MCP tools whose
 * result spans domains the tool's own gate does not cover: a `controls.view`
 * check lets the call through, and the payload then carries risk counts, evidence
 * pressure, policy and vendor summaries with it. Gating the CALL would leave an
 * agent reading, out of a controls tool, exactly the rows its principal is
 * forbidden — which is the read half of the confused deputy and the half the
 * data actually leaves through.
 *
 * So the sections are declared here, once, and the funnel removes the ones the
 * acting context cannot see. Shared by both tools because both read the same
 * `DashboardRepository.getStats` shape; keeping one list means a new stat cannot
 * be classified in one tool and forgotten in the other.
 */
import type { PermissionKey } from '@/lib/security/permission-key';

import type { McpRedactionRule, McpRowRedactionRule } from './types';

/** `getStats` fields, by the domain each counts. */
const STATS_BY_DOMAIN = {
    'risks.view': ['stats.risks', 'stats.highRisks'],
    'evidence.view': ['stats.evidence', 'stats.pendingEvidence', 'stats.overdueEvidence'],
    'tasks.view': ['stats.openTasks'],
    'audits.view': ['stats.openFindings'],
} as const;

/**
 * The executive payload: the stats above plus the per-domain aggregate blocks.
 *
 * `controlCoverage` and `stats.controls` are deliberately absent — `controls.view`
 * is the tool's own gate, so a context that reaches the payload at all holds it,
 * and a rule that can never fire is a rule that misleads its next reader.
 */
export const EXECUTIVE_DASHBOARD_REDACTION: readonly McpRedactionRule[] = [
    { key: 'risks.view', paths: [...STATS_BY_DOMAIN['risks.view'], 'riskBySeverity', 'riskByStatus'] },
    { key: 'evidence.view', paths: [...STATS_BY_DOMAIN['evidence.view'], 'evidenceExpiry'] },
    { key: 'tasks.view', paths: [...STATS_BY_DOMAIN['tasks.view'], 'taskSummary'] },
    { key: 'audits.view', paths: [...STATS_BY_DOMAIN['audits.view']] },
    { key: 'policies.view', paths: ['policySummary'] },
    { key: 'vendors.view', paths: ['vendorSummary'] },
];

/** The `{ stats, recentActivity }` payload — the stats half. */
export const TENANT_CONTEXT_REDACTION: readonly McpRedactionRule[] = [
    { key: 'risks.view', paths: [...STATS_BY_DOMAIN['risks.view']] },
    { key: 'evidence.view', paths: [...STATS_BY_DOMAIN['evidence.view']] },
    { key: 'tasks.view', paths: [...STATS_BY_DOMAIN['tasks.view']] },
    { key: 'audits.view', paths: [...STATS_BY_DOMAIN['audits.view']] },
];

/**
 * `AuditLog.entity` → the permission key needed to see that row.
 *
 * The recent-activity feed is one array carrying every domain, so a section-level
 * rule cannot express it: it has to be filtered per row. An entity NOT listed
 * here keeps its row — see `McpRowRedactionRule.keyOf`. That direction is a
 * decision: the feed also carries memberships, settings and audit-trail
 * housekeeping, none of which has a domain key, and dropping the unrecognised
 * would empty the feed rather than filter it. Every entity that names a GOVERNED
 * domain is listed.
 */
const ACTIVITY_ENTITY_DOMAIN: Record<string, PermissionKey> = {
    Risk: 'risks.view',
    Control: 'controls.view',
    Evidence: 'evidence.view',
    Policy: 'policies.view',
    PolicyVersion: 'policies.view',
    Task: 'tasks.view',
    Issue: 'tasks.view',
    Finding: 'audits.view',
    Audit: 'audits.view',
    AuditPack: 'audits.view',
    Vendor: 'vendors.view',
    Asset: 'assets.view',
    Incident: 'incidents.view',
    Employee: 'personnel.view',
};

export const TENANT_CONTEXT_ROW_REDACTION: readonly McpRowRedactionRule[] = [
    {
        path: 'recentActivity',
        keyOf: (row) => {
            const entity = (row as { entity?: unknown } | null)?.entity;
            if (typeof entity !== 'string') return null;
            return ACTIVITY_ENTITY_DOMAIN[entity] ?? null;
        },
    },
];
