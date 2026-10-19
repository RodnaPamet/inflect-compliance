/**
 * TENANT-AUTHORED SKILLS UNDER THE REVIEW LIFECYCLE (#3680, step 4c; UC6).
 *
 * The ONLY writer of `TenantSkill` and `TenantSkillVersion`
 * (`tests/guards/agent-harness-single-write-seam.test.ts`).
 *
 * Settled decision Q5: the repository corpus stays Inflect-original guidance,
 * and third-party methodology — PwC's among it — enters only as a tenant's own
 * skill, under the author's licence, behind the lifecycle a repository skill
 * has. Each half of that lifecycle has a counterpart here:
 *
 *   repository skill                      tenant skill
 *   ────────────────────────────────────  ────────────────────────────────────
 *   a pull request                        a new version, which starts at DRAFT
 *   the loader's structural rules         the same `validateSkillFields`
 *   the load-time text scan               the same `scanSkillText`, at save as
 *                                         feedback and at mount as the gate
 *   `evaluation-record.json`, committed   a record attached to the DRAFT, once,
 *                                         and only if it passes
 *   a reviewer other than the author      an approver other than the author,
 *                                         holding `admin.agent_skill_review`
 *                                         (usecase, and a CHECK)
 *   the merged text                       the approved hash, pinned
 *
 * ── WHO MAY ACT ─────────────────────────────────────────────────────────────
 *
 * Two keys since #3778 (owner decision): `admin.agent_skill_author` creates a
 * skill or a version, attaches a record and submits; `admin.agent_skill_review`
 * approves, rejects and retires; reading a skill takes either. The split lets a
 * provider who writes a tenant's skills be kept from approving them. The
 * four-eyes rule is ALSO a PERSON, whoever holds both keys: approval refuses
 * the version's author (`SELF_APPROVAL`) and refuses an API-key caller
 * (`APPROVER_NOT_A_PERSON`), and the database refuses an approval whose
 * approver is the author.
 *
 * ── AN EDIT IS A NEW VERSION ────────────────────────────────────────────────
 *
 * A version's text never changes (a trigger). Editing creates version N+1 at
 * DRAFT and retires any open (DRAFT or IN_REVIEW) version as SUPERSEDED. The
 * version in service, if any, keeps serving until N+1 is approved, at which
 * point it is retired as SUPERSEDED in the same transaction: N+1 mounts nothing
 * until a second person has approved its exact hash.
 *
 * ── HOW A TENANT PRODUCES AN EVALUATION RECORD ──────────────────────────────
 *
 * The record is the repository's own format (`SkillEvaluationRecordSchema`):
 * the set, tied to this version's name, number and content hash, plus a named
 * model revision's answers. The author attaches it to the DRAFT. It is checked
 * by the same `checkEvaluationRecord` the repository gate calls, its rates
 * recomputed from the raw answers, and it is stored only if it passes; the
 * mount gate recomputes it again on every run. The product does not run the
 * model itself: who made the record, and with which model, is what the reviewer
 * reads beside the rates (`docs/agent-skill-standard.md`, "Tenant-authored
 * skills").
 *
 * ── TEXT ────────────────────────────────────────────────────────────────────
 *
 * Every string is sanitised (`sanitizePlainText`) at this seam, before it is
 * scanned, hashed or stored, and the instructions and the record are encrypted
 * at rest by the Epic B middleware. Text the scan refuses is refused at save,
 * by rule id, and never stored; a stored version the scan refuses later (a rule
 * tightened by a deploy) is listed by rule id and its text is never returned.
 * Audit rows carry hashes, numbers and rule ids, never skill text.
 */
import { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { AppError, ConflictError, ValidationError } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { getWorkflowDefinition, listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { isSkillName, SkillLoadError, SkillTextRefusedError } from '@/lib/agentic/flue/skills';
import { skillContentHash, type CaseKind } from '@/lib/agentic/flue/skills/evaluation-record';
import type { MountRefusal } from '@/lib/agentic/flue/skills/mount-gate';
import { repositorySkillNames, workflowsOverBudget, type TenantCatalogueEntry } from '@/lib/agentic/flue/skills/resolve';
import {
    checkTenantSkillMountable,
    evaluateTenantRecord,
    tenantSkillAsLoaded,
    type TenantSkillVersionForMount,
    type TenantSkillVersionText,
} from '@/lib/agentic/flue/skills/tenant-skill';
import { TENANT_SKILL_MOUNT_SELECT, toMountInput } from '@/lib/agentic/flue/skills/tenant-mount';
import { recordTenantSkillReview } from '@/lib/observability/integration-metrics';
import type {
    CreateTenantSkillInput,
    TenantSkillTextInput,
} from '../schemas/tenant-skill.schemas';

// ─── Refusals ───────────────────────────────────────────────────────

export type TenantSkillRefusal =
    | 'NAME_INVALID'
    | 'NAME_RESERVED'
    | 'NAME_TAKEN'
    | 'UNKNOWN_WORKFLOW'
    | 'WORKFLOW_MOUNTS_NO_SKILLS'
    | 'SKILL_INVALID'
    | 'SKILL_TEXT_REFUSED'
    | 'SKILL_NOT_FOUND'
    | 'VERSION_NOT_FOUND'
    | 'NOT_DRAFT'
    | 'NOT_IN_REVIEW'
    | 'ALREADY_RETIRED'
    | 'EVALUATION_ALREADY_ATTACHED'
    | 'EVALUATION_REFUSED'
    | 'NO_EVALUATION'
    | 'SELF_APPROVAL'
    | 'APPROVER_NOT_A_PERSON'
    | 'HASH_CHANGED'
    | 'PIN_MISMATCH'
    | 'CATALOGUE_OVER_BUDGET'
    | 'CONCURRENT_CHANGE';

const REFUSAL_STATUS: Record<TenantSkillRefusal, 400 | 403 | 404 | 409> = {
    NAME_INVALID: 400,
    NAME_RESERVED: 409,
    NAME_TAKEN: 409,
    UNKNOWN_WORKFLOW: 400,
    WORKFLOW_MOUNTS_NO_SKILLS: 400,
    SKILL_INVALID: 400,
    SKILL_TEXT_REFUSED: 400,
    SKILL_NOT_FOUND: 404,
    VERSION_NOT_FOUND: 404,
    NOT_DRAFT: 409,
    NOT_IN_REVIEW: 409,
    ALREADY_RETIRED: 409,
    EVALUATION_ALREADY_ATTACHED: 409,
    EVALUATION_REFUSED: 400,
    NO_EVALUATION: 409,
    SELF_APPROVAL: 403,
    APPROVER_NOT_A_PERSON: 403,
    HASH_CHANGED: 409,
    PIN_MISMATCH: 409,
    CATALOGUE_OVER_BUDGET: 409,
    CONCURRENT_CHANGE: 409,
};

/** A refusal carrying its reason as `details.reason`, beside a sentence for the person who asked. */
function refuse(reason: TenantSkillRefusal, message: string, extra: Record<string, unknown> = {}): AppError {
    const details = { reason, ...extra };
    const status = REFUSAL_STATUS[reason];
    if (status === 400) return new ValidationError(message, details);
    if (status === 409) return new ConflictError(message, details);
    if (status === 403) return new AppError(message, 'FORBIDDEN', 403, true, details);
    return new AppError(message, 'NOT_FOUND', 404, true, details);
}

/** The refusal reason an error carries, for the metric. */
function outcomeOf(err: unknown): string {
    if (err instanceof AppError) {
        const reason = (err.details as { reason?: unknown } | undefined)?.reason;
        if (typeof reason === 'string') return reason;
        return err.code;
    }
    return 'ERROR';
}

/** Run one lifecycle act and count it, by action and outcome. */
async function counted<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
        const out = await fn();
        recordTenantSkillReview({ action, outcome: 'OK' });
        return out;
    } catch (err) {
        recordTenantSkillReview({ action, outcome: outcomeOf(err) });
        throw err;
    }
}

/**
 * The two halves, each re-asserted beneath the route's literal
 * `requirePermission` so a second caller of this usecase cannot reach an act
 * without its key (#3778). `canRead` stays required, as on every
 * agent-governance floor.
 */
function refuseWithout(ctx: RequestContext, holds: boolean, message: string): void {
    if (ctx.permissions.canRead !== true || !holds) {
        throw new AppError(message, 'FORBIDDEN', 403, true);
    }
}

/** Approve, reject or retire: `admin.agent_skill_review`. */
export function assertMayReviewSkills(ctx: RequestContext): void {
    refuseWithout(
        ctx,
        ctx.appPermissions?.admin?.agent_skill_review === true,
        'Approving, rejecting or retiring a tenant skill requires admin.agent_skill_review.',
    );
}

/** Create a skill or a version, attach a record, submit: `admin.agent_skill_author`. */
export function assertMayAuthorSkills(ctx: RequestContext): void {
    refuseWithout(
        ctx,
        ctx.appPermissions?.admin?.agent_skill_author === true,
        'Authoring a tenant skill requires admin.agent_skill_author.',
    );
}

/** Read one skill and its versions: either half. */
export function assertMayReadTenantSkill(ctx: RequestContext): void {
    refuseWithout(
        ctx,
        ctx.appPermissions?.admin?.agent_skill_author === true || ctx.appPermissions?.admin?.agent_skill_review === true,
        'Reading a tenant skill requires admin.agent_skill_author or admin.agent_skill_review.',
    );
}

// ─── Preparing a version's text ─────────────────────────────────────

/** The sanitised fields of one version, and their content hash. */
interface PreparedText extends Omit<TenantSkillVersionText, 'versionId' | 'name' | 'version'> {
    readonly contentHash: string;
    readonly workflowKeys: string[];
}

const clean = (s: string): string => sanitizePlainText(s).trim();
const cleanOptional = (s: string | null | undefined): string | null => {
    if (s === null || s === undefined) return null;
    const c = clean(s);
    return c === '' ? null : c;
};

