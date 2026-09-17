/**
 * Enum member ORDER must agree between `prisma/migrations` and `prisma/schema`.
 *
 * ─── The gap this closes (#2475) ────────────────────────────────────
 *
 * `scripts/check-fresh-db-schema-drift.mjs` is the gate everyone trusts to
 * catch schema/migration disagreement. It runs `prisma migrate diff`, and
 * `migrate diff` COMPARES ENUM VALUES AS A SET, NOT A SEQUENCE. A migration
 * and a schema that agree on the members and disagree on their order produce
 * no drift at all.
 *
 * Measured on 2026-09-11 in PR #2477, which added two `NotificationType`
 * members: the migration is `ALTER TYPE … ADD VALUE IF NOT EXISTS`, twice,
 * which APPENDS, so a freshly-migrated database ends `[… TASK_REVIEW_REQUESTED,
 * GENERAL, AGENT_KILL_SWITCH_ENGAGED, AGENT_PROPOSAL_QUARANTINED]` while
 * `prisma/schema/enums.prisma` declares `[… TASK_REVIEW_REQUESTED,
 * AGENT_KILL_SWITCH_ENGAGED, AGENT_PROPOSAL_QUARANTINED, GENERAL]`. The gate
 * printed `✓ matches the committed residue — 10 statement(s) compared` and the
 * residue did not move.
 *
 * ─── Why order is not cosmetic ──────────────────────────────────────
 *
 * A Postgres enum is an ORDERED type. Member order is part of the type's
 * identity: each member has an ordinal, `<`/`>` between members compares
 * ordinals, and `ORDER BY <enum column>` sorts by ordinal — never
 * alphabetically, never by what `prisma/schema` happens to declare. Inserting
 * a member mid-list therefore renumbers every member after it.
 *
 * THAT IS NOT HYPOTHETICAL HERE, and this is the one claim in #2475 that this
 * file corrects rather than restates. The issue says "nothing in the product
 * currently depends on enum member order", which is true of `NotificationType`
 * and false of the schema as a whole. Re-measured against the repository:
 * SEVEN enum-typed columns are sorted by the database today, listed in
 * `ORDINAL_SENSITIVE` below, and for four of them the ordering is plainly
 * deliberate semantics rather than an arbitrary tiebreak —
 * `Task.priority asc` puts P0 first, `Vendor.criticality desc` puts CRITICAL
 * first, `Employee.status asc` puts ACTIVE first, `TrainingAssignment.status
 * asc` puts ASSIGNED first. Insert a member into the middle of any of those
 * four and the list silently reorders in the UI. Nothing else in the repo
 * would say so: there is no test on the ordinal, because the ordinal was
 * never something anyone declared.
 *
 * ─── What is asserted ───────────────────────────────────────────────
 *
 *  1. THE PARSER IS NOT BLIND. Any `CREATE`/`ALTER`/`DROP TYPE` statement no
 *     pattern consumed fails the suite. An unreadable shape silently shrinks
 *     the population, and a guard over a population that quietly emptied is
 *     the failure this repo has already paid for more than once.
 *  2. Every declared enum is reconstructible, and the member SETS agree.
 *     Order is only meaningful once the sets do; a set difference is reported
 *     as its own failure rather than as a confusing order failure.
 *  3. The set of order-disagreeing enums equals `SIGNED_OFF` EXACTLY — floor
 *     and ceiling — and each signed-off entry's two orders are pinned
 *     VERBATIM. A count would answer "how many"; the verbatim pin answers
 *     "which", which is the question a member inserted into an
 *     already-drifted enum still satisfies the count of.
 *  4. No `ORDINAL_SENSITIVE` enum may be signed off, ever. That list is the
 *     subset where a sign-off is refused outright instead of argued for.
 *
 * ─── Why a sign-off list and not "must be empty" ────────────────────
 *
 * Because Postgres cannot reorder an existing enum. There is no
 * `ALTER TYPE … SET ORDER`; fixing one of the four below means recreating the
 * type, which means dropping every dependent column's type binding. For four
 * enums that nothing sorts, that migration would be a large risk bought to
 * buy nothing. "Must be empty" would be a gate nobody can satisfy, and a gate
 * that cannot go green gets deleted — so the four are named, with both
 * orders, and everything else must agree.
 *
 * THE OTHER DIRECTION MATTERS EQUALLY. If one of the four stops disagreeing,
 * this file goes red too, because a stale sign-off is an allowance sitting
 * over a tree that no longer needs it — exactly the headroom the next
 * regression lands in.
 *
 * ─── When this fires on a member you just added ─────────────────────
 *
 * You inserted it in the middle of the `enum { }` block and the migration
 * appended it. Two honest fixes:
 *
 *   • put the member LAST in `prisma/schema` so the append matches, or
 *   • write the migration to place it where the schema declares it:
 *     `ALTER TYPE "T" ADD VALUE IF NOT EXISTS 'X' BEFORE 'Y';`
 *
 * `ADD VALUE … BEFORE/AFTER` keeps the rolling-deploy property plain
 * `ADD VALUE` has — nothing renamed, nothing dropped, old containers keep
 * reading every value they know. Three migrations in this repo already use it.
 * Adding your enum to `SIGNED_OFF` is NOT the fix.
 */
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { enumOrderReport } from '../helpers/prisma-enum-order';

