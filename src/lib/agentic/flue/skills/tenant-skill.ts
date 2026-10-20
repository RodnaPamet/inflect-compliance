/**
 * THE MOUNT GATE FOR A TENANT-AUTHORED SKILL (#3680, step 4c; settled decision
 * Q5 of the agentic IAM roadmap).
 *
 * A tenant may teach its own agents with a skill it wrote — third-party
 * methodology, such as a managed-service provider's, enters the product only
 * this way, under the author's licence. It arrives behind the lifecycle a
 * repository skill has, and this module is the half of it that decides whether a
 * run may mount one:
 *
 *   NOT_APPROVED   the version is not APPROVED (DRAFT, IN_REVIEW, RETIRED)
 *   SELF_APPROVED  its approver is its author (a CHECK makes this
 *                  unrepresentable; refused here too, never assumed)
 *   PIN_MISMATCH   the instructions as decrypted no longer hash to the hash
 *                  the approval pinned. The encrypted column is writable by
 *                  the DEK rotation sweep, so the database cannot freeze it
 *                  for every role; this recomputation is what can.
 *   (text scan)    the load-time scan refuses it — the SAME `scanSkillText`,
 *                  through the SAME `validateSkillFields` a repository
 *                  document goes through. Reported by rule id, never by text.
 *   NO_RECORD and the evaluation refusals — the record, recomputed from its
 *                  raw answers by the SAME `checkEvaluationRecord`. Pass rates
 *                  are never stored, so none is read.
 *
 * Every check runs on every resolution. Unlike the repository corpus, which is
 * part of the deployed build and cached per process, a tenant version is a
 * database row, so nothing here is cached.
 *
 * PURE: no I/O. The read lives in `tenant-mount.ts`.
 */
import { skillContentHash, checkEvaluationRecord, type CaseKind } from './evaluation-record';
import { SkillTextRefusedError, validateSkillFields, type LoadedSkill } from './index';
import type { MountRefusal, TenantSkillPin } from './mount-gate';
import type { SkillTextRuleId } from './text-scan';

/** One tenant skill version's text and metadata, decrypted. */
export interface TenantSkillVersionText {
    readonly versionId: string;
    /** The skill's name: an Agent Skills identifier, never a repository skill's. */
    readonly name: string;
    readonly version: number;
    readonly description: string;
    readonly instructions: string;
    readonly license: string;
    readonly sourceRef: string;
    readonly requiredInput: string | null;
    readonly output: string | null;
    readonly controls: string | null;
    readonly tools: string | null;
    readonly workflowKeys: readonly string[];
}

export type TenantSkillVersionStatusValue = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'RETIRED';

/** Everything the gate reads about one version. */
export interface TenantSkillVersionForMount extends TenantSkillVersionText {
    readonly status: TenantSkillVersionStatusValue;
    readonly contentHash: string;
    readonly authorUserId: string;
    readonly approvedByUserId: string | null;
    readonly approvedContentHash: string | null;
    readonly evaluationRecordJson: string | null;
}

/**
 * The frontmatter `metadata` map a version's columns make, in the form the
 * loader validates. `version` is the version number, so an evaluation set's
 * `version` is tied to the version it was written for, exactly as a repository
 * set is tied to `metadata.version`.
 */
export function tenantSkillMetadata(v: TenantSkillVersionText): Record<string, string> {
    const m: Record<string, string> = { sourceRef: v.sourceRef, version: String(v.version) };
    if (v.requiredInput !== null) m.requiredInput = v.requiredInput;
    if (v.output !== null) m.output = v.output;
    if (v.controls !== null) m.controls = v.controls;
    if (v.tools !== null) m.tools = v.tools;
    return m;
}

/**
 * The version as the loader would load it: every structural rule a repository
 * skill must meet, then the text scan. Throws `SkillLoadError`, or
 * `SkillTextRefusedError` naming rule ids only.
 */
