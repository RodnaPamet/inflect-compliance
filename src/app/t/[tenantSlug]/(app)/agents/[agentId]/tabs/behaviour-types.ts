/**
 * The Behaviour tab's view of an agent profile, as
 * `GET /api/t/:slug/admin/agents/:agentId/profile` returns it (Step 1b,
 * #4144). A client copy of `AgentProfileView` in
 * `usecases/agent-profiles.ts`, because a client component does not import a
 * usecase module.
 */
import type {
    ProfileEffort,
    ProfileModelTier,
    ProfileOutputKind,
    ProfileSkillOption,
    ProfileSkillRef,
    ProfileTrigger,
} from '@/lib/agentic/agent-profile';

export type ProfileVersionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'RETIRED';

export interface ProfilePerson {
    label: string | null;
    isViewer: boolean;
}

export interface ProfileVersionView {
    id: string;
    version: number;
    status: ProfileVersionStatus;
    instructions: string;
    instructionsHash: string;
    toolNames: string[];
    skillRefs: ProfileSkillRef[];
    modelTier: ProfileModelTier;
    effort: ProfileEffort;
    maxTurns: number;
    outputKind: ProfileOutputKind;
    allowedTriggers: ProfileTrigger[];
    author: ProfilePerson;
    submittedAt: string | null;
    decidedBy: ProfilePerson | null;
    decidedAt: string | null;
    rejectionReason: string | null;
    retiredAt: string | null;
    createdAt: string;
    canDecide: boolean;
}

export interface ProfileView {
    profile: { profileId: string; currentApprovedVersion: number | null; runKey: string | null } | null;
    versions: ProfileVersionView[];
    options: { tools: string[]; skills: ProfileSkillOption[] };
    /** The server's `ProfileTestRunState` (Step 2c): available, or why not. */
    testRun:
        | { available: true }
        | { available: false; reason: 'ENGINE_DOES_NOT_RUN_PROFILES'; engine: 'STATIC' | 'FLUE' }
        | { available: false; reason: 'ENGINE_NOT_IN_FORCE' }
        | { available: false; reason: 'AGENT_NOT_READY' };
    limits: {
        instructionsMaxChars: number;
        maxTurns: number;
        rejectionReasonMaxChars: number;
        skillCatalogueBudgetBytes: number;
    };
}

/** The refusal reason a profile route's error body carries, if any. */
export function refusalReason(body: unknown): string | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason;
    return typeof reason === 'string' ? reason : null;
}

/**
 * The figures of a `SKILL_CATALOGUE_OVER_BUDGET` refusal (the 409 the save and
 * the approval answer, #4589: `details.bytes` and `details.budget`), or null
 * for any other body. The tab words the refusal itself, in the reader's
 * language, from these figures; both are the server's.
 */
export function catalogueOverBudget(body: unknown): { bytes: number; budget: number } | null {
    if (refusalReason(body) !== 'SKILL_CATALOGUE_OVER_BUDGET') return null;
    const { bytes, budget } = (body as { error: { details: { bytes?: unknown; budget?: unknown } } }).error.details;
    return typeof bytes === 'number' && typeof budget === 'number' ? { bytes, budget } : null;
}
