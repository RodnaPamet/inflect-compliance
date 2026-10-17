/**
 * What a Flue agent can be taught (#3470), for the read-only Skills tab.
 *
 * A projection of the on-disk corpus onto the fields an assessor reads: the
 * skill, what it is for, where it came from and under what licence. The
 * instructions themselves are NOT returned — they are prompt text, they are
 * long, and the tab's question is "what did the agent know", which the name,
 * description and provenance answer. A reader who wants the procedure reads
 * the file in the repository, which is the point of keeping them as Markdown.
 */
import { loadAllSkills, MAX_CATALOG_BYTES } from '@/lib/agentic/flue/skills';
import { workflowCatalogs } from '@/lib/agentic/flue/skills/resolve';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import type { RequestContext } from '@/app-layer/types';

export interface AgentSkillSummary {
    name: string;
    description: string;
    license: string;
    /** Provenance from the Agent Skills `metadata` map — may be absent. */
    sourceRef: string | null;
    version: string | null;
    /** Workflow keys whose definition declares this skill. Possibly empty. */
    declaredBy: string[];
    /** Bytes this skill costs ONLY when the model activates it. */
    instructionBytes: number;
}

export interface AgentSkillsPayload {
    skills: AgentSkillSummary[];
    /**
     * The always-present cost of the most expensive WORKFLOW: what its declared
     * skills add to every system prompt on every turn. The budget binds per
     * workflow and per run, not across the corpus (owner decision, 2026-10-17),
     * so the honest figure is the largest one any run pays. Zero while no
     * workflow declares a skill.
     */
    catalogBytes: number;
    catalogBudgetBytes: number;
}

export function listAgentSkills(_ctx: RequestContext): AgentSkillsPayload {
    const defs = listWorkflowDefinitions();
    const skills = loadAllSkills();
    return {
        skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            license: s.license,
            sourceRef: s.metadata.sourceRef ?? null,
            version: s.metadata.version ?? null,
            declaredBy: defs.filter((d) => (d.skills ?? []).includes(s.name)).map((d) => d.key).sort(),
            instructionBytes: Buffer.byteLength(s.instructions, 'utf8'),
        })),
        catalogBytes: Math.max(0, ...workflowCatalogs(defs).map((w) => w.bytes)),
        catalogBudgetBytes: MAX_CATALOG_BYTES,
    };
}
