/**
 * Control DTOs — mirrors the shapes returned by ControlRepository.list() and .getById()
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema, UserRefShortSchema } from './common';

// ─── Control List Item ───
// Returned by ControlRepository.list() → includes owner + _count

export const ControlListItemDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string().nullable(),
    code: z.string().nullable(),
    annexId: z.string().nullable(),
    name: z.string(),
    category: z.string().nullable(),
    status: z.string(),
    applicability: z.string(),
    frequency: z.string().nullable(),
    ownerUserId: z.string().nullable(),
    createdByUserId: z.string().nullable().optional(),
    evidenceSource: z.string().nullable().optional(),
    automationKey: z.string().nullable().optional(),
    automationType: z.string().nullable().optional(),
    mitigationType: z.string().nullable().optional(),
    // RQ3-8 — annual cost in the tenant's currency. Null until an
    // owner prices it; the ROI surface returns a typed `NO_COST`
    // gap rather than fabricating a number.
    annualCost: z.number().nullable().optional(),
    effectiveness: z.number().nullable().optional(),
    isCustom: z.boolean().optional(),
    lastTested: z.string().nullable().optional(),
    nextDueAt: z.string().nullable().optional(),
    applicabilityJustification: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    owner: UserRefSchema.nullable().optional(),
    _count: z.object({
        // EP-3 — Evidence entities reach the control through the join.
        evidenceControlLinks: z.number().optional(),
        risks: z.number().optional(),
        assets: z.number().optional(),
        // Unified linked-Task total for the control (TaskLink CONTROL link
        // OR the direct `Task.controlId` FK). Overridden into `_count` by
        // `getControlHeader` so the Tasks-tab badge matches the tab body.
        controlTasks: z.number().optional(),
        evidenceLinks: z.number().optional(),
        contributors: z.number().optional(),
        // #102 item 1 — the control detail header's tab badge for
        // Mappings reads this count off the page-data payload.
        frameworkMappings: z.number().optional(),
    }).optional(),
}).passthrough().openapi('ControlListItem', {
    description: 'Control as it appears in list views — summary fields plus aggregate counts. The detail endpoint returns ControlDetail with the full include shape.',
});

export type ControlListItemDTO = z.infer<typeof ControlListItemDTOSchema>;

// ─── Sub-types for Control Detail ───

export const EvidenceLinkDTOSchema = z.object({
    id: z.string(),
    kind: z.string(),
    fileId: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    createdBy: UserRefShortSchema.nullable().optional(),
}).passthrough();
export type EvidenceLinkDTO = z.infer<typeof EvidenceLinkDTOSchema>;

export const RiskLinkDTOSchema = z.object({
    id: z.string(),
    risk: z.object({
        id: z.string(),
        title: z.string(),
        inherentScore: z.number().nullable().optional(),
    }).passthrough(),
}).passthrough();
export type RiskLinkDTO = z.infer<typeof RiskLinkDTOSchema>;

export const PolicyLinkDTOSchema = z.object({
    id: z.string(),
    policy: z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
    }).passthrough(),
}).passthrough();
export type PolicyLinkDTO = z.infer<typeof PolicyLinkDTOSchema>;

export const FrameworkMappingDTOSchema = z.object({
    id: z.string(),
    fromRequirementId: z.string().optional(),
    // Per-framework applicability override on the link (null/absent = inherit
    // the control's global Control.applicability).
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']).nullable().optional(),
    applicabilityJustification: z.string().nullable().optional(),
    fromRequirement: z.object({
        id: z.string(),
        code: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        section: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        framework: z.object({
            name: z.string(),
        }).optional(),
    }).nullable().optional(),
}).passthrough();
export type FrameworkMappingDTO = z.infer<typeof FrameworkMappingDTOSchema>;

export const ContributorDTOSchema = z.object({
    id: z.string(),
    user: UserRefSchema,
}).passthrough();
export type ContributorDTO = z.infer<typeof ContributorDTOSchema>;

// ─── Control Detail ───
// Returned by ControlRepository.getById() — full entity with relations

export const ControlDetailDTOSchema = ControlListItemDTOSchema.extend({
    // Internal-controls import — surfaced on the detail Overview (objective,
    // successCriteria) + Tests (testingMethodology) tabs.
    objective: z.string().nullable().optional(),
    successCriteria: z.string().nullable().optional(),
    testingMethodology: z.string().nullable().optional(),
    createdBy: UserRefSchema.nullable().optional(),
    applicabilityDecidedBy: UserRefSchema.nullable().optional(),
    contributors: z.array(ContributorDTOSchema).optional(),
    evidenceLinks: z.array(EvidenceLinkDTOSchema).optional(),
    evidence: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    risks: z.array(RiskLinkDTOSchema).optional(),
    policyLinks: z.array(PolicyLinkDTOSchema).optional(),
    frameworkMappings: z.array(FrameworkMappingDTOSchema).optional(),
}).openapi('ControlDetail', {
    description: 'Control with all relations included — contributors, evidence links, mapped risks/policies, and framework requirement mappings. Returned by GET /controls/{id}. Tasks are the unified Task model, fetched via GET /tasks?linkedEntityType=CONTROL.',
});
export type ControlDetailDTO = z.infer<typeof ControlDetailDTOSchema>;

// ─── Dashboard Metrics ───
// Returned by getControlDashboard()

export const ControlDashboardDTOSchema = z.object({
    totalControls: z.number(),
    statusDistribution: z.record(z.string(), z.number()),
    applicabilityDistribution: z.object({
        applicable: z.number(),
        notApplicable: z.number(),
    }),
    overdueTasks: z.number(),
    controlsDueSoon: z.number(),
    topOwners: z.array(z.object({
        id: z.string(),
        name: z.string(),
        openTasks: z.number(),
    })),
    implementationProgress: z.number(),
    implementedCount: z.number(),
    applicableCount: z.number(),
    /** Tenant-wide count of controls with no coverage-qualifying evidence. */
    controlsMissingEvidence: z.number(),
}).openapi('ControlDashboard', {
    description: 'Aggregate metrics for the control dashboard view — counts, distributions, top-owner leaderboard, and implementation-progress percentage.',
});
export type ControlDashboardDTO = z.infer<typeof ControlDashboardDTOSchema>;

// ─── Consistency Check ───

export const ConsistencyCheckDTOSchema = z.object({
    totalControls: z.number(),
    issues: z.object({
        missingCode: z.array(z.object({ id: z.string(), name: z.string() })),
        duplicateCodes: z.array(z.object({ code: z.string(), controlIds: z.array(z.string()) })),
        overdueTasks: z.array(z.object({
            controlId: z.string(),
            controlCode: z.string().nullable(),
            taskId: z.string(),
            taskTitle: z.string(),
            dueAt: z.string().nullable(),
            status: z.string(),
        })),
    }),
    summary: z.object({
        missingCodeCount: z.number(),
        duplicateCodeCount: z.number(),
        overdueTaskCount: z.number(),
    }),
});
export type ConsistencyCheckDTO = z.infer<typeof ConsistencyCheckDTOSchema>;