/** The workflows a tenant skill may name: registered, and asking for the Flue engine. */
export function attachableWorkflows(): { key: string; name: string }[] {
    return listWorkflowDefinitions()
        .filter((d) => d.driver === 'flue')
        .map((d) => ({ key: d.key, name: d.name }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Sanitise, then hold the result to the loader's rules and the text scan — the
 * scan's FEEDBACK at save. Refused text is refused here, by rule id, and never
 * stored; the same scan runs again as the GATE at every mount.
 */
function prepareText(name: string, raw: TenantSkillTextInput): PreparedText {
    const workflowKeys = [...new Set(raw.workflowKeys.map((k) => k.trim()))].sort();
    for (const key of workflowKeys) {
        const def = getWorkflowDefinition(key);
        if (!def) throw refuse('UNKNOWN_WORKFLOW', `No registered workflow is called "${key}".`, { workflowKey: key });
        if (def.driver !== 'flue') {
            throw refuse(
                'WORKFLOW_MOUNTS_NO_SKILLS',
                `Workflow "${key}" runs on the static engine, which mounts no skill.`,
                { workflowKey: key },
            );
        }
    }
    const text = {
        description: clean(raw.description),
        instructions: clean(raw.instructions),
        license: clean(raw.license),
        sourceRef: clean(raw.sourceRef),
        requiredInput: cleanOptional(raw.requiredInput),
        output: raw.output ?? null,
        controls: cleanOptional(raw.controls),
        tools: cleanOptional(raw.tools),
        workflowKeys,
    };
    if (!text.sourceRef) throw refuse('SKILL_INVALID', 'A tenant skill states where it came from (its source).');
    try {
        tenantSkillAsLoaded({ versionId: '', name, version: 1, ...text });
    } catch (err) {
        if (err instanceof SkillTextRefusedError) {
            throw refuse(
                'SKILL_TEXT_REFUSED',
                `The skill text scan refused this text (${[...err.rules, ...err.guardRules].join(', ')}). ` +
                    'See the agent skill standard for what each rule refuses.',
                { rules: [...err.rules], guardRules: [...err.guardRules] },
            );
        }
        if (err instanceof SkillLoadError) throw refuse('SKILL_INVALID', err.message);
        throw err;
    }
    return { ...text, contentHash: skillContentHash(text.instructions) };
}

/** The name a version's catalogue line carries, checked against both namespaces. */
function assertNameAvailableToTenant(name: string): void {
    if (!isSkillName(name)) {
        throw refuse(
            'NAME_INVALID',
            'A skill name is lowercase letters, digits and single hyphens, at most 64 characters.',
        );
    }
    if (repositorySkillNames().has(name)) {
        throw refuse('NAME_RESERVED', `"${name}" is the name of a skill the product ships.`);
    }
}

function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

const VERSION_STAMP_SELECT = {
    id: true,
    version: true,
    status: true,
    retiredReason: true,
    contentHash: true,
    authorUserId: true,
    evaluationAttachedAt: true,
    evaluationAttachedByUserId: true,
    submittedAt: true,
    submittedByUserId: true,
    approvedAt: true,
    approvedByUserId: true,
    retiredAt: true,
    retiredByUserId: true,
    createdAt: true,
} as const;

// ─── Create and edit ────────────────────────────────────────────────

export interface CreatedTenantSkillVersion {
    skillId: string;
    versionId: string;
    version: number;
    contentHash: string;
    /** The open version this one superseded, if any. */
    supersededVersionId: string | null;
}

/** A new skill, with version 1 at DRAFT authored by the caller. */
export async function createTenantSkill(ctx: RequestContext, input: CreateTenantSkillInput): Promise<CreatedTenantSkillVersion> {
    return counted('create', async () => {
        assertMayAuthorSkills(ctx);
        const name = input.name.trim();
        assertNameAvailableToTenant(name);
        const text = prepareText(name, input);
        try {
            return await runInTenantContext(ctx, async (db) => {
                const existing = await db.tenantSkill.findFirst({
                    where: { tenantId: ctx.tenantId, name },
                    select: { id: true },
                });
                if (existing) throw refuse('NAME_TAKEN', `This workspace already has a skill called "${name}".`);
                const skill = await db.tenantSkill.create({
                    data: { tenantId: ctx.tenantId, name, createdByUserId: ctx.userId },
                    select: { id: true },
                });
                const created = await insertVersion(db, ctx, skill.id, 1, text);
                await logEvent(db, ctx, {
                    action: 'TENANT_SKILL_CREATED',
                    entityType: 'TenantSkill',
                    entityId: skill.id,
                    details: `Created tenant skill ${name}, version 1, as a draft`,
                    detailsJson: {
                        category: 'access',
                        entityName: 'TenantSkill',
                        operation: 'created',
                        after: { name, version: 1, contentHash: text.contentHash, workflowKeys: text.workflowKeys },
                    },
                });
                return { skillId: skill.id, versionId: created.id, version: 1, contentHash: text.contentHash, supersededVersionId: null };
            });
        } catch (err) {
            if (isUniqueViolation(err)) throw refuse('NAME_TAKEN', `This workspace already has a skill called "${name}".`);
            throw err;
        }
    });
}

async function insertVersion(db: PrismaTx, ctx: RequestContext, skillId: string, version: number, text: PreparedText) {
    return db.tenantSkillVersion.create({
        data: {
            tenantId: ctx.tenantId,
            skillId,
            version,
            description: text.description,
            instructions: text.instructions,
            license: text.license,
            sourceRef: text.sourceRef,
            requiredInput: text.requiredInput,
            output: text.output,
            controls: text.controls,
            tools: text.tools,
            workflowKeys: text.workflowKeys,
            contentHash: text.contentHash,
            authorUserId: ctx.userId,
        },
        select: { id: true },
    });
}

async function findSkill(db: PrismaTx, ctx: RequestContext, skillId: string): Promise<{ id: string; name: string }> {
    const skill = await db.tenantSkill.findFirst({
        where: { id: skillId, tenantId: ctx.tenantId },
        select: { id: true, name: true },
    });
    if (!skill) throw refuse('SKILL_NOT_FOUND', 'Tenant skill not found.');
    return skill;
}

/**
 * Edit a skill: a NEW version N+1 at DRAFT, authored by the caller. Any open
 * version (DRAFT or IN_REVIEW) is retired as SUPERSEDED first, so a reviewer
 * never approves text its author has already replaced. The version in service,
 * if any, keeps serving: N+1 mounts nothing until it is approved.
 */
export async function createTenantSkillVersion(
    ctx: RequestContext,
    skillId: string,
    input: TenantSkillTextInput,
): Promise<CreatedTenantSkillVersion> {
    return counted('edit', async () => {
        assertMayAuthorSkills(ctx);
        try {
            return await runInTenantContext(ctx, async (db) => {
                const skill = await findSkill(db, ctx, skillId);
                assertNameAvailableToTenant(skill.name);
                const text = prepareText(skill.name, input);
                const latest = await db.tenantSkillVersion.findFirst({
                    where: { tenantId: ctx.tenantId, skillId },
                    orderBy: { version: 'desc' },
                    select: { version: true },
                });
                const open = await db.tenantSkillVersion.findFirst({
                    where: { tenantId: ctx.tenantId, skillId, status: { in: ['DRAFT', 'IN_REVIEW'] } },
                    select: { id: true, version: true },
                });
                const now = new Date();
                if (open) {
                    const claimed = await db.tenantSkillVersion.updateMany({
                        where: { id: open.id, tenantId: ctx.tenantId, status: { in: ['DRAFT', 'IN_REVIEW'] } },
                        data: { status: 'RETIRED', retiredAt: now, retiredByUserId: ctx.userId, retiredReason: 'SUPERSEDED' },
                    });
                    if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This skill changed while it was being edited.');
                }
                const version = (latest?.version ?? 0) + 1;
                const created = await insertVersion(db, ctx, skillId, version, text);
                await logEvent(db, ctx, {
                    action: 'TENANT_SKILL_VERSION_CREATED',
                    entityType: 'TenantSkillVersion',
                    entityId: created.id,
                    details: `Created version ${version} of tenant skill ${skill.name} as a draft`,
                    detailsJson: {
                        category: 'access',
                        entityName: 'TenantSkillVersion',
                        operation: 'created',
                        after: {
                            skillId,
                            name: skill.name,
                            version,
                            contentHash: text.contentHash,
                            workflowKeys: text.workflowKeys,
                            supersededVersion: open?.version ?? null,
                        },
                    },
                });
                return { skillId, versionId: created.id, version, contentHash: text.contentHash, supersededVersionId: open?.id ?? null };
            });
        } catch (err) {
            if (isUniqueViolation(err)) throw refuse('CONCURRENT_CHANGE', 'This skill changed while it was being edited.');
            throw err;
        }
    });
}

// ─── Evaluation ─────────────────────────────────────────────────────

/** A deep copy with every string sanitised — the record crosses this seam like any other text. */
function sanitizeDeep(value: unknown): unknown {
    if (typeof value === 'string') return sanitizePlainText(value);
    if (Array.isArray(value)) return value.map(sanitizeDeep);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
        return out;
    }
    return value;
}

async function findVersionForMount(
    db: PrismaTx,
    ctx: RequestContext,
    skillId: string,
    versionId: string,
): Promise<TenantSkillVersionForMount> {
    const row = await db.tenantSkillVersion.findFirst({
        where: { id: versionId, skillId, tenantId: ctx.tenantId },
        select: TENANT_SKILL_MOUNT_SELECT,
    });
    if (!row) throw refuse('VERSION_NOT_FOUND', 'Tenant skill version not found.');
    return toMountInput(row);
}

export interface RecordSummary {
    rates: Record<CaseKind, number>;
    model: { provider: string; revision: string };
    ranAt: string;
    caseCount: number;
}

/**
 * Attach the version's evaluation record: once, while DRAFT, and only if it
 * passes. The record is checked against the version as stored — its set must
 * name this skill, this version number and this content hash — and its rates
 * are recomputed from its raw answers. A failing record is refused with the
 * gate's reason and stored nowhere.
 */
export async function attachTenantSkillEvaluation(
    ctx: RequestContext,
    skillId: string,
    versionId: string,
    input: { record: Record<string, unknown> },
): Promise<RecordSummary> {
    return counted('evaluation', async () => {
        assertMayAuthorSkills(ctx);
        const sanitized = sanitizeDeep(input.record);
        const recordJson = JSON.stringify(sanitized);
        return runInTenantContext(ctx, async (db) => {
            const v = await findVersionForMount(db, ctx, skillId, versionId);
            if (v.status !== 'DRAFT') throw refuse('NOT_DRAFT', 'An evaluation record is attached to a draft, before it is submitted.');
            if (v.evaluationRecordJson !== null) {
                throw refuse('EVALUATION_ALREADY_ATTACHED', 'This version already carries an evaluation record; edit the skill to evaluate new text.');
            }
            const loaded = loadOrRefuse(v);
            const check = evaluateTenantRecord(recordJson, loaded);
            if (!check.ok) {
                throw refuse(
                    'EVALUATION_REFUSED',
                    `The evaluation record does not pass: ${check.reason} (${check.detail}).`,
                    { evaluationReason: check.reason },
                );
            }
            const claimed = await db.tenantSkillVersion.updateMany({
                where: { id: v.versionId, tenantId: ctx.tenantId, status: 'DRAFT', evaluationAttachedAt: null },
                data: {
                    evaluationRecordJson: recordJson,
                    evaluationAttachedAt: new Date(),
                    evaluationAttachedByUserId: ctx.userId,
                },
            });
            if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while its record was being attached.');
            await logEvent(db, ctx, {
                action: 'TENANT_SKILL_EVALUATION_ATTACHED',
                entityType: 'TenantSkillVersion',
                entityId: v.versionId,
                details: `Attached an evaluation record to version ${v.version} of tenant skill ${v.name}`,
                detailsJson: {
                    category: 'access',
                    entityName: 'TenantSkillVersion',
                    operation: 'updated',
                    after: {
                        name: v.name,
                        version: v.version,
                        contentHash: v.contentHash,
                        modelProvider: check.model.provider,
                        modelRevision: check.model.revision,
                        caseCount: check.caseCount,
                    },
                },
            });
            return { rates: { ...check.rates }, model: { ...check.model }, ranAt: check.ranAt, caseCount: check.caseCount };
        });
    });
}

/** The version loaded as the loader would load it, or the refusal a person can act on. */
function loadOrRefuse(v: TenantSkillVersionText) {
    try {
        return tenantSkillAsLoaded(v);
    } catch (err) {
        if (err instanceof SkillTextRefusedError) {
            throw refuse(
                'SKILL_TEXT_REFUSED',
                `The skill text scan refuses this version (${[...err.rules, ...err.guardRules].join(', ')}).`,
                { rules: [...err.rules], guardRules: [...err.guardRules] },
            );
        }
        if (err instanceof SkillLoadError) throw refuse('SKILL_INVALID', err.message);
        throw err;
    }
}

// ─── Review ─────────────────────────────────────────────────────────

/** DRAFT → IN_REVIEW. Needs a passing record, recomputed again here. */
export async function submitTenantSkillVersion(ctx: RequestContext, skillId: string, versionId: string): Promise<{ status: 'IN_REVIEW' }> {
    return counted('submit', async () => {
        assertMayAuthorSkills(ctx);
        return runInTenantContext(ctx, async (db) => {
            const v = await findVersionForMount(db, ctx, skillId, versionId);
            if (v.status !== 'DRAFT') throw refuse('NOT_DRAFT', 'Only a draft is submitted for review.');
            if (v.evaluationRecordJson === null) {
                throw refuse('NO_EVALUATION', 'Attach a passing evaluation record before submitting this version for review.');
            }
            const check = evaluateTenantRecord(v.evaluationRecordJson, loadOrRefuse(v));
            if (!check.ok) {
                throw refuse('EVALUATION_REFUSED', `The evaluation record no longer passes: ${check.reason}.`, {
                    evaluationReason: check.reason,
                });
            }
            const claimed = await db.tenantSkillVersion.updateMany({
                where: { id: v.versionId, tenantId: ctx.tenantId, status: 'DRAFT' },
                data: { status: 'IN_REVIEW', submittedAt: new Date(), submittedByUserId: ctx.userId },
            });
            if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being submitted.');
            await logEvent(db, ctx, {
                action: 'TENANT_SKILL_SUBMITTED',
                entityType: 'TenantSkillVersion',
                entityId: v.versionId,
                details: `Submitted version ${v.version} of tenant skill ${v.name} for review`,
                detailsJson: {
                    category: 'access',
                    entityName: 'TenantSkillVersion',
                    operation: 'updated',
                    before: { status: 'DRAFT' },
                    after: { status: 'IN_REVIEW', name: v.name, version: v.version, contentHash: v.contentHash },
                },
            });
            return { status: 'IN_REVIEW' as const };
        });
    });
}

/** The gate's reason as the refusal a reviewer reads. */
function refusalForGate(reason: MountRefusal, detail: string): AppError {
    if (reason === 'PIN_MISMATCH') {
        return refuse('PIN_MISMATCH', 'This version no longer hashes to its own content hash; it cannot be approved.');
    }
    if (reason === 'SELF_APPROVED') return refuse('SELF_APPROVAL', 'The author of a version cannot approve it.');
    return refuse('EVALUATION_REFUSED', `The evaluation record does not pass: ${reason} (${detail}).`, { evaluationReason: reason });
}

/**
 * IN_REVIEW → APPROVED, by a person other than the author, naming the hash they
 * reviewed. Approval re-runs the whole mount gate as if the version were
 * already approved — hash, text scan, recomputed record — and the combined
 * catalogue budget of every workflow it names, so what a reviewer approves is
 * what a run will mount. The version it replaces is retired as SUPERSEDED in
 * the same transaction. Approvals in one tenant serialise on an advisory lock,
 * so two of them cannot fill a workflow's catalogue together; the run applies
 * the budget again regardless.
 */
export async function approveTenantSkillVersion(
    ctx: RequestContext,
    skillId: string,
    versionId: string,
    input: { contentHash: string },
): Promise<{ status: 'APPROVED'; contentHash: string; supersededVersionId: string | null }> {
    return counted('approve', async () => {
        assertMayReviewSkills(ctx);
        if (ctx.apiKeyId) {
            throw refuse('APPROVER_NOT_A_PERSON', 'A tenant skill is approved by a signed-in person, never by an API key.');
        }
        return runInTenantContext(ctx, async (db) => {
            await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `tenant-skill-approval:${ctx.tenantId}`);
            const v = await findVersionForMount(db, ctx, skillId, versionId);
            if (v.status !== 'IN_REVIEW') throw refuse('NOT_IN_REVIEW', 'Only a version in review can be approved.');
            if (v.authorUserId === ctx.userId) throw refuse('SELF_APPROVAL', 'The author of a version cannot approve it.');
            if (input.contentHash !== v.contentHash) {
                throw refuse('HASH_CHANGED', 'The hash you reviewed is not this version\'s; read the version again before approving.');
            }
            assertNameAvailableToTenant(v.name);

            const verdict = checkTenantSkillMountable({
                ...v,
                status: 'APPROVED',
                approvedByUserId: ctx.userId,
                approvedContentHash: input.contentHash,
            });
            if (!verdict.ok) {
                if (verdict.kind === 'refused') {
                    throw refuse(
                        'SKILL_TEXT_REFUSED',
                        `The skill text scan refuses this version (${[...verdict.rules, ...verdict.guardRules].join(', ')}).`,
                        { rules: [...verdict.rules], guardRules: [...verdict.guardRules] },
                    );
                }
                throw refusalForGate(verdict.reason, verdict.detail);
            }

            // THE COMBINED BUDGET, per workflow this version names: the
            // workflow's repository skills, every OTHER skill of this tenant in
            // service on it, and this one.
            const others = await db.tenantSkillVersion.findMany({
                where: { tenantId: ctx.tenantId, status: 'APPROVED', skillId: { not: skillId } },
                select: { description: true, workflowKeys: true, skill: { select: { name: true } } },
                take: 500,
            });
            const entries: TenantCatalogueEntry[] = [
                ...others.map((o) => ({ name: o.skill.name, description: o.description, workflowKeys: o.workflowKeys })),
                { name: v.name, description: v.description, workflowKeys: v.workflowKeys },
            ];
            const over = workflowsOverBudget(listWorkflowDefinitions(), entries).filter((w) => v.workflowKeys.includes(w.key));
            if (over.length > 0) {
                throw refuse(
                    'CATALOGUE_OVER_BUDGET',
                    `Approving this version would put the always-present catalogue of ${over.map((w) => w.key).join(', ')} ` +
                        'over its budget. Shorten a description, or take a skill off that workflow.',
                    { workflows: over },
                );
            }

            const now = new Date();
            const inService = await db.tenantSkillVersion.findFirst({
                where: { tenantId: ctx.tenantId, skillId, status: 'APPROVED' },
                select: { id: true, version: true },
            });
            if (inService) {
                const retired = await db.tenantSkillVersion.updateMany({
                    where: { id: inService.id, tenantId: ctx.tenantId, status: 'APPROVED' },
                    data: { status: 'RETIRED', retiredAt: now, retiredByUserId: ctx.userId, retiredReason: 'SUPERSEDED' },
                });
                if (retired.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This skill changed while it was being approved.');
            }
            const claimed = await db.tenantSkillVersion.updateMany({
                where: { id: v.versionId, tenantId: ctx.tenantId, status: 'IN_REVIEW' },
                data: {
                    status: 'APPROVED',
                    approvedAt: now,
                    approvedByUserId: ctx.userId,
                    approvedContentHash: input.contentHash,
                },
            });
            if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being approved.');
            await logEvent(db, ctx, {
                action: 'TENANT_SKILL_APPROVED',
                entityType: 'TenantSkillVersion',
                entityId: v.versionId,
                details: `Approved version ${v.version} of tenant skill ${v.name}`,
                detailsJson: {
                    category: 'access',
                    entityName: 'TenantSkillVersion',
                    operation: 'updated',
                    before: { status: 'IN_REVIEW' },
                    after: {
                        status: 'APPROVED',
                        name: v.name,
                        version: v.version,
                        contentHash: v.contentHash,
                        authorUserId: v.authorUserId,
                        workflowKeys: v.workflowKeys,
                        supersededVersion: inService?.version ?? null,
                    },
                },
            });
            return { status: 'APPROVED' as const, contentHash: v.contentHash, supersededVersionId: inService?.id ?? null };
        });
    });
}

/**
 * IN_REVIEW → RETIRED (REJECTED). Any holder of the key may reject, the author
 * included: refusing text is the safe direction. The author edits the skill to
 * try again, which is a new version.
 */
export async function rejectTenantSkillVersion(ctx: RequestContext, skillId: string, versionId: string): Promise<{ status: 'RETIRED' }> {
    return counted('reject', async () => {
        assertMayReviewSkills(ctx);
        return runInTenantContext(ctx, async (db) => {
            const v = await findVersionStamps(db, ctx, skillId, versionId);
            if (v.status !== 'IN_REVIEW') throw refuse('NOT_IN_REVIEW', 'Only a version in review can be rejected.');
            const claimed = await db.tenantSkillVersion.updateMany({
                where: { id: versionId, tenantId: ctx.tenantId, status: 'IN_REVIEW' },
                data: { status: 'RETIRED', retiredAt: new Date(), retiredByUserId: ctx.userId, retiredReason: 'REJECTED' },
            });
            if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being rejected.');
            await logEvent(db, ctx, {
                action: 'TENANT_SKILL_REJECTED',
                entityType: 'TenantSkillVersion',
                entityId: versionId,
                details: `Rejected version ${v.version} of tenant skill ${v.skill.name}`,
                detailsJson: {
                    category: 'access',
                    entityName: 'TenantSkillVersion',
                    operation: 'updated',
                    before: { status: 'IN_REVIEW' },
                    after: { status: 'RETIRED', retiredReason: 'REJECTED', name: v.skill.name, version: v.version, contentHash: v.contentHash },
                },
            });
            return { status: 'RETIRED' as const };
        });
    });
}

/**
 * Take a version out: DRAFT, IN_REVIEW or APPROVED → RETIRED (WITHDRAWN). A
 * retired APPROVED version stops mounting at the next run, and a run already
 * pinned to it fails on its next segment rather than carrying on with text its
 * tenant withdrew.
 */
export async function retireTenantSkillVersion(ctx: RequestContext, skillId: string, versionId: string): Promise<{ status: 'RETIRED' }> {
    return counted('retire', async () => {
        assertMayReviewSkills(ctx);
        return runInTenantContext(ctx, async (db) => {
            const v = await findVersionStamps(db, ctx, skillId, versionId);
            if (v.status === 'RETIRED') throw refuse('ALREADY_RETIRED', 'This version is already retired.');
            const claimed = await db.tenantSkillVersion.updateMany({
                where: { id: versionId, tenantId: ctx.tenantId, status: v.status },
                data: { status: 'RETIRED', retiredAt: new Date(), retiredByUserId: ctx.userId, retiredReason: 'WITHDRAWN' },
            });
            if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being retired.');
            await logEvent(db, ctx, {
                action: 'TENANT_SKILL_RETIRED',
                entityType: 'TenantSkillVersion',
                entityId: versionId,
                details: `Retired version ${v.version} of tenant skill ${v.skill.name}`,
                detailsJson: {
                    category: 'access',
                    entityName: 'TenantSkillVersion',
                    operation: 'updated',
                    before: { status: v.status },
                    after: { status: 'RETIRED', retiredReason: 'WITHDRAWN', name: v.skill.name, version: v.version, contentHash: v.contentHash },
                },
            });
            return { status: 'RETIRED' as const };
        });
    });
}

async function findVersionStamps(db: PrismaTx, ctx: RequestContext, skillId: string, versionId: string) {
    const v = await db.tenantSkillVersion.findFirst({
        where: { id: versionId, skillId, tenantId: ctx.tenantId },
        select: { ...VERSION_STAMP_SELECT, skill: { select: { name: true } } },
    });
    if (!v) throw refuse('VERSION_NOT_FOUND', 'Tenant skill version not found.');
    return v;
}

// ─── Reads ──────────────────────────────────────────────────────────

/** A version as the review surface shows it. Text only when the scan passes it. */
export interface TenantSkillVersionView {
    id: string;
    version: number;
    status: TenantSkillVersionForMount['status'];
    retiredReason: 'REJECTED' | 'SUPERSEDED' | 'WITHDRAWN' | null;
    contentHash: string;
    workflowKeys: string[];
    license: string;
    sourceRef: string;
    requiredInput: string | null;
    output: string | null;
    controls: string | null;
    tools: string | null;
    /** Null when the scan refuses the version: its text is never returned. */
    description: string | null;
    instructions: string | null;
    textRefused: { rules: string[]; guardRules: string[] } | null;
    author: { userId: string; label: string | null; isViewer: boolean };
    evaluation:
        | null
        | {
            attachedAt: string;
            attachedBy: { userId: string; label: string | null };
            check: RecordSummary | { ok: false; reason: string; detail: string };
        };
    submittedAt: string | null;
    approvedAt: string | null;
    approvedBy: { userId: string; label: string | null } | null;
    retiredAt: string | null;
    createdAt: string;
    /** Whether the viewer may approve it: in review, not their own, and a person. */
    canApprove: boolean;
    /** For an APPROVED version: whether a run would mount it now, or why not. */
    mount: { ok: true } | { ok: false; reason: string } | null;
}

export interface TenantSkillDetail {
    id: string;
    name: string;
    createdAt: string;
    versions: TenantSkillVersionView[];
}

/** How many versions a review surface shows, newest first. */
const DETAIL_VERSIONS = 50;

/** One skill with its versions, for a holder of the review key. */
export async function getTenantSkill(ctx: RequestContext, skillId: string): Promise<TenantSkillDetail> {
    assertMayReadTenantSkill(ctx);
    return runInTenantContext(ctx, async (db) => {
        const skill = await db.tenantSkill.findFirst({
            where: { id: skillId, tenantId: ctx.tenantId },
            select: { id: true, name: true, createdAt: true },
        });
        if (!skill) throw refuse('SKILL_NOT_FOUND', 'Tenant skill not found.');
        const rows = await db.tenantSkillVersion.findMany({
            where: { tenantId: ctx.tenantId, skillId },
            orderBy: { version: 'desc' },
            take: DETAIL_VERSIONS,
            select: {
                ...TENANT_SKILL_MOUNT_SELECT,
                retiredReason: true,
                evaluationAttachedAt: true,
                evaluationAttachedByUserId: true,
                submittedAt: true,
                approvedAt: true,
                retiredAt: true,
                createdAt: true,
            },
        });
        const userIds = [
            ...new Set(rows.flatMap((r) => [r.authorUserId, r.evaluationAttachedByUserId, r.approvedByUserId]).filter((u): u is string => !!u)),
        ];
        const labels = await memberLabels(db, ctx, userIds);
        const label = (userId: string) => ({ userId, label: labels.get(userId) ?? null });

        const versions = rows.map((r): TenantSkillVersionView => {
            const v = toMountInput(r);
            let loaded: ReturnType<typeof tenantSkillAsLoaded> | null = null;
            let textRefused: TenantSkillVersionView['textRefused'] = null;
            try {
                loaded = tenantSkillAsLoaded(v);
            } catch (err) {
                if (err instanceof SkillTextRefusedError) textRefused = { rules: [...err.rules], guardRules: [...err.guardRules] };
            }
            const check = loaded && r.evaluationRecordJson !== null ? evaluateTenantRecord(r.evaluationRecordJson, loaded) : null;
            const verdict = v.status === 'APPROVED' ? checkTenantSkillMountable(v) : null;
            return {
                id: r.id,
                version: r.version,
                status: r.status,
                retiredReason: r.retiredReason,
                contentHash: r.contentHash,
                workflowKeys: r.workflowKeys,
                license: r.license,
                sourceRef: r.sourceRef,
                requiredInput: r.requiredInput,
                output: r.output,
                controls: r.controls,
                tools: r.tools,
                description: textRefused ? null : r.description,
                instructions: textRefused ? null : r.instructions,
                textRefused,
                author: { ...label(r.authorUserId), isViewer: r.authorUserId === ctx.userId },
                evaluation:
                    r.evaluationAttachedAt && r.evaluationAttachedByUserId
                        ? {
                            attachedAt: r.evaluationAttachedAt.toISOString(),
                            attachedBy: label(r.evaluationAttachedByUserId),
                            check:
                                check === null
                                    ? { ok: false, reason: 'TEXT_REFUSED', detail: 'the version text is refused by the scan' }
                                    : check.ok
                                        ? { rates: { ...check.rates }, model: { ...check.model }, ranAt: check.ranAt, caseCount: check.caseCount }
                                        : { ok: false, reason: check.reason, detail: check.detail },
                        }
                        : null,
                submittedAt: r.submittedAt?.toISOString() ?? null,
                approvedAt: r.approvedAt?.toISOString() ?? null,
                approvedBy: r.approvedByUserId ? label(r.approvedByUserId) : null,
                retiredAt: r.retiredAt?.toISOString() ?? null,
                createdAt: r.createdAt.toISOString(),
                // The review key too (#3778): a reader who holds only the
                // authoring half is not offered an approval it cannot make.
                canApprove:
                    r.status === 'IN_REVIEW'
                    && r.authorUserId !== ctx.userId
                    && !ctx.apiKeyId
                    && ctx.appPermissions?.admin?.agent_skill_review === true,
                mount:
                    verdict === null
                        ? null
                        : verdict.ok
                            ? { ok: true }
                            : { ok: false, reason: verdict.kind === 'refused' ? 'TEXT_REFUSED' : verdict.reason },
            };
        });
        return { id: skill.id, name: skill.name, createdAt: skill.createdAt.toISOString(), versions };
    });
}

/** Display labels for members of this tenant, by user id. Unknown ids are absent. */
async function memberLabels(db: PrismaTx, ctx: RequestContext, userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const members = await db.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, userId: { in: userIds } },
        select: { userId: true, user: { select: { name: true, email: true } } },
        take: userIds.length,
    });
    return new Map(members.map((m) => [m.userId, m.user.name ?? m.user.email]));
}