/**
 * The enums whose ordinals are load-bearing TODAY, because something sorts a
 * column of that type in the database.
 *
 * Derived by resolving every `orderBy: { <field>: 'asc' | 'desc' }` in `src/`
 * to the Prisma delegate it belongs to, then that model's field to its enum
 * type. Name-matching alone is useless here — `status` is a field on forty
 * models — so the delegate is what makes the population honest.
 *
 * The call sites, as measured on 2026-09-17:
 *   Device.platform                 src/app-layer/usecases/device.ts:45
 *   Employee.status                 src/app-layer/usecases/personnel.ts:60
 *   OrgSecurityInitiative.status    src/app-layer/usecases/org-security-initiative.ts:173
 *   TenantMembership.role           src/app-layer/jobs/agent-kill-switch-drill.ts:443
 *                                   src/app-layer/jobs/agentic-evidence-emission.ts:104
 *                                   src/app-layer/jobs/compliance-posture-summary.ts:45
 *   TrainingAssignment.status       src/app-layer/usecases/training.ts:31
 *   Vendor.criticality              src/app-layer/repositories/VendorRepository.ts:100, :115
 *   Task.priority                   src/app-layer/repositories/TaskRepository.ts:179
 *
 * THE LINE NUMBERS ARE PROSE AND WILL ROT; the `model`/`field` pair below is
 * re-derived from `prisma/schema` on every run, so a renamed field or a
 * retyped column turns this red rather than turning the entry vacuous. What
 * is NOT re-derived is the existence of the `orderBy` itself — a NEW sort on
 * some other enum column will not add itself here. That is a known limit and
 * it is survivable, because the general assertion below already covers all
 * 140 enums; this list only marks where a sign-off is refused rather than
 * argued.
 */
const ORDINAL_SENSITIVE: ReadonlyArray<{
    model: string;
    field: string;
    prismaEnum: string;
}> = [
    { model: 'Device', field: 'platform', prismaEnum: 'DevicePlatform' },
    { model: 'Employee', field: 'status', prismaEnum: 'EmploymentStatus' },
    { model: 'OrgSecurityInitiative', field: 'status', prismaEnum: 'InitiativeStatus' },
    { model: 'TenantMembership', field: 'role', prismaEnum: 'Role' },
    { model: 'TrainingAssignment', field: 'status', prismaEnum: 'TrainingStatus' },
    { model: 'Vendor', field: 'criticality', prismaEnum: 'VendorCriticality' },
    { model: 'Task', field: 'priority', prismaEnum: 'TaskPriority' },
];

