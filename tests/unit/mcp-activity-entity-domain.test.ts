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
import { getPermissionsForRole } from '@/lib/permissions';
import { applyRowRedaction, type McpInvocation } from '@/lib/mcp/authorize';
import {
    ACTIVITY_DOMAIN_ENTITIES,
    ACTIVITY_ENTITY_UNGOVERNED,
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
    Finding: 'audits.view',
    Audit: 'audits.view',
    Vendor: 'vendors.view',
    Asset: 'assets.view',
    Incident: 'incidents.view',
    Employee: 'personnel.view',
};

/** The governed domains' own schema files (prisma/schema/README.md). */
const GOVERNED_SCHEMA_FILES = [
    'risk', 'controls', 'evidence', 'policy', 'tasks', 'assets', 'personnel',
    'findings', 'incidents', 'vendor', 'audit-workflow',
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

const population = new Set<string>([
    ...[...modelNames].filter((m) => rootOf(m) !== undefined),
    ...GOVERNED_SCHEMA_FILES.flatMap(modelsDeclaredIn),
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
