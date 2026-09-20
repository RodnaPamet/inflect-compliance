/**
 * `AgentProposal.(runId, stepSeq)` — the link from a queued write back to the
 * step that reasoned its way to it, and the two database constraints that make
 * the unusable states of that link unrepresentable.
 *
 * ── WHY THIS IS A DATABASE TEST AND NOT A USECASE TEST ──────────────────────
 *
 * Both claims here are about what Postgres REFUSES, and neither is reachable
 * through the Prisma client: `prisma.agentProposal.create` cannot express a
 * `stepSeq` with no `runId` in a way that exercises the CHECK (the client is
 * happy to send it — the server is what says no), and the cross-tenant FK is
 * only violable through raw SQL because every usecase threads one tenantId into
 * both halves. A test that went through the usecase would be asserting that the
 * usecase does not do a thing it has no code path for, and would stay green if
 * the constraints were dropped tomorrow.
 *
 * ── THE POSITIVE CONTROLS ARE NOT DECORATION ────────────────────────────────
 *
 * Each refusal below is paired with an insert that must SUCCEED. Without them a
 * broken fixture — a missing tenant row, a typo'd column, a table that does not
 * exist — produces exactly the same "the insert was rejected" that a working
 * constraint does, and the suite reports the constraint as proven. The controls
 * are what make a rejection mean "examined and refused" rather than "nothing
 * worked". This is the repo's standing rule that a green certifies nothing when
 * the mechanism never ran.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const T1 = 'prov-tenant-one';
const T2 = 'prov-tenant-two';
const RUN = 'prov-run-one';

/**
 * Pull the SQLSTATE and the offending constraint out of a Prisma raw-query
 * failure.
 *
 * Prisma wraps every raw failure as `P2010`, so its own `code` says only "a raw
 * query failed" and cannot distinguish a check violation from a missing table.
 * The driver's own error is nested at `meta.driverAdapterError.cause`, and THAT
 * carries the real `23514` / `23503`.
 *
 * READ `originalCode`, NOT `code`. The cause's shape varies by violation kind,
 * which cost a round trip here: a check violation arrives with `kind:
 * "postgres"` and BOTH `code` and `originalCode` set, while a foreign-key
 * violation arrives with `kind: "ForeignKeyConstraintViolation"`, a
 * `constraint: { index }` object — and NO `code` at all. Reading `code` gives
 * the right answer for one of the two and `undefined` for the other, which is
 * the worse failure: half the assertions keep passing.
 *
 * The constraint NAME is only in the message text, which is why the test below
 * does not rest on it alone: `pg_constraint` is queried separately for the
 * identity and the expression. Parsing the name here narrows which constraint a
 * given refusal came from; the catalog test is what proves the constraint is
 * the one we wrote.
 */
function pgFailure(err: unknown): { ok: false; code: string; constraint: string } {
    const cause = (
        err as {
            meta?: {
                driverAdapterError?: {
                    cause?: { code?: string; originalCode?: string; originalMessage?: string };
                };
            };
        }
    )?.meta?.driverAdapterError?.cause;
    const named = /constraint "([^"]+)"/.exec(String(cause?.originalMessage ?? ''));
    return {
        ok: false,
        code: String(cause?.originalCode ?? cause?.code ?? 'unknown'),
        constraint: named ? named[1] : 'unknown',
    };
}

