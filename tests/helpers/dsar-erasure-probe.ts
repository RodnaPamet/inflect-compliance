/**
 * DB-free probe + invariant oracle for the DSAR erasure cascade
 * (`src/app-layer/jobs/dsar-erasure.ts` — GDPR Art. 17 right-to-erasure).
 *
 * WHY THIS EXISTS (#2287, from #2246 Class A). The guard that claimed to hold
 * "erasure PSEUDONYMIZES audit rows, it does not DELETE them" was two
 * source-text needles:
 *
 *     expect(erasure).toMatch(/userId\s*=\s*NULL/i);
 *     expect(erasure).toMatch(/NOT deletion|not delet/i);
 *
 * Both strings live only in the JSDoc of `eraseUser`. Measured both ways on
 * the pre-#2246 guard: with the prose present and the body replaced by
 * `prisma.auditLog.deleteMany({ where: { userId } })` the file was 7/7 GREEN;
 * with the prose removed and a CORRECT pseudonymizing body in place it went
 * RED. The assertion tracked the paragraph, not the behaviour — so it is
 * replaced here by something that runs the code and looks at the result.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS CAN AND CANNOT PROVE — read before adding an assertion
 *
 * Erasure is a Stage-1 stub: `eraseUser` throws unconditionally and is not
 * registered with any scheduler. There is therefore NO erasure behaviour in
 * this repo to verify, and no test in this file may claim otherwise.
 *
 * What the probe does instead, in two clearly separated parts:
 *
 *   (1) TODAY — `driveErasure()` calls the real `eraseUser` with an
 *       instrumented, in-memory Prisma-shaped client and reports what it did.
 *       Today's answer is `REFUSED` with zero recorded operations. That is a
 *       BEHAVIOURAL observation (the function ran and refused), not a reading
 *       of its source, and it cannot be satisfied by a comment.
 *
 *   (2) WHEN STAGE 3 LANDS — `erasureViolations()` grades an executed run
 *       against the invariant. It is wired to the real `eraseUser` NOW, so the
 *       day that function starts doing work the grading is already in the
 *       path. Until then it grades nothing real, which is why the oracle's own
 *       discrimination is proved on synthetic implementations driven through
 *       this same harness (see the `B.` tests in
 *       tests/guardrails/dsar-workflow-coverage.test.ts). A "pass" produced by
 *       a run that never executed is reported as `REFUSED`, never as
 *       "invariant satisfied".
 *
 * THE ANTI-VACUITY RULES. A probe that observes nothing looks exactly like a
 * probe that observed compliance, which is the defect class this file exists
 * to close. So:
 *   - an implementation that neither refuses nor touches the injected client
 *     is `UNOBSERVED`, and the guard FAILS on it (the probe is not wired to
 *     whatever seam the implementation chose — fix the wiring, do not relax
 *     the assertion);
 *   - raw SQL against AuditLog is recorded and flagged `UNVERIFIABLE_RAW_SQL`
 *     rather than ignored — an in-memory store cannot execute SQL, so its
 *     unchanged contents are not evidence of anything;
 *   - a write against a table whose disposition is not declared in
 *     `ERASURE_DISPOSITIONS` is `UNDECLARED_TABLE_TOUCHED`: the cascade may
 *     not widen silently.
 *
 * DB-FREE, deliberately: this runs in the `Ratchets` CI job, which has no
 * database. Do not reach for `prismaTestClient` here. The DB-level half of the
 * story (the `IMMUTABLE_AUDIT_LOG` trigger that refuses UPDATE and DELETE on
 * `AuditLog`) is covered by tests/integration/audit-immutability.test.ts.
 */
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';

// ─── The invariant, in this codebase's terms ────────────────────────────
//
// GDPR Art. 17 requires the subject's personal data be erased. Art. 17(3)(b)
// preserves processing necessary for compliance with a legal obligation — the
// audit trail is that obligation (docs/dsar.md § "Audit-log pseudonymization
// (not deletion)"). The reconciliation is pseudonymization: the RECORD OF THE
// ACTION survives, the IDENTITY OF THE ACTOR does not.
//
// Concretely, for `AuditLog`:
//   MUST survive   — the row itself, and every column of it except `userId`
//                    (`entryHash` / `previousHash` carry the hash chain;
//                    rewriting any of them forges history).
//   MUST be gone   — the link to the subject: `userId` ends NULL.
//                    (`AuditLog.userId` is `String?` and its FK is
//                    `ON DELETE SET NULL` — prisma/schema/audit-trail.prisma:29,45
//                    and prisma/migrations/20260308190244_init/migration.sql:927 —
//                    so NULL is a representable, schema-sanctioned state.)
//   MUST NOT move  — any other user's rows.

