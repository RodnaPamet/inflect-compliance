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

/**
 * A skill the editor may offer, with the bytes its catalogue line costs every
 * prompt of a run, as the server measured it (#4523).
 */
export interface ProfileSkillOption extends ProfileSkillRef {
    catalogueBytes: number;
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
        /** The per-run catalogue budget a version's skills are held to. */
        skillCatalogueBudgetBytes: number;
    };
}

/** The refusal reason a profile route's error body carries, if any. */
export function refusalReason(body: unknown): string | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason;
    return typeof reason === 'string' ? reason : null;
}

/**
 * The figures of a `SKILL_CATALOGUE_OVER_BUDGET` refusal (#4523), which the tab
 * words itself in the reader's language, or null for any other body. Both
 * figures are the server's: the tab adds nothing up to say it.
 */
export function catalogueOverBudget(body: unknown): { catalogueBytes: number; budgetBytes: number } | null {
    if (refusalReason(body) !== 'SKILL_CATALOGUE_OVER_BUDGET') return null;
    const details = (body as { error: { details: { catalogueBytes?: unknown; budgetBytes?: unknown } } }).error.details;
    const { catalogueBytes, budgetBytes } = details;
    return typeof catalogueBytes === 'number' && typeof budgetBytes === 'number' ? { catalogueBytes, budgetBytes } : null;
}
