/**
 * THE MOUNT GATE — a skill is mounted only if a real model passed its
 * evaluation set (#3666, rule 7 of docs/agent-skill-standard.md).
 *
 * A skill's evaluation SET is authored with it; a skill's evaluation RECORD is
 * that set plus the answers a named model revision gave, written by
 * `npm run skills:evaluate` and committed beside the skill as
 * `evaluation-record.json`. This module decides, per skill, whether a run may
 * mount it, and refuses with a named reason when it may not:
 *
 *   NOT_EVALUATED     the skill names no evaluation set
 *   (set refusals)    the set does not belong to this exact text — MALFORMED,
 *                     NAME_MISMATCH, VERSION_MISMATCH, HASH_MISMATCH
 *   NO_RECORD         the set exists and no model has answered it
 *   SET_MISMATCH      the record answered a different set from the committed one
 *   (record refusals) UNANSWERED_CASE, UNKNOWN_ANSWER, DUPLICATE_ANSWER,
 *                     BELOW_THRESHOLD — recomputed from the raw answers
 *
 * ── WHY SET_MISMATCH EXISTS ─────────────────────────────────────────────────
 *
 * A record carries its own copy of the set, and `checkEvaluationRecord` checks
 * that copy against the skill's text. That alone would accept a record made
 * against an EARLIER set for the same text: add a hard case to the committed
 * set, keep the old record, and the old record still passes. So the record's
 * set must equal the committed set, compared as canonical JSON, and adding a
 * case to a set is a refusal until somebody re-records.
 *
 * ── WHAT IS NOT CHECKED, AND WHY ────────────────────────────────────────────
 *
 * The record names a model revision, and the gate does not require it to be
 * the model a given run will use. A run's model is chosen per tenant by
 * residency (`model-selection.ts`), and a record per model would refuse every
 * skill to every tenant on a model nobody recorded. The record answers "has a
 * real model shown this text does its job"; the run's own pin answers what this
 * run was taught. Tying the two together is a decision for later, not a gap
 * this module hides — `docs/agent-skill-standard.md` says so.
 *
 * PURE except for reading the two files beside the skill.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { canonicalJson } from '@/lib/canonical-json';

import { skillDirectory, SkillLoadError, type LoadedSkill } from './index';
import {
    checkEvaluationRecord,
    checkEvaluationSet,
    readEvaluationSet,
    skillContentHash,
    type EvaluationRefusal,
} from './evaluation-record';

/** The file `npm run skills:evaluate` writes beside a skill. */
export const EVALUATION_RECORD_FILE = 'evaluation-record.json';

export type MountRefusal = 'NOT_EVALUATED' | 'NO_RECORD' | 'SET_MISMATCH' | EvaluationRefusal;

/** What a run records about each skill it mounted: enough to say what it was taught. */
export interface MountedSkillPin {
    readonly name: string;
    readonly version: string;
    /** `sha256:` over the instructions exactly as the run received them. */
    readonly contentHash: string;
}

export type MountVerdict =
    | { ok: true; pin: MountedSkillPin }
    | { ok: false; reason: MountRefusal; detail: string };

/** A skill the gate refused. The reason is named; the skill's text is not repeated. */
export class SkillNotMountableError extends SkillLoadError {
    constructor(
        skillName: string,
        public readonly reason: MountRefusal,
        detail: string,
    ) {
        super(skillName, `cannot be mounted: ${reason} (${detail})`);
        this.name = 'SkillNotMountableError';
    }
}

/** The committed record beside a skill, or null when there is none. */
export function readEvaluationRecord(skill: LoadedSkill, dir: string = skillDirectory(skill.name)): unknown | null {
    const full = path.join(dir, EVALUATION_RECORD_FILE);
    if (!fs.existsSync(full)) return null;
    return JSON.parse(fs.readFileSync(full, 'utf-8')) as unknown;
}

/**
 * May a run mount this skill? `dir` is the skill's directory — a test seam;
 * production reads the shipped corpus.
 */
export function checkSkillMountable(skill: LoadedSkill, dir: string = skillDirectory(skill.name)): MountVerdict {
    let rawSet: unknown | null;
    let rawRecord: unknown | null;
    try {
        rawSet = readEvaluationSet(skill, dir);
        rawRecord = rawSet === null ? null : readEvaluationRecord(skill, dir);
    } catch (err) {
        // An unreadable or non-JSON file is a malformed evaluation, never a pass.
        return { ok: false, reason: 'MALFORMED', detail: err instanceof Error ? err.message : String(err) };
    }
    if (rawSet === null) {
        return { ok: false, reason: 'NOT_EVALUATED', detail: 'the skill names no evaluation set in metadata.evaluation' };
    }
    const set = checkEvaluationSet(rawSet, skill);
    if (!set.ok) return set;
    if (rawRecord === null) {
        return { ok: false, reason: 'NO_RECORD', detail: `no ${EVALUATION_RECORD_FILE}; run npm run skills:evaluate` };
    }
    const recordSet = (rawRecord as { set?: unknown }).set;
    if (canonicalJson(recordSet) !== canonicalJson(rawSet)) {
        return { ok: false, reason: 'SET_MISMATCH', detail: 'the record answered a different set from the committed one; re-record' };
    }
    const record = checkEvaluationRecord(rawRecord, skill);
    if (!record.ok) return record;
    return {
        ok: true,
        pin: {
            name: skill.name,
            // `checkEvaluationSet` has already required the set's version to
            // equal this, so a mountable skill always carries one.
            version: skill.metadata.version ?? '',
            contentHash: skillContentHash(skill.instructions),
        },
    };
}

/**
 * A `WorkflowRun.mountedSkills` value, read back. Null when the row predates the
 * pin. A value the database holds but that is not a list of pins reads as null
 * too: a surface must not present a malformed pin as a record of what a run was
 * taught.
 */
export function parseMountedSkillPins(value: unknown): MountedSkillPin[] | null {
    if (!Array.isArray(value)) return null;
    const pins: MountedSkillPin[] = [];
    for (const v of value) {
        if (!v || typeof v !== 'object') return null;
        const { name, version, contentHash } = v as Record<string, unknown>;
        if (typeof name !== 'string' || typeof version !== 'string' || typeof contentHash !== 'string') return null;
        pins.push({ name, version, contentHash });
    }
    return pins;
}