export function tenantSkillAsLoaded(v: TenantSkillVersionText): LoadedSkill {
    return validateSkillFields(v.name, {
        description: v.description,
        instructions: v.instructions,
        license: v.license,
        metadata: tenantSkillMetadata(v),
    });
}

export type TenantMountVerdict =
    | { readonly ok: true; readonly skill: LoadedSkill; readonly pin: TenantSkillPin }
    | {
        readonly ok: false;
        readonly kind: 'refused';
        readonly rules: readonly SkillTextRuleId[];
        readonly guardRules: readonly string[];
    }
    | { readonly ok: false; readonly kind: 'not_mountable'; readonly reason: MountRefusal; readonly detail: string };

const refusal = (reason: MountRefusal, detail: string): TenantMountVerdict => ({
    ok: false,
    kind: 'not_mountable',
    reason,
    detail,
});

/**
 * Does a pin that the approval recorded still describe this text? Both the
 * stored hash and the approved hash must equal the hash recomputed from the
 * instructions as they now read.
 */
export function tenantPinHolds(v: Pick<TenantSkillVersionForMount, 'instructions' | 'contentHash' | 'approvedContentHash'>): boolean {
    const now = skillContentHash(v.instructions);
    return v.approvedContentHash !== null && v.approvedContentHash === v.contentHash && now === v.contentHash;
}

/** May a run mount this tenant skill version? */
export function checkTenantSkillMountable(v: TenantSkillVersionForMount): TenantMountVerdict {
    if (v.status !== 'APPROVED') {
        return refusal('NOT_APPROVED', `version ${v.version} is ${v.status}; only an approved version mounts`);
    }
    if (v.approvedByUserId === null || v.approvedByUserId === v.authorUserId) {
        return refusal('SELF_APPROVED', `version ${v.version} was not approved by a person other than its author`);
    }
    if (!tenantPinHolds(v)) {
        return refusal('PIN_MISMATCH', `version ${v.version} no longer hashes to the hash its approval pinned`);
    }
    let skill: LoadedSkill;
    try {
        skill = tenantSkillAsLoaded(v);
    } catch (err) {
        if (err instanceof SkillTextRefusedError) {
            return { ok: false, kind: 'refused', rules: err.rules, guardRules: err.guardRules };
        }
        return refusal('MALFORMED', err instanceof Error ? err.message : String(err));
    }
    const evaluated = evaluateTenantRecord(v.evaluationRecordJson, skill);
    if (!evaluated.ok) return refusal(evaluated.reason, evaluated.detail);
    return {
        ok: true,
        skill,
        pin: { name: v.name, version: String(v.version), contentHash: v.contentHash, origin: 'tenant', versionId: v.versionId },
    };
}

/** What a reviewer reads about a record: recomputed, never read back from storage. */
export type TenantRecordCheck =
    | {
        readonly ok: true;
        readonly rates: Readonly<Record<CaseKind, number>>;
        readonly model: { readonly provider: string; readonly revision: string };
        readonly ranAt: string;
        readonly caseCount: number;
    }
    | { readonly ok: false; readonly reason: MountRefusal; readonly detail: string };

/**
 * Check a stored (or offered) evaluation record against a loaded version,
 * recomputing every rate from the raw answers. `null` is "no record", never a
 * pass.
 */
export function evaluateTenantRecord(recordJson: string | null, skill: LoadedSkill): TenantRecordCheck {
    if (recordJson === null) return { ok: false, reason: 'NO_RECORD', detail: 'no evaluation record is attached to this version' };
    let raw: unknown;
    try {
        raw = JSON.parse(recordJson) as unknown;
    } catch {
        return { ok: false, reason: 'MALFORMED', detail: 'the evaluation record is not JSON' };
    }
    const checked = checkEvaluationRecord(raw, skill);
    if (!checked.ok) return { ok: false, reason: checked.reason, detail: checked.detail };
    return {
        ok: true,
        rates: checked.rates,
        model: checked.record.model,
        ranAt: checked.record.ranAt,
        caseCount: checked.record.set.cases.length,
    };
}