/** What erasure is allowed to do to a table it touches. */
export type Disposition = 'PSEUDONYMIZE' | 'DELETE';

/**
 * Per-table disposition, Prisma delegate name → disposition. Deliberately
 * SHORT: every entry is sourced, and a table that is not listed makes the
 * guard fail rather than pass, so Stage 3 must declare each table it touches
 * instead of inheriting a blanket claim.
 *
 *   auditLog — PSEUDONYMIZE. docs/dsar.md § "Audit-log pseudonymization (not
 *     deletion)"; `AuditLog.userId String?` with FK ON DELETE SET NULL.
 *   user     — DELETE. The `eraseUser` JSDoc, Stage 2: "Hard-delete the User
 *     row". This is the subject's own identity record.
 *   session / account — DELETE. Same JSDoc clause ("its `onDelete: Cascade`
 *     children"); both FKs are ON DELETE CASCADE in the init migration
 *     (lines 819 and 816), so they go with the User row by definition.
 *
 * NOTE the deliberate omissions. Authored content (`Task`, `Control`,
 * `Policy`, … — ON DELETE SET NULL) is "retained, attribution anonymized"
 * per docs/dsar.md § "What happens to authored content", and several
 * User-referencing FKs are ON DELETE RESTRICT (`TenantMembership`,
 * `Notification`, `PolicyAcknowledgement`, …), which means the Stage 2
 * hard-delete cannot succeed until they are resolved. Neither disposition is
 * settled anywhere this file can cite, so neither is asserted: an erasure
 * that touches those tables trips `UNDECLARED_TABLE_TOUCHED` and the author
 * declares it then, with a source.
 */
export const ERASURE_DISPOSITIONS: Record<string, Disposition> = {
    auditLog: 'PSEUDONYMIZE',
    user: 'DELETE',
    session: 'DELETE',
    account: 'DELETE',
};

/** The columns of an AuditLog row the probe models. */
export interface ProbeAuditRow {
    id: string;
    tenantId: string;
    userId: string | null;
    action: string;
    entity: string;
    entityId: string;
    createdAt: string;
    entryHash: string;
    previousHash: string | null;
    [column: string]: unknown;
}

export type ProbeRow = Record<string, unknown>;
export type ProbeStore = Record<string, ProbeRow[]>;

/** One database operation the implementation issued. */
export interface ProbeOp {
    /** Prisma delegate name, or `$raw` for a raw-SQL call. */
    table: string;
    /** Delegate method (`updateMany`, `deleteMany`, …) or the raw method. */
    method: string;
    /** Argument, as passed. */
    args: unknown;
    /** Rows the operation matched in the in-memory store. */
    matched: number;
}

export type ErasureOutcome = 'REFUSED' | 'EXECUTED' | 'UNOBSERVED' | 'ERRORED';

export interface ErasureRun {
    /**
     * REFUSED    — threw the Stage-1 "not enabled" error and wrote nothing.
     * EXECUTED   — issued at least one operation against the probe.
     * UNOBSERVED — returned without refusing and without touching the probe:
     *              the implementation reached a database this probe is not
     *              wired to. NOT a pass.
     * ERRORED    — threw something other than the Stage-1 refusal.
     */
    outcome: ErasureOutcome;
    /** The subject whose erasure was driven. */
    subjectId: string;
    /** Every operation issued, in order. */
    ops: ProbeOp[];
    /** Store contents before the drive (deep copy). */
    before: ProbeStore;
    /** Store contents after the drive (deep copy). */
    after: ProbeStore;
    /** The thrown error, if any. */
    error: Error | null;
}

export type ViolationCode =
    /** A delete/deleteMany was ISSUED against AuditLog — intent, regardless of
     *  how many rows the fixture happened to match. */
    | 'AUDIT_DELETE_ISSUED'
    /** An audit row present before the run is absent after it. */
    | 'AUDIT_ROW_DELETED'
    /** A surviving audit row still carries the subject's userId. */
    | 'SUBJECT_STILL_LINKED'
    /** A surviving audit row changed in some column other than `userId` —
     *  `entryHash`/`previousHash` included, which is the hash chain. */
    | 'AUDIT_HISTORY_MUTATED'
    /** A row belonging to another subject was modified or removed. */
    | 'FOREIGN_ROW_TOUCHED'
    /** Raw SQL touching AuditLog: the in-memory store cannot execute it, so
     *  its unchanged contents prove nothing. */
    | 'UNVERIFIABLE_RAW_SQL'
    /** A write against a table with no declared disposition. */
    | 'UNDECLARED_TABLE_TOUCHED'
    /** The implementation neither refused nor touched the probe — it returned
     *  silently, or threw something other than the Stage-1 refusal. Nothing
     *  was observed, so nothing can be graded. Never a pass. */
    | 'UNOBSERVED_EXECUTION';