/**
 * The four enums whose schema order and migration order disagree today, each
 * with BOTH orders written out.
 *
 * Signing off is an edit to TEST CODE. Widening the allowance means coming
 * here, naming the type and pasting both sequences — an argument a reviewer
 * sees, not a number they skim. Every one of the four is inert: no `orderBy`
 * anywhere resolves to any of them, which is the only reason they are
 * tolerable.
 *
 *   EmailNotificationType  — `EXCEPTION_EXPIRING` and
 *     `ACCESS_REVIEW_OVERDUE_ESCALATION` were appended in the opposite order
 *     to the block, and `POLICY_REVIEW_DUE` was appended by a migration while
 *     the block lists it beside the other POLICY_* members.
 *   FrameworkKind — `EU_DIRECTIVE` is declared fourth, appended second.
 *   IdentityWriteOutcome — `REVERTED` and `INDETERMINATE` are transposed.
 *   NotificationType — the #2475 case itself: `GENERAL` is declared last and
 *     physically sits tenth, and `CONTROL_ASSIGNED`/`RISK_ASSIGNED`/
 *     `ASSET_ASSIGNED` are declared before `TASK_DUE` and appended after it.
 *
 * ADDING A MEMBER TO ANY OF THESE FOUR WILL TURN THIS RED even when you do it
 * correctly, because both pinned sequences grow. That is deliberate: the
 * person extending an already-drifted enum is exactly the person who should
 * be looking at its ordinals. Update the pin in the same diff.
 */
const SIGNED_OFF: ReadonlyArray<{
    physicalName: string;
    schemaOrder: readonly string[];
    migrationOrder: readonly string[];
}> = [
    {
        physicalName: 'EmailNotificationType',
        schemaOrder: [
            'TASK_ASSIGNED',
            'EVIDENCE_EXPIRING',
            'POLICY_APPROVAL_REQUESTED',
            'POLICY_APPROVED',
            'POLICY_REJECTED',
            'POLICY_REVIEW_DUE',
            'DEADLINE_DIGEST',
            'EVIDENCE_EXPIRY_DIGEST',
            'VENDOR_RENEWAL_DIGEST',
            'VENDOR_ASSESSMENT_INVITATION',
            'VENDOR_ASSESSMENT_REMINDER',
            'VENDOR_ASSESSMENT_SUBMITTED',
            'VENDOR_ASSESSMENT_REVIEWED',
            'ACCESS_REVIEW_REMINDER',
            'ACCESS_REVIEW_OVERDUE_ESCALATION',
            'EXCEPTION_EXPIRING',
            'IDENTITY_LEAVER_DISABLED',
            'IDENTITY_LEAVER_UNCONFIRMED',
            'IDENTITY_LEAVER_NEEDS_ACTION',
        ],
        migrationOrder: [
            'TASK_ASSIGNED',
            'EVIDENCE_EXPIRING',
            'POLICY_APPROVAL_REQUESTED',
            'POLICY_APPROVED',
            'POLICY_REJECTED',
            'DEADLINE_DIGEST',
            'EVIDENCE_EXPIRY_DIGEST',
            'VENDOR_RENEWAL_DIGEST',
            'VENDOR_ASSESSMENT_INVITATION',
            'VENDOR_ASSESSMENT_REMINDER',
            'VENDOR_ASSESSMENT_SUBMITTED',
            'VENDOR_ASSESSMENT_REVIEWED',
            'ACCESS_REVIEW_REMINDER',
            'EXCEPTION_EXPIRING',
            'ACCESS_REVIEW_OVERDUE_ESCALATION',
            'POLICY_REVIEW_DUE',
            'IDENTITY_LEAVER_DISABLED',
            'IDENTITY_LEAVER_UNCONFIRMED',
            'IDENTITY_LEAVER_NEEDS_ACTION',
        ],
    },
    {
        physicalName: 'FrameworkKind',
        schemaOrder: [
            'ISO_STANDARD',
            'NIST_FRAMEWORK',
            'SOC_CRITERIA',
            'EU_DIRECTIVE',
            'REGULATION',
            'INDUSTRY_STANDARD',
            'CUSTOM',
        ],
        migrationOrder: [
            'ISO_STANDARD',
            'EU_DIRECTIVE',
            'NIST_FRAMEWORK',
            'SOC_CRITERIA',
            'REGULATION',
            'INDUSTRY_STANDARD',
            'CUSTOM',
        ],
    },
    {
        physicalName: 'IdentityWriteOutcome',
        schemaOrder: ['PENDING', 'APPLIED', 'FAILED', 'INDETERMINATE', 'REVERTED'],
        migrationOrder: ['PENDING', 'APPLIED', 'FAILED', 'REVERTED', 'INDETERMINATE'],
    },
    {
        physicalName: 'NotificationType',
        schemaOrder: [
            'EVIDENCE_DUE_SOON',
            'EVIDENCE_OVERDUE',
            'EVIDENCE_REJECTED',
            'EVIDENCE_APPROVED',
            'POLICY_APPROVAL_NEEDED',
            'POLICY_ACKNOWLEDGED',
            'FINDING_ASSIGNED',
            'FINDING_VERIFIED',
            'TASK_ASSIGNED',
            'CONTROL_ASSIGNED',
            'RISK_ASSIGNED',
            'ASSET_ASSIGNED',
            'TASK_DUE',
            'VENDOR_REVIEW_DUE',
            'INCIDENT_DEADLINE_DUE',
            'INCIDENT_DEADLINE_OVERDUE',
            'VENDOR_POSTURE_ALERT',
            'TASK_WATCH_UPDATE',
            'TASK_REVIEW_REQUESTED',
            'AGENT_KILL_SWITCH_ENGAGED',
            'AGENT_PROPOSAL_QUARANTINED',
            'GENERAL',
        ],
        migrationOrder: [
            'EVIDENCE_DUE_SOON',
            'EVIDENCE_OVERDUE',
            'EVIDENCE_REJECTED',
            'EVIDENCE_APPROVED',
            'POLICY_APPROVAL_NEEDED',
            'POLICY_ACKNOWLEDGED',
            'FINDING_ASSIGNED',
            'FINDING_VERIFIED',
            'TASK_ASSIGNED',
            'GENERAL',
            'TASK_DUE',
            'VENDOR_REVIEW_DUE',
            'CONTROL_ASSIGNED',
            'RISK_ASSIGNED',
            'ASSET_ASSIGNED',
            'INCIDENT_DEADLINE_DUE',
            'INCIDENT_DEADLINE_OVERDUE',
            'VENDOR_POSTURE_ALERT',
            'TASK_WATCH_UPDATE',
            'TASK_REVIEW_REQUESTED',
            'AGENT_KILL_SWITCH_ENGAGED',
            'AGENT_PROPOSAL_QUARANTINED',
        ],
    },
];

