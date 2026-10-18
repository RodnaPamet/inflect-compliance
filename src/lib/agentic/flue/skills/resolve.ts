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
 *
 * FAIL-CLOSED ON AN UNEVALUATED SKILL (#3666). A skill with no passing
 * evaluation record stops the run with `SkillNotMountableError` naming the
 * reason (`mount-gate.ts`). The gate runs once per skill per process: the files
 * it reads are part of the deployed build, like the corpus.
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
import { canonicalJson } from '@/lib/canonical-json';

import { checkSkillMountable, SkillNotMountableError, type MountedSkillPin, type MountVerdict } from './mount-gate';

/**
 * The document a run binding carries — `FlueSkillDocument` in `run-binding.ts`,
 * by shape rather than by import. `workflow-runs.ts` reaches this module to pin
 * a run's skills before its row exists, and `run-binding.ts`'s own type imports
 * lead to `@flue/runtime`, which the node project cannot load
 * (`tests/guards/flue-esm-modules-stay-off-the-static-graph.test.ts`). The two
 * cannot drift: `execute.ts` hands this module's result to `bindRun`, so `tsc`
 * checks the shapes agree.
 */
export interface ResolvedSkillDocument {
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
}

/** Cached: the corpus is read-only files, and re-reading per run buys nothing. */
let corpus: SkillCorpus | null = null;
/** Cached per skill name, for the same reason. */
const verdicts = new Map<string, MountVerdict>();

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

/** The gate's verdict on one loaded skill, cached. */
function verdictFor(skill: LoadedSkill): MountVerdict {
    let v = verdicts.get(skill.name);
    if (!v) {
        v = checkSkillMountable(skill);
        verdicts.set(skill.name, v);
    }
    return v;
}

/** A skill a run may mount, with its pin — or a refusal naming why not. */
function mountable(c: SkillCorpus, name: string, unknownReason: string): { skill: LoadedSkill; pin: MountedSkillPin } {
    const skill = lookup(c, name, unknownReason);
    const v = verdictFor(skill);
    if (!v.ok) throw new SkillNotMountableError(name, v.reason, v.detail);
    return { skill, pin: v.pin };
}

export function resolveSkillsFor(declared: readonly string[] | undefined): ResolvedSkillDocument[] {
    if (!declared || declared.length === 0) return [];
    const c = shippedCorpus();
    const resolved: ResolvedSkillDocument[] = [];
    for (const name of declared) {
        const { skill } = mountable(c, name, 'declared by a workflow definition but not in the shipped corpus');
        resolved.push({ name: skill.name, description: skill.description, instructions: skill.instructions });
    }
    // The per-turn cost of THIS run's catalog, not the whole corpus's. A
    // definition mounting every skill pays for every one on every turn.
    assertCatalogWithinBudget(resolved.map((r) => ({ ...r, license: '', metadata: {} })));
    return resolved;
}

/**
 * What a run declaring these skills will be taught, as the pin its row records
 * (#3666): name, version and content hash per skill, in declaration order. It
 * applies every refusal `resolveSkillsFor` applies, so a run that could not
 * mount its skills is refused before its row is written, not after.
 */
export function resolveSkillPins(declared: readonly string[] | undefined): MountedSkillPin[] {
    resolveSkillsFor(declared);
    const c = shippedCorpus();
    return (declared ?? []).map((name) => mountable(c, name, 'declared by a workflow definition but not in the shipped corpus').pin);
}

/** Test seam: drop the cache so a suite can vary the corpus. */
export function resetSkillCache(): void {
    corpus = null;
    verdicts.clear();
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

/**
 * Every skill any of these workflows declares must pass the mount gate. CI runs
 * this over the registered definitions, so a workflow cannot ship declaring a
 * skill no model has passed — the refusal would otherwise first appear as a
 * failed run.
 */
export function assertWorkflowSkillsMountable(defs: readonly DeclaresSkills[]): void {
    const c = shippedCorpus();
    for (const d of defs) {
        for (const name of d.skills ?? []) mountable(c, name, `declared by workflow "${d.key}" but not in the shipped corpus`);
    }
}

/**
 * Would a run that resumes now be taught what its row pinned (#3666)?
 *
 * A run re-resolves its skills on every segment, and a deploy between two
 * segments can change a skill's text. The pin would then describe a run that
 * no longer exists, so a mismatch is reported here and the caller fails the
 * run rather than continue under different instructions. Returns null when the
 * two agree, and when the row predates the pin (NULL): there is nothing to
 * compare against, and refusing every run that started before the deploy would
 * be a migration-day outage, not a control.
 *
 * The message names skills and never their text.
 */
export function skillPinDrift(pinned: unknown, current: readonly MountedSkillPin[]): string | null {
    if (pinned === null || pinned === undefined) return null;
    const now = current.map((p) => ({ name: p.name, version: p.version, contentHash: p.contentHash }));
    if (canonicalJson(pinned) === canonicalJson(now)) return null;
    const was = Array.isArray(pinned) ? pinned : [];
    const key = (p: unknown) => canonicalJson(p);
    const before = new Set(was.map(key));
    const after = new Set(now.map(key));
    const name = (p: unknown) => (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string' ? (p as { name: string }).name : '?');
    const changed = [...new Set([
        ...was.filter((p) => !after.has(key(p))).map(name),
        ...now.filter((p) => !before.has(key(p))).map(name),
    ])].sort();
    return `the run was pinned to different skills than it would mount now (${changed.join(', ') || 'order changed'})`;
}