export interface Violation {
    code: ViolationCode;
    detail: string;
}

// ─── The in-memory client ───────────────────────────────────────────────

const WRITE_METHODS = new Set([
    'create', 'createMany', 'update', 'updateMany',
    'upsert', 'delete', 'deleteMany',
]);

const DELETE_METHODS = new Set(['delete', 'deleteMany']);

/** Evaluates the subset of a Prisma `where` an erasure cascade would build. */
function matches(row: ProbeRow, where: unknown): boolean {
    if (where == null || typeof where !== 'object') return true;
    for (const [field, cond] of Object.entries(where as Record<string, unknown>)) {
        const value = row[field];
        if (cond === null) {
            if (value !== null && value !== undefined) return false;
            continue;
        }
        if (cond !== null && typeof cond === 'object') {
            const c = cond as { not?: unknown; in?: unknown[] };
            if ('not' in c) {
                if (c.not === null) {
                    if (value === null || value === undefined) return false;
                } else if (value === c.not) return false;
            }
            if (Array.isArray(c.in) && !c.in.includes(value)) return false;
            continue;
        }
        if (value !== cond) return false;
    }
    return true;
}

const copy = (store: ProbeStore): ProbeStore =>
    Object.fromEntries(
        Object.entries(store).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]),
    );

/**
 * A Prisma-shaped client backed by `store`, recording every call into `ops`.
 *
 * Every delegate access is proxied, so a table the implementation reaches for
 * that the fixture never seeded still resolves (and is recorded) instead of
 * throwing `undefined is not a function` — an implementation must be OBSERVED,
 * not crashed, or the run cannot be graded.
 */
export function makeErasureClient(store: ProbeStore, ops: ProbeOp[]): unknown {
    const rowsOf = (table: string): ProbeRow[] => (store[table] ??= []);

    const delegate = (table: string): Record<string, unknown> =>
        new Proxy(
            {},
            {
                get(_t, method: string | symbol) {
                    if (typeof method !== 'string') return undefined;
                    // A delegate must never look like a thenable.
                    if (method === 'then') return undefined;
                    return async (args: Record<string, unknown> = {}) => {
                        const rows = rowsOf(table);
                        const where = (args as { where?: unknown }).where;
                        const hit = rows.filter((r) => matches(r, where));
                        ops.push({ table, method, args, matched: hit.length });

                        if (method === 'findMany') return hit.map((r) => ({ ...r }));
                        if (method === 'findFirst' || method === 'findUnique') {
                            return hit[0] ? { ...hit[0] } : null;
                        }
                        if (method === 'count') return hit.length;
                        if (method === 'update' || method === 'updateMany') {
                            const data = (args.data ?? {}) as ProbeRow;
                            const targets = method === 'update' ? hit.slice(0, 1) : hit;
                            for (const r of targets) Object.assign(r, data);
                            return method === 'update' ? targets[0] : { count: targets.length };
                        }
                        if (DELETE_METHODS.has(method)) {
                            const targets = method === 'delete' ? hit.slice(0, 1) : hit;
                            store[table] = rows.filter((r) => !targets.includes(r));
                            return method === 'delete' ? targets[0] : { count: targets.length };
                        }
                        if (method === 'create') {
                            const row = (args.data ?? {}) as ProbeRow;
                            rows.push({ ...row });
                            return { ...row };
                        }
                        if (method === 'createMany') {
                            const data = (args.data ?? []) as ProbeRow[];
                            for (const row of data) rows.push({ ...row });
                            return { count: data.length };
                        }
                        return undefined;
                    };
                },
            },
        );

    const client: Record<string, unknown> = {};
    // `$transaction` must hand its callback the SAME client, so the proxy
    // refers to itself — legal because the handler only runs after assignment.
    const self: unknown = new Proxy(client, {
        get(target, prop: string | symbol) {
            if (typeof prop !== 'string') return undefined;
            // `await client` must not be mistaken for a thenable.
            if (prop === 'then') return undefined;
            if (prop.startsWith('$')) {
                if (prop === '$transaction') {
                    return async (arg: unknown) =>
                        typeof arg === 'function'
                            ? await (arg as (tx: unknown) => Promise<unknown>)(self)
                            : await Promise.all(arg as Promise<unknown>[]);
                }
                if (prop === '$connect' || prop === '$disconnect') {
                    return async () => undefined;
                }
                // $executeRaw / $queryRaw / …: recorded, never executed.
                return async (...args: unknown[]) => {
                    ops.push({ table: '$raw', method: prop, args, matched: 0 });
                    return 0;
                };
            }
            if (!(prop in target)) target[prop] = delegate(prop);
            return target[prop];
        },
    });
    return self;
}

