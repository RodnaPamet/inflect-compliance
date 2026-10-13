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
 */
import { loadAllSkills, assertCatalogWithinBudget, SkillLoadError, type LoadedSkill } from './index';
import type { FlueSkillDocument } from '../run-binding';

/** Cached: the corpus is read-only files, and re-reading per run buys nothing. */
let corpus: LoadedSkill[] | null = null;

function allSkills(): LoadedSkill[] {
    if (!corpus) corpus = loadAllSkills();
    return corpus;
}

export function resolveSkillsFor(declared: readonly string[] | undefined): FlueSkillDocument[] {
    if (!declared || declared.length === 0) return [];
    const byName = new Map(allSkills().map((s) => [s.name, s]));
    const resolved: FlueSkillDocument[] = [];
    for (const name of declared) {
        const skill = byName.get(name);
        if (!skill) {
            throw new SkillLoadError(name, 'declared by a workflow definition but not in the shipped corpus');
        }
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