const signedOffNames = (): string[] => SIGNED_OFF.map((s) => s.physicalName).sort();

describe('enum member order — migrations vs prisma/schema', () => {
    it('reports its own denominator (an empty population is not a pass)', () => {
        const r = enumOrderReport();
        // Every number the assertions below rest on, printed beside them.
        // A parser that suddenly reads 3 migrations and 0 enums would satisfy
        // every `toEqual([])` in this file.
        expect(r.migrationsReplayed).toBeGreaterThanOrEqual(287);
        expect(r.declared.length).toBeGreaterThanOrEqual(140);
        expect(r.reconstructed.size).toBeGreaterThanOrEqual(140);
        // The comparison actually reached every declared enum: nothing was
        // skipped into silence between parsing and comparing.
        const compared =
            r.declared.length -
            r.missingFromMigrations.length -
            r.memberSetDifferences.length;
        expect(compared).toBe(r.declared.length);
    });

    it('reads every enum DDL statement in every migration (no blind shapes)', () => {
        // A statement the parser cannot read drops its enum out of the
        // comparison, and the symptom is a GREEN guard over a smaller
        // population. 21 of this repo's enum statements live inside
        // `DO $$ … $$` blocks; a splitter that treats a dollar body as opaque
        // misses all 21 and still reports success.
        expect(enumOrderReport().unreadableDdl).toEqual([]);
    });

    it('every `ADD VALUE … BEFORE/AFTER` names an anchor that exists', () => {
        // Postgres raises 22023 on a missing anchor, so one of these is a
        // migration that cannot apply — and it would also mean the
        // reconstructed order below is a guess rather than a reading.
        expect(enumOrderReport().danglingAnchors).toEqual([]);
    });

    it('every enum in prisma/schema is created by some migration', () => {
        expect(enumOrderReport().missingFromMigrations).toEqual([]);
    });

    it('member SETS agree — the precondition for comparing order', () => {
        // The live `Schema drift` gate covers this too, but only with a
        // database. Here it is static, so a schema-only member addition is
        // caught in the guardrail suite rather than at the CI database step.
        expect(enumOrderReport().memberSetDifferences).toEqual([]);
    });

    it('exactly the signed-off enums disagree on ORDER — floor and ceiling', () => {
        const drifted = enumOrderReport()
            .orderDifferences.map((d) => d.physicalName)
            .sort();
        // Set equality, in one assertion, so the two directions cannot
        // disagree with each other:
        //   an enum that newly drifts        -> appears here, unsigned
        //   a signed-off enum that is fixed  -> disappears, stale sign-off
        expect(drifted).toEqual(signedOffNames());
    });

    it('each signed-off enum drifts in exactly the way it was signed off for', () => {
        // The verbatim pin. Without it, a member inserted into the middle of
        // an ALREADY-drifted enum changes the ordinals of everything after it
        // and the assertion above still passes: same name, same count, new
        // defect. This is the `ON DELETE RESTRICT -> CASCADE` lesson from
        // `schema-drift-gate-runs-in-ci.test.ts`, in the order axis.
        const actual = enumOrderReport().orderDifferences.map((d) => ({
            physicalName: d.physicalName,
            schemaOrder: d.schemaOrder,
            migrationOrder: d.migrationOrder,
        }));
        expect(actual).toEqual(
            SIGNED_OFF.map((s) => ({
                physicalName: s.physicalName,
                schemaOrder: [...s.schemaOrder],
                migrationOrder: [...s.migrationOrder],
            })),
        );
    });

    describe('enums whose ordinals are load-bearing', () => {
        it('each named model/field still carries the enum it is listed for', () => {
            // Re-derived, not cited. A renamed field or a column retyped to
            // String would otherwise leave an entry below pointing at nothing
            // while every assertion around it stayed green.
            const models = new Map(parseSchemaModels().map((m) => [m.name, m]));
            const broken = ORDINAL_SENSITIVE.filter(
                (o) =>
                    models.get(o.model)?.fields.find((f) => f.name === o.field)?.type !==
                    o.prismaEnum,
            ).map((o) => `${o.model}.${o.field}: ${o.prismaEnum}`);
            expect(broken).toEqual([]);
        });

        it('none of them may be signed off for order drift', () => {
            // The clause that makes a sign-off list safe. Everything else here
            // is negotiable by argument; this is not. If a future diff needs
            // one of these in SIGNED_OFF, the answer is to fix the order, not
            // to widen the allowance — the column is sorted by ordinal in
            // production.
            const declared = new Map(
                enumOrderReport().declared.map((e) => [e.prismaName, e.physicalName]),
            );
            const signed = new Set(signedOffNames());
            const refused = ORDINAL_SENSITIVE.filter((o) =>
                signed.has(declared.get(o.prismaEnum) ?? o.prismaEnum),
            ).map((o) => o.prismaEnum);
            expect(refused).toEqual([]);
        });

        it('and none of them drifts', () => {
            // Belt and braces with the two above, and the one that would fire
            // first: this fails the moment a sorted enum's order moves, before
            // anyone gets as far as trying to sign it off.
            const declared = new Map(
                enumOrderReport().declared.map((e) => [e.prismaName, e.physicalName]),
            );
            const drifted = new Set(
                enumOrderReport().orderDifferences.map((d) => d.physicalName),
            );
            const bad = ORDINAL_SENSITIVE.filter((o) =>
                drifted.has(declared.get(o.prismaEnum) ?? o.prismaEnum),
            ).map((o) => `${o.prismaEnum} (${o.model}.${o.field})`);
            expect(bad).toEqual([]);
        });
    });
});