// ─── The fixture ────────────────────────────────────────────────────────

export const SUBJECT_ID = 'user-subject-2287';
export const BYSTANDER_ID = 'user-bystander-2287';

/**
 * Audit rows for two users plus one already-anonymous row, across two
 * tenants. The bystander's rows are the blast-radius control: an erasure that
 * nulls every `userId` in the table "satisfies" a subject-only check while
 * destroying the attribution of everyone else.
 */
export function seedAuditRows(): ProbeAuditRow[] {
    const row = (
        id: string,
        userId: string | null,
        tenantId: string,
        action: string,
        previousHash: string | null,
    ): ProbeAuditRow => ({
        id,
        tenantId,
        userId,
        action,
        entity: 'Risk',
        entityId: `risk-${id}`,
        createdAt: `2026-08-0${id.slice(-1)}T00:00:00.000Z`,
        entryHash: `hash-${id}`,
        previousHash,
    });
    return [
        row('a1', SUBJECT_ID, 'tenant-1', 'RISK_CREATED', null),
        row('a2', BYSTANDER_ID, 'tenant-1', 'RISK_UPDATED', 'hash-a1'),
        row('a3', SUBJECT_ID, 'tenant-1', 'EVIDENCE_UPLOADED', 'hash-a2'),
        row('a4', SUBJECT_ID, 'tenant-2', 'DSAR_REQUESTED', null),
        row('a5', BYSTANDER_ID, 'tenant-2', 'CONTROL_TESTED', 'hash-a4'),
        row('a6', null, 'tenant-2', 'DATA_EXPIRED', 'hash-a5'),
    ];
}

function seedStore(): ProbeStore {
    return {
        auditLog: seedAuditRows() as unknown as ProbeRow[],
        user: [
            { id: SUBJECT_ID, email: 'subject@example.test', name: 'Subject' },
            { id: BYSTANDER_ID, email: 'bystander@example.test', name: 'Bystander' },
        ],
        session: [
            { id: 's1', userId: SUBJECT_ID },
            { id: 's2', userId: BYSTANDER_ID },
        ],
    };
}

/** Signature of a candidate erasure implementation (the real one, or a probe). */
export type ErasureImpl = (userId: string, options?: { db?: unknown }) => Promise<unknown>;

/**
 * The seam the probe injects through.
 *
 * `eraseUser` is a stub today and imports no client at all, so the shape
 * Stage 3 will use is unknown. Both plausible house shapes are covered:
 *   - the injectable-`db` option (`runRetentionSweep` in
 *     src/app-layer/jobs/data-lifecycle.ts takes `options.db`) — passed as the
 *     second argument here;
 *   - the `@/lib/prisma` singleton — the CALLER jest.mock()s that module onto
 *     `activeErasureClient()` (see dsar-workflow-coverage.test.ts).
 * If a Stage 3 implementation reaches a database through neither, the run is
 * `UNOBSERVED` and the guard fails asking for the wiring.
 */
let activeClient: unknown = null;

/** The client the `@/lib/prisma` mock should resolve to during a drive. */
export function activeErasureClient(): unknown {
    if (activeClient === null) {
        throw new Error(
            'dsar-erasure-probe: @/lib/prisma was read outside driveErasure() — ' +
                'no probe client is installed.',
        );
    }
    return activeClient;
}

const STAGE_1_REFUSAL = /execution is not enabled/i;

/**
 * Runs an erasure implementation against the in-memory store and reports what
 * it did. Defaults to the REAL `eraseUser`; the synthetic implementations in
 * the guard pass their own so that the oracle's discrimination is proved
 * through this exact harness.
 */