/** Insert a proposal with raw SQL, returning the SQLSTATE on refusal. */
async function tryInsert(fields: {
    id: string;
    tenantId: string;
    runId?: string | null;
    stepSeq?: number | null;
}): Promise<{ ok: true } | { ok: false; code: string; constraint: string }> {
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "AgentProposal"
                 (id, "tenantId", kind, "payloadJson", "updatedAt", "runId", "stepSeq")
             VALUES ($1, $2, 'RISK', '{}', NOW(), $3, $4)`,
            fields.id,
            fields.tenantId,
            fields.runId ?? null,
            fields.stepSeq ?? null,
        );
        return { ok: true };
    } catch (err) {
        return pgFailure(err);
    }
}

describeFn('a proposal carries the run and step that produced it', () => {
    beforeAll(async () => {
        await prisma.agentProposal.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
        await prisma.workflowRun.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
        await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
        await prisma.tenant.create({ data: { id: T1, name: 'Provenance One', slug: T1 } });
        await prisma.tenant.create({ data: { id: T2, name: 'Provenance Two', slug: T2 } });
        await prisma.workflowRun.create({
            data: { id: RUN, tenantId: T1, workflowKey: 'audit-prep' },
        });
    });

    afterAll(async () => {
        // Truthiness-guarded: an `undefined` filter value is DROPPED by Prisma,
        // so an unguarded deleteMany here would be an unpredicated DELETE over
        // a database other suites in this worker are using. See the teardown
        // note in `db-helper.ts`.
        if (T1 && T2) {
            await prisma.agentProposal.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
            await prisma.workflowRun.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
            await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
        }
        await prisma.$disconnect();
    });

    // ── The two states that must be storable ────────────────────────────────

    it('accepts a proposal made OUTSIDE a run — neither field set', async () => {
        // NULL here is a real answer, not a legacy gap: the propose tools are
        // callable by an agent that is not executing a workflow, and such a
        // proposal genuinely has no step. If this ever starts failing, the
        // constraint has been tightened into something that forbids a state the
        // product actually produces.
        expect(await tryInsert({ id: 'prov-p1', tenantId: T1 })).toEqual({ ok: true });
    });

    it('accepts a proposal addressing a step of its own run', async () => {
        expect(
            await tryInsert({ id: 'prov-p2', tenantId: T1, runId: RUN, stepSeq: 3 }),
        ).toEqual({ ok: true });
    });

    // ── The three that must not be ──────────────────────────────────────────

    it('refuses a step ordinal that names no run', async () => {
        // A `stepSeq` without a `runId` addresses nothing — there is no row it
        // could resolve to, so a reviewer following it back reaches a dead end.
        const result = await tryInsert({ id: 'prov-p3', tenantId: T1, stepSeq: 7 });
        expect(result).toEqual({
            ok: false,
            code: '23514', // check_violation
            constraint: 'AgentProposal_step_requires_run',
        });
    });

    it('refuses a proposal pointing at ANOTHER tenant\'s run', async () => {
        // The composite FK references (id, tenantId) rather than id alone, which
        // is what makes a cross-tenant reference unrepresentable rather than
        // merely filtered out by a query nobody checked.
        const result = await tryInsert({
            id: 'prov-p4',
            tenantId: T2,
            runId: RUN, // belongs to T1
            stepSeq: 1,
        });
        expect(result).toEqual({
            ok: false,
            code: '23503', // foreign_key_violation
            constraint: 'AgentProposal_runId_tenantId_fkey',
        });
    });

    it('refuses deleting a run that still has proposals hanging off it', async () => {
        // `onDelete: Restrict`. A run is the evidence for the proposals it
        // produced, so deleting one has to be refused rather than silently
        // nulling the link that made them reviewable.
        await expect(prisma.workflowRun.delete({ where: { id: RUN } })).rejects.toThrow();

        // The control for the control: the run is still there, so the rejection
        // above was the constraint and not a missing row.
        expect(await prisma.workflowRun.count({ where: { id: RUN } })).toBe(1);
    });

    it('has the CHECK in the catalog, with the expression it claims', async () => {
        // The identity half. The refusal tests above parse a constraint name out
        // of a driver message; this reads `pg_constraint` instead, so a rename
        // or a weakened expression fails here rather than quietly changing what
        // those tests are observing.
        const rows = await prisma.$queryRaw<Array<{ def: string }>>`
            SELECT pg_get_constraintdef(c.oid) AS def
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = 'AgentProposal'
              AND c.conname = 'AgentProposal_step_requires_run'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].def).toBe(
            'CHECK ((("stepSeq" IS NULL) OR ("runId" IS NOT NULL)))',
        );
    });

    it('stored exactly the two rows the accepts created, and nothing the refusals tried', async () => {
        // The denominator. Five inserts were attempted against T1/T2; if the
        // fixture were broken every one of them would have failed and the three
        // refusal assertions above would still have passed.
        const rows = await prisma.agentProposal.findMany({
            where: { tenantId: { in: [T1, T2] } },
            select: { id: true, runId: true, stepSeq: true },
            orderBy: { id: 'asc' },
        });
        expect(rows).toEqual([
            { id: 'prov-p1', runId: null, stepSeq: null },
            { id: 'prov-p2', runId: RUN, stepSeq: 3 },
        ]);
    });
});

describeFn('the driver step kinds exist in the physical enum type', () => {
    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('carries the four original kinds plus MODEL_CALL and TOOL_CALL', async () => {
        // Set equality over the PHYSICAL type, not the generated client. The
        // client is regenerated from the schema, so asserting against it would
        // compare the schema to itself and pass on a database that never got
        // the migration — which is precisely the failure this catches: a write
        // of 'MODEL_CALL' against an un-migrated database fails at runtime with
        // 22P02, not at deploy.
        const rows = await prisma.$queryRaw<Array<{ label: string }>>`
            SELECT e.enumlabel AS label
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'WorkflowStepKind'
            ORDER BY e.enumlabel
        `;
        expect(rows.map((r) => r.label)).toEqual([
            'HUMAN_CHECKPOINT',
            'MODEL_CALL',
            'PROPOSE',
            'READ',
            'SYNTHESIS',
            'TOOL_CALL',
        ]);
    });
});
