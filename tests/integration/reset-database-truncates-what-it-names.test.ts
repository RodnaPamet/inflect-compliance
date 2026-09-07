/**
 * `resetDatabase` clears every table it names, and refuses to run when a
 * name has stopped naming anything.
 *
 * ── The defect these tests exist for ─────────────────────────────────
 *
 * The helper used to issue one `TRUNCATE TABLE x CASCADE` per table in a
 * loop, each statement wrapped in a bare `catch {}` commented "Table may
 * not exist in schema — skip silently". Two failures came out of that
 * one shape.
 *
 * The loud one: twenty-nine round trips, each taking and releasing its
 * own ACCESS EXCLUSIVE lock. On an idle box that is only wasteful. Under
 * concurrent load the acquisitions queue behind whatever else is on
 * those tables and the total is bounded by nothing the caller controls —
 * `tests/integration/agent-registry-isolation.test.ts` failed its
 * `beforeAll` with "Exceeded timeout of 30000 ms for a hook" while
 * passing on an idle box (#2350).
 *
 * The quiet one, and the reason there is a test file rather than just a
 * faster statement: the `catch {}` made a renamed table a NO-OP THAT
 * NOTHING REPORTED. Six of the twenty-nine names were in that state —
 * `ControlRiskLink`, `ControlAssetLink`, `TestRunEvidence`, `TestRun`,
 * `TestPlan`, `Membership` — and the suite had been fully green
 * throughout. An absence looked exactly like a success.
 *
 * ── What is asserted, and why each half is needed ────────────────────
 *
 * The refusal is a NEGATIVE assertion: on its own, a resolver that threw
 * for every input would satisfy it and look like it worked. So the
 * refusal case is paired with the positive one — the real list resolves
 * completely — and the clearing case is paired with a pre-reset count,
 * because "the table is empty afterwards" is trivially true of a table
 * that was empty before.
 *
 * Nothing here reads a clock. The round-trip test counts WORK — the
 * house pattern from `tests/unit/framework-tree-builder.test.ts` ("does
 * not read the input quadratically") — because a wall-clock budget is
 * the very thing #2350 is removing, and adding one back to guard the
 * removal would be its own joke.
 */
import { DB_AVAILABLE } from './db-helper';
import {
    prismaTestClient,
    resetDatabase,
    resolveResetTables,
    RESET_TABLES,
} from '../helpers/db';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

// Generous, and deliberately so: a reset takes seconds against a fully
// migrated schema and this box is shared. The number is a jest timeout,
// not an assertion — nothing here passes or fails on how long it took.
jest.setTimeout(180_000);

describeFn('RESET_TABLES names only tables that exist', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = prismaTestClient();

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('resolves every listed name against the live schema', async () => {
        // The positive half. Two jobs: it proves the resolver can pass
        // for a reason (without it the refusal below is unfalsifiable),
        // and it IS the drift detector — rename a table in a migration
        // without editing RESET_TABLES and this fails naming it, which
        // is precisely what the old `catch {}` swallowed.
        const resolved = await resolveResetTables(prisma);
        expect(resolved).toEqual([...RESET_TABLES]);
    });

    it('refuses the whole reset, naming the offender, when a listed table is gone', async () => {
        // `ControlRiskLink` is not an invented name: it is one of the six
        // that really were dead in the old list. Renamed to `RiskControl`
        // at some point nobody can date, because nothing ever said so.
        const withGhost = [...RESET_TABLES, 'ControlRiskLink'];

        await expect(resolveResetTables(prisma, withGhost)).rejects.toThrow(
            /ControlRiskLink/,
        );
        // Names the offender specifically rather than giving up on the
        // list — a message that said "some table is missing" would send
        // the next reader back through twenty-four names by hand.
        await expect(resolveResetTables(prisma, withGhost)).rejects.toThrow(
            `1 of ${withGhost.length}`,
        );
    });
});

describeFn('resetDatabase clears what it names, and their FK children', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = prismaTestClient();
    const slug = `reset-contract-${process.pid}-${Date.now()}`;
    let tenantId = '';

    afterAll(async () => {
        if (tenantId) {
            await prisma.tenant
                .delete({ where: { id: tenantId } })
                .catch(() => undefined);
        }
        await prisma.$disconnect();
    });

    it('empties a named root, and a child reached only by CASCADE', async () => {
        const tenant = await prisma.tenant.create({
            data: { name: 'reset contract', slug },
        });
        tenantId = tenant.id;
        const control = await prisma.control.create({
            data: { tenantId, name: 'control under test' },
        });
        const risk = await prisma.risk.create({
            data: { tenantId, title: 'risk under test' },
        });
        await prisma.riskControl.create({
            data: { tenantId, riskId: risk.id, controlId: control.id },
        });

        // The companion the "empty afterwards" assertions need. Without
        // it they hold just as well over a database nothing ever wrote
        // to, which is the state most of this suite's tables are in.
        expect(await prisma.control.count({ where: { tenantId } })).toBe(1);
        expect(await prisma.risk.count({ where: { tenantId } })).toBe(1);
        expect(await prisma.riskControl.count({ where: { tenantId } })).toBe(1);

        await resetDatabase(prisma);

        expect(await prisma.control.count({ where: { tenantId } })).toBe(0);
        expect(await prisma.risk.count({ where: { tenantId } })).toBe(0);
        // `RiskControl` is NOT in RESET_TABLES. It is cleared because it
        // is a child of two tables that are, which is what makes the list
        // a set of ROOTS rather than an inventory — and what makes the
        // five renamed-away names removed in #2350 free to remove.
        expect(await prisma.riskControl.count({ where: { tenantId } })).toBe(0);
        // And the blast radius stops: `Tenant` is a PARENT of both roots,
        // so it is untouched. Without this the three assertions above
        // would also be satisfied by a statement that wiped the database.
        expect(await prisma.tenant.count({ where: { id: tenantId } })).toBe(1);
    });

    it('issues one TRUNCATE naming every table, not one TRUNCATE per table', async () => {
        // Counts round trips, not milliseconds. The count is a pure
        // function of the implementation — the same integer on every
        // machine, under any load — where the thing it stands in for
        // (how long the hook takes) is neither.
        const sql: string[] = [];
        const counting = new Proxy(prisma, {
            get(target: object, prop: string | symbol, receiver: unknown) {
                if (prop === '$executeRawUnsafe' || prop === '$queryRawUnsafe') {
                    return (statement: string, ...rest: unknown[]) => {
                        sql.push(String(statement));
                        return Reflect.get(target, prop, receiver).call(
                            target,
                            statement,
                            ...rest,
                        );
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });

        await resetDatabase(counting);

        const truncates = sql.filter((s) => /^\s*TRUNCATE\b/i.test(s));
        expect(truncates).toHaveLength(1);
        for (const table of RESET_TABLES) {
            expect(truncates[0]).toContain(`"${table}"`);
        }
        // Constant, and in particular not proportional to the list: the
        // resolve is one query and the truncate is one statement. The
        // shape this replaced issued RESET_TABLES.length of them.
        expect(sql.length).toBeLessThanOrEqual(2);
    });
});