export async function driveErasure(
    impl: ErasureImpl = eraseUser as unknown as ErasureImpl,
    subjectId: string = SUBJECT_ID,
): Promise<ErasureRun> {
    const store = seedStore();
    const before = copy(store);
    const ops: ProbeOp[] = [];
    const client = makeErasureClient(store, ops);
    activeClient = client;

    let error: Error | null = null;
    try {
        await impl(subjectId, { db: client });
    } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
    } finally {
        activeClient = null;
    }

    const outcome: ErasureOutcome =
        ops.length > 0
            ? 'EXECUTED'
            : error && STAGE_1_REFUSAL.test(error.message)
              ? 'REFUSED'
              : error
                ? 'ERRORED'
                : 'UNOBSERVED';

    return { outcome, subjectId, ops, before, after: copy(store), error };
}

// ─── The oracle ─────────────────────────────────────────────────────────

/**
 * Grades an EXECUTED run against the pseudonymization-not-deletion invariant.
 *
 * Returns `[]` for a run that never executed (`REFUSED`) — that is the absence
 * of a verdict, not a pass, which is why callers must assert the outcome
 * separately. `UNOBSERVED` and `ERRORED` are reported as violations of the
 * probe's own contract so they can never read as compliance.
 */
export function erasureViolations(run: ErasureRun): Violation[] {
    const v: Violation[] = [];
    const add = (code: ViolationCode, detail: string) => v.push({ code, detail });

    if (run.outcome === 'UNOBSERVED') {
        add(
            'UNOBSERVED_EXECUTION',
            'eraseUser returned without refusing and without touching the probe client: ' +
                'it reached a database this probe is not wired to. Wire the seam it uses ' +
                '(see dsar-erasure-probe.ts → "The seam the probe injects through").',
        );
        return v;
    }
    if (run.outcome === 'ERRORED') {
        add(
            'UNOBSERVED_EXECUTION',
            `eraseUser threw ${JSON.stringify(run.error?.message ?? null)} without ` +
                'touching the probe client and without the Stage-1 refusal: nothing ' +
                'was observed, so nothing can be graded.',
        );
        return v;
    }
    if (run.outcome !== 'EXECUTED') return v;

    for (const op of run.ops) {
        if (op.table === '$raw') {
            const sql = JSON.stringify(op.args);
            if (/auditlog/i.test(sql)) {
                add('UNVERIFIABLE_RAW_SQL', `${op.method}: ${sql.slice(0, 200)}`);
            }
            continue;
        }
        if (!WRITE_METHODS.has(op.method)) continue;
        if (!(op.table in ERASURE_DISPOSITIONS)) {
            add(
                'UNDECLARED_TABLE_TOUCHED',
                `${op.table}.${op.method} — declare its disposition in ` +
                    'ERASURE_DISPOSITIONS (with a source) before erasure writes to it.',
            );
            continue;
        }
        if (op.table === 'auditLog' && DELETE_METHODS.has(op.method)) {
            add(
                'AUDIT_DELETE_ISSUED',
                `auditLog.${op.method}(${JSON.stringify(op.args)}) — audit rows are ` +
                    'pseudonymized, never deleted (GDPR Art. 17(3)(b)).',
            );
        }
    }

    const beforeRows = (run.before.auditLog ?? []) as unknown as ProbeAuditRow[];
    const afterById = new Map(
        ((run.after.auditLog ?? []) as unknown as ProbeAuditRow[]).map((r) => [r.id, r]),
    );

    for (const b of beforeRows) {
        const a = afterById.get(b.id);
        if (!a) {
            add('AUDIT_ROW_DELETED', `AuditLog ${b.id} (${b.action}) no longer exists.`);
            continue;
        }
        const foreign = b.userId !== run.subjectId;
        for (const column of Object.keys(b)) {
            if (a[column] === b[column]) continue;
            if (column === 'userId' && !foreign && a.userId === null) continue;
            add(
                foreign ? 'FOREIGN_ROW_TOUCHED' : 'AUDIT_HISTORY_MUTATED',
                `AuditLog ${b.id}.${column}: ${JSON.stringify(b[column])} → ` +
                    `${JSON.stringify(a[column])}`,
            );
        }
        if (!foreign && a.userId === run.subjectId) {
            add(
                'SUBJECT_STILL_LINKED',
                `AuditLog ${b.id} still carries userId ${run.subjectId}; the subject ` +
                    'remains identifiable after erasure.',
            );
        }
    }

    return v;
}

/** Violation codes only — the shape assertions read against. */
export const codesOf = (v: Violation[]): ViolationCode[] => v.map((x) => x.code);
