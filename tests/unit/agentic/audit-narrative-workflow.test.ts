/**
 * The audit narrative workflow and its skill (#3749), against the SHIPPED
 * corpus, the real registry and the real gate. Hardening items of the issue:
 *
 *   • THE WORKFLOW MOUNTS THE SKILL ONLY WITH A PASSING RECORD — the mount gate
 *     on the committed `evaluation-record.json`, and the resolver a run uses
 *     pinning exactly that skill by name, version and hash.
 *   • IT CANNOT WRITE A WORKPAPER OR CLOSE A FINDING — every step it declares
 *     reads, it declares `readOnly` (so the Flue engine withholds the propose
 *     surface, `flue-tools-adapter.test.ts`), and the one non-read tool the
 *     auditor's remit holds is `propose_finding`, which proposes and decides
 *     nothing.
 *   • THE SKILL NAMES EVERY EXCEPTION CODE THE LIBRARY RECORDS — the drift that
 *     kept version 1 from passing: a model told what an attribute tests but not
 *     its code writes a label of its own.
 */
import { loadSkillCorpus, type LoadedSkill } from '@/lib/agentic/flue/skills';
import { scanSkillText } from '@/lib/agentic/flue/skills/text-scan';
import { checkSkillMountable } from '@/lib/agentic/flue/skills/mount-gate';
import { skillContentHash } from '@/lib/agentic/flue/skills/evaluation-record';
import { resetSkillCache, resolveSkillPins, resolveSkillsFor } from '@/lib/agentic/flue/skills/resolve';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { AUDIT_NARRATIVE_SKILLS, auditNarrativeWorkflow } from '@/lib/agentic/workflows/audit-narrative';
import { AUDITOR_TOOL_REMIT, EXCEPTION_SEVERITY } from '@/lib/agentic/audit-procedure-library';
import { NARRATIVE_SKILL } from '@/lib/agentic/audit-narrative';
import { MCP_READ_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import type { ReadStepDef } from '@/lib/agentic/workflow-types';

const corpus = loadSkillCorpus();
const skillOf = (name: string): LoadedSkill => {
    const s = corpus.skills.find((x) => x.name === name);
    if (!s) throw new Error(`${name} is not a loaded skill`);
    return s;
};

beforeEach(() => resetSkillCache());

describe('the workflow', () => {
    it('is registered under its key, asks for Flue, and declares exactly the narrative skill', () => {
        expect(getWorkflowDefinition('audit-narrative')).toBe(auditNarrativeWorkflow);
        expect(auditNarrativeWorkflow.driver).toBe('flue');
        expect([...(auditNarrativeWorkflow.skills ?? [])]).toEqual([NARRATIVE_SKILL]);
        expect([...AUDIT_NARRATIVE_SKILLS]).toEqual([NARRATIVE_SKILL]);
        expect([...(auditNarrativeWorkflow.requiredInput ?? [])]).toEqual(['periodLabel']);
    });

    it('is read-only: it declares readOnly, no PROPOSE step, and only read tools', () => {
        expect(auditNarrativeWorkflow.readOnly).toBe(true);
        expect(auditNarrativeWorkflow.steps.map((s) => s.kind)).toEqual(['READ', 'SYNTHESIS']);
        const tools = auditNarrativeWorkflow.steps.filter((s): s is ReadStepDef => s.kind === 'READ').map((s) => s.tool);
        expect(tools).toEqual(['list_audit_workpapers']);
        for (const t of tools) expect(MCP_READ_TOOL_NAMES).toContain(t);
    });

    it('the one tool beyond reading that an auditor may hold proposes, and readOnly withholds it', () => {
        const nonRead = [...AUDITOR_TOOL_REMIT].filter((t) => !(MCP_READ_TOOL_NAMES as readonly string[]).includes(t));
        expect(nonRead).toEqual(['propose_finding']);
    });

    it('its synthesis states counts and no narrative', () => {
        const synthesis = auditNarrativeWorkflow.steps[1];
        if (synthesis.kind !== 'SYNTHESIS') throw new Error('expected a synthesis step');
        const out = synthesis.synthesize({
            input: { periodLabel: '2027-03' },
            outputs: { workpapers: { workpapers: [{ narrated: true }, { narrated: false }], truncated: false } },
        } as never);
        expect(out).toMatchObject({ data: { workpapers: 2, notNarrated: 1, truncated: false } });
        expect(out.text).toContain('No narrative is written here');
    });
});

describe('the skill', () => {
    const skill = () => skillOf(NARRATIVE_SKILL);

    it('loads, the text scan refuses none of it, and it declares the read tool it names', () => {
        expect(corpus.refused.map((r) => r.name)).not.toContain(NARRATIVE_SKILL);
        const tools = (skill().metadata.tools ?? '').split(',').map((t) => t.trim());
        expect(tools).toEqual(expect.arrayContaining(['list_audit_workpapers', 'propose_finding']));
        expect(
            scanSkillText({ description: skill().description, instructions: skill().instructions, declaredTools: tools }),
        ).toEqual({ rules: [], guardRules: [] });
    });

    it('names every exception code the procedure library records', () => {
        const missing = Object.keys(EXCEPTION_SEVERITY).filter((code) => !skill().instructions.includes(`\`${code}\``));
        expect(missing).toEqual([]);
    });

    it('passes the mount gate on its committed evaluation record, and a run pins exactly it', () => {
        const s = skill();
        const pin = { name: NARRATIVE_SKILL, version: s.metadata.version, contentHash: skillContentHash(s.instructions) };
        expect(checkSkillMountable(s)).toEqual({ ok: true, pin });
        expect(resolveSkillsFor(auditNarrativeWorkflow.skills).map((d) => d.name)).toEqual([NARRATIVE_SKILL]);
        expect(resolveSkillPins(auditNarrativeWorkflow.skills)).toEqual([pin]);
    });
});
