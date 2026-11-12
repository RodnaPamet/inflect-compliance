/**
 * Every governed domain's audit rows are filtered out of `get_tenant_context`'s
 * recent-activity feed for a principal forbidden that domain (#5371).
 *
 * `TENANT_CONTEXT_ROW_REDACTION` keeps a row whose `entity` it does not
 * recognise, on purpose — so the mapping is safe only if it names every entity
 * a governed domain writes. The Prisma audit extension writes the MODEL name,
 * so that population is a set of models, and it is derived here from the
 * schema rather than listed: a model added to a governed domain fails this
 * suite until it is mapped, or declared ungoverned with a reason. Before #5371
 * the map held the roots alone, and `RiskTreatmentPlan`, `TaskComment`,
 * `ControlTestRun` and every other child passed unredacted.
 */
import fs from 'node:fs';

import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { makeRequestContext } from '../helpers/make-context';
import {
    getPermissionsForRole,
    mayReadAgentActivity,
    mayReadAgentInventory,
    type PermissionSet,
} from '@/lib/permissions';
import { applyRedaction, applyRowRedaction, type McpInvocation } from '@/lib/mcp/authorize';
import {
    ACTIVITY_DOMAIN_ENTITIES,
    ACTIVITY_ENTITY_UNGOVERNED,
    ACTIVITY_KEY_SETS,
    EXECUTIVE_DASHBOARD_REDACTION,
    TENANT_CONTEXT_REDACTION,
    TENANT_CONTEXT_ROW_REDACTION,
    activityEntityKey,
    normaliseActivityEntity,
} from '@/lib/mcp/tools/dashboard-redaction';

/** Each governed root model and the view key its domain's rows require. */
const GOVERNED_ROOTS: Readonly<Record<string, string>> = {
    Risk: 'risks.view',
    Control: 'controls.view',
    Evidence: 'evidence.view',
    Policy: 'policies.view',
    Task: 'tasks.view',
    // The findings register's own key (#4574), not audits.view (#5384).
    Finding: 'findings.view',
    Audit: 'audits.view',
    AccessReview: 'access_reviews.view',
    Vendor: 'vendors.view',
    Asset: 'assets.view',
    Incident: 'incidents.view',
    Employee: 'personnel.view',
};

/** The governed domains' own schema files (prisma/schema/README.md). */
const GOVERNED_SCHEMA_FILES = [
    'risk', 'controls', 'evidence', 'policy', 'tasks', 'assets', 'personnel',
    'findings', 'incidents', 'vendor', 'audit-workflow', 'agentic',
];

/**
 * Models named for a governed root that are nevertheless AGENT-REGISTER data
 * (#5384): they exist only for AGENT access-review campaigns, whose packs,
 * narrowings and samples CLAUDE.md ("Agent recertification") narrows to a
 * register reader. They take the inventory read, not the root's key.
 */
const REGISTER_DATA_UNDER_A_ROOT = [
    'AccessReviewAgentPack', 'AccessReviewAgentNarrowing', 'AccessReviewDecisionSampleAudit',
];

const modelNames = new Set(parseSchemaModels().map((m) => m.name));