/** A tenant skill as the Skills tab lists it. No instructions, ever. */
export interface TenantSkillSummary {
    id: string;
    name: string;
    /** The version in service, or null. */
    inService: {
        versionId: string;
        version: number;
        license: string;
        sourceRef: string;
        /** Null when the scan refuses it. */
        description: string | null;
        workflowKeys: string[];
        instructionBytes: number;
        /** Whether a run would mount it now, or the reason it would refuse. */
        mount: { ok: true } | { ok: false; reason: string };
    } | null;
    /** The open version (DRAFT or IN_REVIEW), or null. */
    open: { versionId: string; version: number; status: 'DRAFT' | 'IN_REVIEW' } | null;
    /** Rule ids, when the scan refuses the version in service or the open one. */
    refused: { rules: string[]; guardRules: string[] } | null;
}

/** How many tenant skills the tab lists. */
const LIST_SKILLS = 200;

/**
 * This tenant's skills for the Skills tab: what is in service, what is open,
 * and what the scan refuses. Readable by anyone the tab's route admits
 * (`admin.agent_registry`): it carries no instructions, and a refused version's
 * description is withheld too.
 */
export async function listTenantSkillSummaries(ctx: RequestContext): Promise<TenantSkillSummary[]> {
    if (ctx.permissions.canRead !== true) {
        throw new AppError('You do not have permission to read records in this context.', 'FORBIDDEN', 403, true);
    }
    const skills = await runInTenantContext(ctx, (db) =>
        db.tenantSkill.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { name: 'asc' },
            take: LIST_SKILLS,
            select: {
                id: true,
                name: true,
                versions: {
                    where: { status: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] } },
                    orderBy: { version: 'desc' },
                    // One APPROVED and one open, by the partial unique indexes.
                    take: 2,
                    select: TENANT_SKILL_MOUNT_SELECT,
                },
            },
        }),
    );
    return skills.map((s) => {
        const versions = s.versions.map(toMountInput);
        let refused: TenantSkillSummary['refused'] = null;
        const scanRefusal = (v: TenantSkillVersionForMount) => {
            try {
                tenantSkillAsLoaded(v);
                return null;
            } catch (err) {
                return err instanceof SkillTextRefusedError ? { rules: [...err.rules], guardRules: [...err.guardRules] } : null;
            }
        };
        const approved = versions.find((v) => v.status === 'APPROVED') ?? null;
        const open = versions.find((v) => v.status === 'DRAFT' || v.status === 'IN_REVIEW') ?? null;
        let inService: TenantSkillSummary['inService'] = null;
        if (approved) {
            const r = scanRefusal(approved);
            if (r) refused = r;
            const verdict = checkTenantSkillMountable(approved);
            inService = {
                versionId: approved.versionId,
                version: approved.version,
                license: approved.license,
                sourceRef: approved.sourceRef,
                description: r ? null : approved.description,
                workflowKeys: [...approved.workflowKeys],
                instructionBytes: Buffer.byteLength(approved.instructions, 'utf8'),
                mount: verdict.ok ? { ok: true } : { ok: false, reason: verdict.kind === 'refused' ? 'TEXT_REFUSED' : verdict.reason },
            };
        }
        if (open && !refused) refused = scanRefusal(open);
        return {
            id: s.id,
            name: s.name,
            inService,
            open: open ? { versionId: open.versionId, version: open.version, status: open.status as 'DRAFT' | 'IN_REVIEW' } : null,
            refused,
        };
    });
}

/**
 * The catalogue line of every skill this tenant has IN SERVICE, for the Skills
 * tab's per-workflow figure: the budget counts repository and tenant skills
 * together. A version the gate refuses costs nothing, because no run gets far
 * enough to mount it.
 */
export function tenantCatalogueEntries(summaries: readonly TenantSkillSummary[]): TenantCatalogueEntry[] {
    return summaries.flatMap((s) =>
        s.inService && s.inService.mount.ok && s.inService.description !== null
            ? [{ name: s.name, description: s.inService.description, workflowKeys: s.inService.workflowKeys }]
            : [],
    );
}
