/**
 * The skill mount a conformance adapter hands its engine (Step 2d).
 *
 * The adapters cannot reach a database, so each replaces the one read
 * `resolveRunSkillMount` makes. This stands in for that READ only: the run's
 * shipped skill names and tenant-authored versions go through the real
 * resolver, `resolveRunSkills`, which applies the real mount gate, text scan
 * and catalogue budget. A skill the gate refuses throws here exactly as it
 * would in production, and the engine settles the run.
 */
import { skillContentHash } from '@/lib/agentic/flue/skills/evaluation-record';
import { resolveRunSkills, type RunSkillMount } from '@/lib/agentic/flue/skills/resolve';
import type { TenantSkillVersionForMount } from '@/lib/agentic/flue/skills/tenant-skill';

import type { ConformanceRun, ConformanceTenantSkill } from './driver-conformance';

/** A tenant skill as an approved version: approved by a second person, hashes consistent. */
function approvedVersion(skill: ConformanceTenantSkill): TenantSkillVersionForMount {
    const hash = skillContentHash(skill.instructions);
    return {
        versionId: `tsv-${skill.name}`,
        name: skill.name,
        version: 1,
        description: skill.description,
        instructions: skill.instructions,
        license: 'Conformance fixture',
        sourceRef: 'Conformance fixture',
        requiredInput: null,
        output: null,
        controls: null,
        tools: null,
        workflowKeys: [],
        status: 'APPROVED',
        contentHash: hash,
        authorUserId: 'user-author',
        approvedByUserId: 'user-reviewer',
        approvedContentHash: hash,
        evaluationRecordJson: null,
    };
}

export function conformanceSkillMount(skills: ConformanceRun['skills']): RunSkillMount {
    return resolveRunSkills(skills?.repository ?? [], (skills?.tenant ?? []).map(approvedVersion));
}