function modelsDeclaredIn(file: string): string[] {
    const [abs] = repoFiles({ under: 'prisma/schema', extensions: ['.prisma'] })
        .filter((f) => f.endsWith(`/${file}.prisma`));
    expect(abs).toBeDefined();
    return [...fs.readFileSync(abs, 'utf8').matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

const rootOf = (model: string): string | undefined =>
    Object.keys(GOVERNED_ROOTS)
        .filter((root) => model.startsWith(root))
        .sort((a, b) => b.length - a.length)[0];

/** Every model of the agent register: its schema file, plus any `Agent*` model elsewhere. */
const agentModels = new Set<string>([
    ...modelsDeclaredIn('agentic'),
    ...[...modelNames].filter((m) => m.startsWith('Agent')),
    ...REGISTER_DATA_UNDER_A_ROOT,
]);

const population = new Set<string>([
    ...[...modelNames].filter((m) => rootOf(m) !== undefined),
    ...GOVERNED_SCHEMA_FILES.flatMap(modelsDeclaredIn),
    ...agentModels,
]);

/** Literal `entityType: '<X>'` values in src — what `logEvent` callers write. */
function entityTypeLiterals(): Map<string, string> {
    const out = new Map<string, string>();
    for (const abs of repoFiles({ under: 'src', extensions: ['.ts'] })) {
        for (const m of fs.readFileSync(abs, 'utf8').matchAll(/\bentityType:\s*['"]([A-Za-z_]+)['"]/g)) {
            if (!out.has(m[1])) out.set(m[1], repoRelative(abs));
        }
    }
    return out;
}

describe('recent-activity entity → domain view key', () => {
    it('the population is real: every root is a model, and the derivation finds the children', () => {
        for (const root of Object.keys(GOVERNED_ROOTS)) expect(modelNames.has(root)).toBe(true);
        // Anti-vacuity: the children #5371 named are inside the population.
        for (const child of ['RiskTreatmentPlan', 'TaskComment', 'ControlException', 'ControlTestRun', 'EvidenceReview']) {
            expect(population.has(child)).toBe(true);
        }
        expect(population.size).toBeGreaterThan(100);
    });

    it('every model of a governed domain is mapped, or declared ungoverned with a reason', () => {
        const unclassified = [...population]
            .filter((m) => activityEntityKey(m) === null && !(m in ACTIVITY_ENTITY_UNGOVERNED))
            .sort();
        expect(unclassified).toEqual([]);
    });

    it('a model named for a governed root requires THAT root\'s key', () => {
        const wrong = [...population]
            .filter((m) => rootOf(m) !== undefined && !(m in ACTIVITY_ENTITY_UNGOVERNED))
            .filter((m) => !REGISTER_DATA_UNDER_A_ROOT.includes(m))
            .filter((m) => activityEntityKey(m) !== GOVERNED_ROOTS[rootOf(m)!])
            .map((m) => `${m} → ${activityEntityKey(m)} (expected ${GOVERNED_ROOTS[rootOf(m)!]})`);
        expect(wrong).toEqual([]);
    });

    it('nothing is both mapped and declared ungoverned, and nothing is mapped twice', () => {
        expect(Object.keys(ACTIVITY_ENTITY_UNGOVERNED).filter((e) => activityEntityKey(e) !== null)).toEqual([]);
        const seen = new Map<string, string>();
        const twice: string[] = [];
        for (const [key, entities] of Object.entries(ACTIVITY_DOMAIN_ENTITIES)) {
            for (const e of entities) {
                const n = normaliseActivityEntity(e);
                if (seen.has(n)) twice.push(`${e} (${seen.get(n)} and ${key})`);
                seen.set(n, key);
            }
        }
        expect(twice).toEqual([]);
    });

    it('no stale entries: every listed name is a model or an entity string src writes', () => {
        const literals = new Set([...entityTypeLiterals().keys()].map(normaliseActivityEntity));
        const listed = [
            ...Object.values(ACTIVITY_DOMAIN_ENTITIES).flat(),
            ...Object.keys(ACTIVITY_ENTITY_UNGOVERNED),
        ];
        const stale = listed.filter((e) => !modelNames.has(e) && !literals.has(normaliseActivityEntity(e)));
        expect(stale).toEqual([]);
        for (const ungoverned of Object.keys(ACTIVITY_ENTITY_UNGOVERNED)) {
            expect(population.has(ungoverned)).toBe(true);
        }
    });

    it('every logEvent entity string naming a governed root resolves to a key', () => {
        const roots = Object.keys(GOVERNED_ROOTS).map((r) => r.toLowerCase());
        const unmapped = [...entityTypeLiterals()]
            .filter(([literal]) => roots.some((r) => normaliseActivityEntity(literal).startsWith(r)))
            .filter(([literal]) => activityEntityKey(literal) === null && !(literal in ACTIVITY_ENTITY_UNGOVERNED))
            .map(([literal, file]) => `${literal} (${file})`);
        expect(unmapped).toEqual([]);
    });

    it('resolves every spelling of one entity to the same key', () => {
        expect(activityEntityKey('RiskTreatmentPlan')).toBe('risks.view');
        expect(activityEntityKey('RISK_TREATMENT_PLAN')).toBe('risks.view');
        expect(activityEntityKey('TREATMENT_MILESTONE')).toBe('risks.view');
        expect(activityEntityKey('TEST_RUN')).toBe('controls.view');
        expect(activityEntityKey('File')).toBe('evidence.view');
        expect(activityEntityKey('TenantMembership')).toBeNull();
    });
});

describe('the grounding feed, filtered for a risk-blind principal', () => {
    const riskBlind = {
        ctx: makeRequestContext('ADMIN', {
            appPermissions: {
                ...getPermissionsForRole('ADMIN'),
                risks: { view: false, create: false, edit: false },
            },
        }),
    } as unknown as McpInvocation;

    const feed = {
        stats: {},
        recentActivity: [
            { entity: 'RiskTreatmentPlan', action: 'CREATE' },
            { entity: 'RISK_TREATMENT_PLAN', action: 'TREATMENT_PLAN_CREATED' },
            { entity: 'TreatmentMilestone', action: 'UPDATE' },
            { entity: 'Control', action: 'CREATE' },
            { entity: 'TaskComment', action: 'CREATE' },
            { entity: 'TenantMembership', action: 'UPDATE' },
        ],
    };

    it('gets no RiskTreatmentPlan row, in either spelling, and keeps every other domain', () => {
        const out = applyRowRedaction(riskBlind, TENANT_CONTEXT_ROW_REDACTION, feed) as typeof feed;
        expect(out.recentActivity.map((r) => r.entity)).toEqual(['Control', 'TaskComment', 'TenantMembership']);
    });

    it('a principal holding risks.view keeps them', () => {
        const owner = { ctx: makeRequestContext('OWNER') } as unknown as McpInvocation;
        const out = applyRowRedaction(owner, TENANT_CONTEXT_ROW_REDACTION, feed) as typeof feed;
        expect(out.recentActivity).toHaveLength(feed.recentActivity.length);
    });
});

/** An invocation acting with `perms`. */
const actingAs = (perms: PermissionSet): McpInvocation =>
    ({ ctx: makeRequestContext('ADMIN', { appPermissions: perms }) }) as unknown as McpInvocation;

const roleInv = (role: string): McpInvocation =>
    ({ ctx: makeRequestContext(role) }) as unknown as McpInvocation;

const entitiesSeenBy = (inv: McpInvocation, entities: readonly string[]): string[] =>
    (applyRowRedaction(inv, TENANT_CONTEXT_ROW_REDACTION, {
        stats: {},
        recentActivity: entities.map((entity) => ({ entity, action: 'UPDATE' })),
    }) as { recentActivity: Array<{ entity: string }> }).recentActivity.map((r) => r.entity);

describe('agent-register rows (#5384)', () => {
    it('the population is real: the register\'s own models are in it', () => {
        for (const m of ['RegisteredAgent', 'RegisteredAgentTool', 'AgentPolicyCard', 'AgentKillSwitch',
            'AgentProfile', 'AgentHarnessScan', 'DiscoveredAgent', 'PeerAgent', 'AgentOwnershipTransfer',
            'AgentActionReceipt']) {
            expect(agentModels.has(m)).toBe(true);
        }
        expect(agentModels.size).toBeGreaterThan(50);
    });

    it('every agent-register model requires an agent-governance read, never nothing', () => {
        const AGENT_KEY_SETS = Object.values(ACTIVITY_KEY_SETS ?? {}) as ReadonlyArray<readonly string[]>;
        const wrong = [...agentModels]
            .map((m) => [m, activityEntityKey(m)] as const)
            .filter(([, key]) => !(
                (Array.isArray(key) && AGENT_KEY_SETS.some((set) => JSON.stringify(set) === JSON.stringify(key)))
                || (typeof key === 'string' && key.startsWith('admin.'))
            ))
            .map(([m, key]) => `${m} → ${JSON.stringify(key)}`);
        expect(wrong).toEqual([]);
    });

    it('the inventory set IS mayReadAgentInventory, and the activity set IS mayReadAgentActivity', () => {
        for (const view of [false, true]) {
            for (const registry of [false, true]) {
                for (const adminView of [false, true]) {
                    const admin = {
                        ...getPermissionsForRole('READER').admin,
                        view: adminView, agent_registry: registry, agent_registry_view: view,
                    };
                    const perms = { ...getPermissionsForRole('READER'), admin };
                    const seen = entitiesSeenBy(actingAs(perms), ['RegisteredAgent', 'WorkflowRun']);
                    expect(seen.includes('RegisteredAgent')).toBe(mayReadAgentInventory(admin));
                    expect(seen.includes('WorkflowRun')).toBe(mayReadAgentActivity(admin));
                }
            }
        }
    });

    it('resolves every spelling of an agent entity', () => {
        expect(activityEntityKey('RegisteredAgent')).toEqual(ACTIVITY_KEY_SETS.agentInventory);
        expect(activityEntityKey('AGENT_HARNESS_ACCEPTANCE')).toEqual(ACTIVITY_KEY_SETS.agentInventory);
        expect(activityEntityKey('PeerAgent')).toEqual(ACTIVITY_KEY_SETS.agentInventory);
        expect(activityEntityKey('WorkflowRun')).toEqual(ACTIVITY_KEY_SETS.agentActivity);
        expect(activityEntityKey('AgentProposal')).toEqual(ACTIVITY_KEY_SETS.agentActivity);
        expect(activityEntityKey('TenantSkillVersion')).toBe('admin.agent_registry');
    });

    const registerFeed = [
        'RegisteredAgent', 'RegisteredAgentTool', 'AgentPolicyCardVersion', 'AgentKillSwitch',
        'AgentProfileVersion', 'AgentHarnessScan', 'DiscoveredAgent', 'PeerAgent',
        'AgentOwnershipTransfer', 'AgentActionReceipt', 'AccessReviewAgentPack', 'WorkflowRun',
    ];

    it.each(['READER', 'EDITOR'])('a %s principal sees no agent-register row', (role) => {
        const seen = entitiesSeenBy(roleInv(role), [...registerFeed, 'Control', 'TenantMembership']);
        // Anti-vacuity: the rows that carry no agent data survive.
        expect(seen).toEqual(['Control', 'TenantMembership']);
    });

    it('an AUDITOR — who holds the inventory view key — sees them', () => {
        expect(entitiesSeenBy(roleInv('AUDITOR'), registerFeed)).toEqual(registerFeed);
    });

    it('a custom role carrying the register key without the view key keeps them (the second term)', () => {
        const reader = getPermissionsForRole('READER');
        const perms = { ...reader, admin: { ...reader.admin, agent_registry: true, agent_registry_view: false } };
        expect(entitiesSeenBy(actingAs(perms), ['RegisteredAgent', 'PeerAgent'])).toEqual(['RegisteredAgent', 'PeerAgent']);
    });
});

describe('access-review rows (#5384)', () => {
    it('the shared campaign models take access_reviews.view; the AGENT-only ones the register read', () => {
        for (const m of ['AccessReview', 'AccessReviewDecision', 'AccessReviewConnectedDecision', 'ACCESS_REVIEW']) {
            expect(activityEntityKey(m)).toBe('access_reviews.view');
        }
        for (const m of REGISTER_DATA_UNDER_A_ROOT) {
            expect(activityEntityKey(m)).toEqual(ACTIVITY_KEY_SETS.agentInventory);
        }
    });

    it('a READER keeps the campaign row and loses the agent pack', () => {
        expect(entitiesSeenBy(roleInv('READER'), ['AccessReview', 'AccessReviewAgentPack']))
            .toEqual(['AccessReview']);
    });

    it('a principal forbidden access reviews loses every campaign row', () => {
        const owner = getPermissionsForRole('OWNER');
        const perms = { ...owner, access_reviews: { ...owner.access_reviews, view: false } };
        expect(entitiesSeenBy(actingAs(perms), ['AccessReview', 'AccessReviewConnectedDecision', 'Control']))
            .toEqual(['Control']);
    });
});

describe('findings follow findings.view (#5384)', () => {
    const owner = getPermissionsForRole('OWNER');
    const findingsBlind = { ...owner, findings: { ...owner.findings, view: false } };
    const auditsBlind = { ...owner, audits: { ...owner.audits, view: false } };

    it('every finding spelling requires findings.view', () => {
        for (const m of ['Finding', 'FindingAsset', 'FindingEvidence', 'FindingRisk', 'FINDING']) {
            expect(activityEntityKey(m)).toBe('findings.view');
        }
    });

    it('a findings-blind principal loses the finding rows and keeps the audit rows; an audits-blind one the reverse', () => {
        const feed = ['Finding', 'FindingRisk', 'Audit', 'AuditCycle'];
        expect(entitiesSeenBy(actingAs(findingsBlind), feed)).toEqual(['Audit', 'AuditCycle']);
        expect(entitiesSeenBy(actingAs(auditsBlind), feed)).toEqual(['Finding', 'FindingRisk']);
    });

    it.each([
        ['get_tenant_context', TENANT_CONTEXT_REDACTION],
        ['get_compliance_posture', EXECUTIVE_DASHBOARD_REDACTION],
    ] as const)('%s: the open-findings count is the findings register\'s', (_tool, rules) => {
        const payload = { stats: { openFindings: 4, controls: 9 } };
        const blind = applyRedaction(actingAs(findingsBlind), rules, payload) as {
            stats: Record<string, number>; redactedDomains?: string[];
        };
        expect(blind.stats).not.toHaveProperty('openFindings');
        expect(blind.redactedDomains).toContain('findings.view');

        const kept = applyRedaction(actingAs(auditsBlind), rules, payload) as { stats: Record<string, number> };
        expect(kept.stats.openFindings).toBe(4);
    });
});
