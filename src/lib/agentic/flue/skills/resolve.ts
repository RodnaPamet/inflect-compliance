/**
 * Resolve a workflow definition's declared skill names into the documents the
 * run binding carries (#3470).
 *
 * SEPARATE FROM THE LOADER so the agent module never reaches it. `index.ts`
 * touches `node:fs`; this file is what the driver calls, on the ordinary-Node
 * side of the boundary described in `agent.ts`. The agent receives the result.
 *
 * FAIL-CLOSED ON AN UNKNOWN NAME. A definition that asks for a skill the
 * corpus does not ship is a configuration error, and the alternative — drop it
 * and carry on — would give a run quietly less expertise than its definition
 * claims, which is the shape of defect that shows up as a bad answer rather
 * than as a failure.
 *
 * FAIL-CLOSED ON A REFUSED NAME, TOO (#3667), and with its own refusal. A skill
 * the text scan refused is on disk and is not mountable; a run that declares it
 * stops with `SkillTextRefusedError` naming the rule ids, so the operator reads
 * "refused" rather than the "not shipped" an unknown name gets.
 */
import {
    loadSkillCorpus,
    assertCatalogWithinBudget,
    catalogBytes,
    SkillLoadError,
    SkillTextRefusedError,
    type LoadedSkill,
    type SkillCorpus,
} from './index';
import type { FlueSkillDocument } from '../run-binding';

/** Cached: the corpus is read-only files, and re-reading per run buys nothing. */
let corpus: SkillCorpus | null = null;

function shippedCorpus(): SkillCorpus {
    if (!corpus) corpus = loadSkillCorpus();
    return corpus;
}

/** The loaded skill of this name, or a refusal naming why it cannot be had. */
function lookup(c: SkillCorpus, name: string, unknownReason: string): LoadedSkill {
    const skill = c.skills.find((s) => s.name === name);
    if (skill) return skill;
    const refused = c.refused.find((r) => r.name === name);
    if (refused) throw new SkillTextRefusedError(name, refused.rules, refused.guardRules);
    throw new SkillLoadError(name, unknownReason);
}

export function resolveSkillsFor(declared: readonly string[] | undefined): FlueSkillDocument[] {
    if (!declared || declared.length === 0) return [];
    const c = shippedCorpus();
    const resolved: FlueSkillDocument[] = [];
    for (const name of declared) {
        const skill = lookup(c, name, 'declared by a workflow definition but not in the shipped corpus');
        resolved.push({ name: skill.name, description: skill.description, instructions: skill.instructions });
    }
    // The per-turn cost of THIS run's catalog, not the whole corpus's. A
    // definition mounting every skill pays for every one on every turn.
    assertCatalogWithinBudget(resolved.map((r) => ({ ...r, license: '', metadata: {} })));
    return resolved;
}

/** Test seam: drop the cache so a suite can vary the corpus. */
export function resetSkillCache(): void {
    corpus = null;
}

/** The fields of a workflow definition this module reads. */
export interface DeclaresSkills {
    readonly key: string;
    readonly skills?: readonly string[];
}

export interface WorkflowCatalog {
    readonly key: string;
    /** What every turn of a run of this workflow pays for its mountable skills. */
    readonly bytes: number;
    /** Declared skills the text scan refused. A run of this workflow fails closed. */
    readonly refused: readonly string[];
}

/**
 * The always-present catalogue cost of each workflow: what every turn of a run
 * of that workflow pays for its declared skills. Fails closed on a skill the
 * corpus does not ship, exactly as a run would. A REFUSED skill is reported
 * rather than thrown, so the surface that shows refusals can still be drawn; it
 * costs nothing, because no run of that workflow gets far enough to mount it.
 */
export function workflowCatalogs(defs: readonly DeclaresSkills[]): WorkflowCatalog[] {
    const c = shippedCorpus();
    return defs.map((d) => {
        const declared: LoadedSkill[] = [];
        const refused: string[] = [];
        for (const name of d.skills ?? []) {
            if (c.refused.some((r) => r.name === name)) {
                refused.push(name);
                continue;
            }
            declared.push(lookup(c, name, `declared by workflow "${d.key}" but not in the shipped corpus`));
        }
        return { key: d.key, bytes: catalogBytes(declared), refused };
    });
}

/**
 * Every workflow's declared skills must be mountable and fit the per-turn
 * budget. The budget binds here and at run time (`resolveSkillsFor`), never on
 * the corpus as a whole: the corpus may hold more than any one prompt pays for.
 */
export function assertWorkflowCatalogsWithinBudget(defs: readonly DeclaresSkills[]): void {
    const c = shippedCorpus();
    for (const d of defs) {
        const declared: LoadedSkill[] = (d.skills ?? []).map((name) =>
            lookup(c, name, `declared by workflow "${d.key}" but not in the shipped corpus`),
        );
        assertCatalogWithinBudget(declared);
    }
}
