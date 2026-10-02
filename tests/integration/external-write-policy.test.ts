/**
 * THE EXTERNAL-WRITE LADDER, AGAINST A REAL ROW.
 *
 * `external-write-ladder.ts` is pure and has its own unit tests. What those
 * cannot show is the part that broke twice in the identity equivalent: whether
 * the STORED value is coerced at the read boundary, whether a move actually
 * lands in the column, and whether the clamp is consulted before the dwell.
 *
 * Driven against Postgres because every one of those claims is about the row.
 *
 * ## What is deliberately NOT asserted here
 *
 * That any of this changes what an agent does on its own. Raising the ceiling to
 * `PROPOSE_ONLY` moves no connection — every one stays at the rung an operator
 * set, defaulting to `DISABLED`. These tests are
 * about the control, and the control exists before the authority on purpose —
 * #2241's lesson is what a rung costs when it arrives after.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    getExternalWritePolicy,
    setExternalWriteMode,
} from '@/app-layer/usecases/external-write-policy';
import { sqlCodeOf } from '../helpers/source-blocks';
import { EXTERNAL_MAX_MODE, MODE_MIN_DAYS } from '@/lib/integrations/external-write-ladder';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { recordIntent } from '@/app-layer/usecases/external-write-journal';
import { openApprovedExternalWrite } from '@/app-layer/usecases/external-write-approval';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'extwrite-tenant-one';
const T2 = 'extwrite-tenant-two';

let ctx1: ReturnType<typeof makeRequestContext>;
let conn1 = '';
let conn2 = '';

async function makeConnection(tenantId: string, name: string): Promise<string> {
    const row = await prisma.integrationConnection.create({
        data: {
            tenantId,
            provider: MCP_SERVER_PROVIDER_ID,
            name,
            configJson: { url: 'https://mcp.example.test/endpoint' },
        },
        select: { id: true },
    });
    return row.id;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    const owners: Record<string, string> = {};
    for (const id of [T1, T2]) {
        // Same leak the journal test carried: `resetDatabase` does not truncate
        // `User` or `Tenant`, so both fixtures survive the run and the next
        // `create` dies on a unique constraint in `beforeAll` — which fails every
        // test in the file on something none of them are about.
        const fixtureEmail = `owner@${id}.test`;
        await prisma.user.deleteMany({ where: { emailHash: hashForLookup(fixtureEmail) } });
        await prisma.tenant.deleteMany({ where: { id } });

        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        const email = fixtureEmail;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        owners[id] = user.id;
    }
    // The SEEDED user's id, not the helper's default. `logEvent` writes an
    // AuditLog row with `userId` under a foreign key, so a context naming a user
    // that does not exist fails the whole usecase on 23503 — and it fails inside
    // the audit write, several frames from the mode change that looks like the
    // subject of the test.
    ctx1 = makeRequestContext('OWNER', { tenantId: T1, userId: owners[T1] });
});

afterAll(async () => {
    await prisma.$disconnect();
});

beforeEach(async () => {
    // Journal rows FIRST. Deleting a connection nulls `connectionId` on the rows
    // that referenced it (the composite FK is `SET NULL ("connectionId")`), so
    // they survive their connection rather than cascading — which is right for a
    // record of what was attempted, and means they would otherwise accumulate
    // across every test in this file.
    await prisma.externalWriteJournal.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    conn1 = await makeConnection(T1, 'mcp one');
    conn2 = await makeConnection(T2, 'mcp two');
});

describe('a connection that was never set', () => {
    it('reads as DISABLED, because NULL coerces rather than defaulting to something wider', async () => {
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.mode).toBe('DISABLED');
        expect(policy.modeSince).toBeNull();
    });

    it('publishes the ceiling this build honours, so a surface need not infer it', async () => {
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.maxMode).toBe(EXTERNAL_MAX_MODE);
    });

    it('is NOT reachable across tenants — a foreign id is not found, not forbidden', async () => {
        // Positive control first: the row genuinely exists, so the rejection
        // below is about the tenant and not about a missing row.
        expect(await prisma.integrationConnection.findUnique({ where: { id: conn2 } })).not.toBeNull();
        await expect(getExternalWritePolicy(ctx1, conn2)).rejects.toThrow(/No such MCP server connection/);
    });
});

/**
 * Open a rung's observation window and backdate it past the dwell.
 *
 * Needed because of the behaviour pinned in the describe below: the ladder
 * refuses to widen off a rung with no recorded start, and a connection that was
 * never set has none. Every widen therefore costs a no-op selection first.
 */
async function armAndBackdate(connectionId: string, rung: 'DISABLED' | 'DRY_RUN'): Promise<void> {
    await setExternalWriteMode(ctx1, connectionId, rung, EXTERNAL_MAX_MODE);
    await prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { externalWriteModeSince: new Date(Date.now() - (MODE_MIN_DAYS + 1) * 86_400_000) },
    });
}

describe('a connection that was never set CAN be widened immediately', () => {
    /**
     * FLIPPED by owner decision on 2026-09-27, and the reasoning is worth keeping
     * beside the assertion because the previous behaviour was pinned here too.
     *
     * `refusalForMove` used to refuse any widen while `modeSince` was null, and a
     * connection that had never been set has none — so the FIRST move on every
     * connection was refused, pointing the operator at a no-op re-selection of
     * `DISABLED` followed by seven days.
     *
     * The dwell exists so that what a rung RECORDS can be read before a wider one
     * acts on it. `DISABLED` records nothing by construction — `MODE_MIN_EVIDENCE`
     * already exempted it for exactly that reason — so the week bought no
     * observation, and the rung above it sends nothing either.
     *
     * It is also what makes the connection gate deployable: with the rung
     * governing whether an agent may call a connection at all, seven days at
     * `DISABLED` is seven days of outage for anything that needs widening.
     */
    it('goes straight to DRY_RUN, with no no-op selection and no wait', async () => {
        const after = await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        expect(after.mode).toBe('DRY_RUN');
        expect(after.modeSince).toBeInstanceOf(Date);
    });

    it('but the rung ABOVE DRY_RUN still costs the full window', async () => {
        // The protection that matters is untouched, and this is the assertion
        // that says so. Exempting DISABLED must not exempt anything else.
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await expect(
            setExternalWriteMode(ctx1, conn1, 'PROPOSE_ONLY', 'AUTOMATIC'),
        ).rejects.toThrow(/recorded 0 of the 1 required|held for 0 of the 7/);
    });

    it('re-selecting DISABLED is still permitted, and still stamps the window', async () => {
        // No longer REQUIRED, but it must not have become an error either.
        const opened = await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);
        expect(opened.mode).toBe('DISABLED');
        expect(opened.modeSince).toBeInstanceOf(Date);
    });
});

describe('moving up the ladder', () => {
    it('DISABLED → DRY_RUN is permitted, and lands in the column', async () => {
        const after = await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        expect(after.mode).toBe('DRY_RUN');
        expect(after.modeSince).toBeInstanceOf(Date);

        // The ROW, not the return value — the claim is that it persisted.
        const row = await prisma.integrationConnection.findUnique({
            where: { id: conn1 },
            select: { externalWriteMode: true, externalWriteModeSince: true },
        });
        expect(row?.externalWriteMode).toBe('DRY_RUN');
        expect(row?.externalWriteModeSince).toBeInstanceOf(Date);
    });

    it('refuses a two-rung jump, naming the path', async () => {
        // Now a LADDER refusal rather than a ceiling one: with the clamp at
        // PROPOSE_ONLY this rung is permitted in principle, so what refuses is
        // the one-rung rule. The old regex also admitted 'above the ceiling',
        // and that alternative is what it actually matched — so the assertion
        // was passing on the clamp while claiming to be about the path.
        await expect(
            setExternalWriteMode(ctx1, conn1, 'PROPOSE_ONLY', EXTERNAL_MAX_MODE),
        ).rejects.toThrow(/Widen one level at a time/);
    });

    it('refuses AUTOMATIC on the CEILING, which proves the clamp is read first', async () => {
        // The ordering assertion, and it is sharper than it was.
        //
        // `DISABLED → AUTOMATIC` is a THREE-rung jump, so the ladder would
        // refuse it too — with a different message. Getting the ceiling message
        // back is therefore proof that `isAboveClamp` is consulted BEFORE
        // `refusalForMove`, which is the ordering that stops an operator being
        // told to wait seven days for a rung that would be refused afterwards
        // anyway.
        await expect(
            setExternalWriteMode(ctx1, conn1, 'AUTOMATIC', EXTERNAL_MAX_MODE),
        ).rejects.toThrow(/above the ceiling this build honours/);
    });

    it('still refuses a rung above a LOWER clamp, whatever the ladder says', async () => {
        // The clamp in isolation: passing a narrower ceiling than the build's
        // own must refuse a rung the ladder would otherwise allow. `clamp` is a
        // required parameter precisely so a caller cannot forget it, and this
        // is the assertion that it is honoured rather than ignored.
        await expect(
            setExternalWriteMode(ctx1, conn1, 'DRY_RUN', 'DISABLED'),
        ).rejects.toThrow(/above the ceiling this build honours/);
    });

    it('cannot climb off DRY_RUN even after the dwell, because nothing records intents', async () => {
        // Backdate past the seven days, so the ONLY thing left to refuse on is
        // evidence. This is the state #2933's note predicted: "a connection can
        // be armed to DRY_RUN and cannot climb further. That is the ladder
        // working, not a gap."
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const longAgo = new Date(Date.now() - (MODE_MIN_DAYS + 30) * 86_400_000);
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteModeSince: longAgo },
        });

        const policy = await getExternalWritePolicy(ctx1, conn1);
        // The evidence really was counted — `undefined` would refuse too, but
        // for the different reason "we could not look", which would be a lie.
        expect(policy.evidenceInWindow).toBe(0);

        // Raise the clamp for this call only, so what refuses is the EVIDENCE and
        // not the ceiling — otherwise this test passes without exercising the
        // dwell at all.
        await expect(
            setExternalWriteMode(ctx1, conn1, 'PROPOSE_ONLY', 'AUTOMATIC'),
        ).rejects.toThrow(/recorded 0 of the 1 required/);
    });
});

describe('moving down the ladder', () => {
    it('is never gated — an operator revoking an authority is not told to wait', async () => {
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        // Immediately, with no dwell served and no evidence recorded.
        const after = await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);
        expect(after.mode).toBe('DISABLED');
    });

    it('RESTARTS the window, so a rung cannot be re-entered to inherit old days', async () => {
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const longAgo = new Date(Date.now() - (MODE_MIN_DAYS + 30) * 86_400_000);
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteModeSince: longAgo },
        });

        const narrowed = await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);

        // The clock is new, not the one that had already run thirty-seven days.
        expect(narrowed.modeSince!.getTime()).toBeGreaterThan(longAgo.getTime());
        expect(Date.now() - narrowed.modeSince!.getTime()).toBeLessThan(60_000);

        // Re-widening to DRY_RUN is now PERMITTED — DISABLED imposes no wait
        // since the 2026-09-27 exemption, and DRY_RUN sends nothing, so nothing
        // is granted that was not already there.
        const back = await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        expect(back.mode).toBe('DRY_RUN');

        // The property that MATTERS survives, and this is where it bites: the
        // re-entered DRY_RUN carries a fresh window, so the rung above it is
        // refused on a dwell that starts from zero rather than inheriting the
        // thirty-seven days the first stay had accrued. Clamp raised for this call
        // only, so what refuses is the WINDOW and not the build's ceiling.
        expect(Date.now() - back.modeSince!.getTime()).toBeLessThan(60_000);
        await expect(
            setExternalWriteMode(ctx1, conn1, 'PROPOSE_ONLY', 'AUTOMATIC'),
        ).rejects.toThrow(/recorded 0 of the 1 required|held for 0 of the 7/);
    });
});

describe('a stored rung this build does not recognise', () => {
    it('reads as DISABLED — fails CLOSED, never as the widest authority', async () => {
        // Written raw, because the usecase would refuse to store it. This is the
        // rolling-deploy case the TEXT column exists for: an old container
        // meeting a rung introduced after it shipped.
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteMode: 'SOME_FUTURE_RUNG', externalWriteModeSince: new Date() },
        });
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.mode).toBe('DISABLED');
    });

    it('and the failure direction is the point — it is not treated as above the clamp', async () => {
        // `isAboveClamp` sorts an unrecognised mode to -1, which reads as NOT
        // above the clamp, i.e. PERMITTED. Coercing at the read boundary is what
        // stops that from being reachable.
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteMode: 'AUTOMATIC_BUT_MISSPELLED', externalWriteModeSince: new Date() },
        });
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.mode).not.toBe('AUTOMATIC');
        expect(policy.mode).toBe('DISABLED');
    });
});

describe('the change is audited', () => {
    it('writes an access-category row naming both rungs', async () => {
        // NOT deleted first: `AuditLog` is hash-chained and its rows carry
        // foreign keys, so a tidy-up deleteMany fails on 23503 — the immutability
        // is the feature. Scope the read to THIS connection instead, and take the
        // row the widen wrote.
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'EXTERNAL_WRITE_MODE_CHANGED', entityId: conn1 },
            orderBy: { createdAt: 'asc' },
            select: { entityId: true, detailsJson: true },
        });
        // One: the widen. There is no longer a no-op DISABLED selection in front
        // of it — that was the observation window the exemption removed.
        expect(rows).toHaveLength(1);
        expect(rows[0].entityId).toBe(conn1);
        // `access`, not `configuration`: widening this grants authority to change
        // something in a system that is not ours, and an access-review reader is
        // the audience for that.
        expect((rows[0].detailsJson as Record<string, unknown>).category).toBe('access');
        expect((rows[0].detailsJson as Record<string, unknown>).operation).toBe('grant');
    });

    it('records a narrowing as a REVOKE, not a grant', async () => {
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'EXTERNAL_WRITE_MODE_CHANGED', entityId: conn1 },
            orderBy: { createdAt: 'asc' },
            select: { detailsJson: true },
        });
        // widen, then narrow.
        expect(rows).toHaveLength(2);
        expect((rows[1].detailsJson as Record<string, unknown>).operation).toBe('revoke');
        // …and the widen before it was a grant, so the two are distinguishable
        // rather than both defaulting to one value.
        expect((rows[0].detailsJson as Record<string, unknown>).operation).toBe('grant');
    });
});

/**
 * THE BACKFILL'S PREDICATE, PINNED.
 *
 * A one-shot data migration cannot be verified by a test that runs after it: the
 * rows it touched are indistinguishable from rows that were always that way. What
 * CAN be pinned is the predicate, and two parts of it are load-bearing in a way
 * that is invisible once the migration has run.
 *
 * Measured against production before shipping: the predicate matches exactly ONE
 * row, `Entra MCP` — the connection that produced the 2026-09-26 proving run and
 * the one that would otherwise go dark when the rung starts gating reads. The
 * `active-directory` and `entra-id` connections are outside it.
 */
describe('the backfill migration', () => {
    // MASKED at the read seam with `sqlCodeOf`, not read raw — and for this file
    // it is not a formality. The migration is four-fifths comment: it argues at
    // length about DRY_RUN, about NULL coercing to DISABLED, and about which
    // providers are in scope. Every needle below would have been satisfiable by
    // that prose, so deleting the UPDATE and leaving the header would have kept
    // these assertions green. That is the Class A defect exactly
    // (`raw-source-assertion-ratchet`), and masking converts the whole file at
    // once rather than per-assertion.
    const SQL = sqlCodeOf(
        fs.readFileSync(
            path.resolve(
                __dirname,
                '../../prisma/migrations/20260927170000_backfill_external_write_mode_for_existing_connections/migration.sql',
            ),
            'utf8',
        ),
    );

    it('is scoped to mcp-server connections, so no other provider is touched', () => {
        // Positive control: the file really is the migration, not an empty read.
        expect(SQL).toMatch(/UPDATE "IntegrationConnection"/);
        expect(SQL).toMatch(/"provider" = 'mcp-server'/);
    });

    it('carries the IS NULL guard, which is what makes re-running it safe', () => {
        // Without it the UPDATE re-stamps `externalWriteModeSince` on every
        // mcp-server connection, resetting every observation window that had
        // started — so a tenant mid-dwell silently goes back to day zero. Prisma
        // will not re-run an applied migration, but a copy-paste into a later one
        // or a manual replay would, and the guard is the only thing standing
        // between that and a reset.
        expect(SQL).toMatch(/"externalWriteMode" IS NULL/);
    });

    it('sets DRY_RUN and nothing wider', () => {
        // The smallest rung that avoids the outage. DRY_RUN permits reads and
        // sends no write, which is an accurate description of every connection
        // this touches: the only writable far end is a lab fixture nobody has
        // stood up, and the live Entra server's three tools all declare
        // readOnlyHint: true.
        expect(SQL).toMatch(/SET "externalWriteMode" = 'DRY_RUN'/);
        expect(SQL).not.toMatch(/'AUTOMATIC'|'PROPOSE_ONLY'/);
    });

    it('stamps a window, because DRY_RUN cannot be widened off without one', () => {
        // DISABLED is exempt from the window as of 2026-09-27; DRY_RUN is not.
        expect(SQL).toMatch(/"externalWriteModeSince" = NOW\(\)/);
    });
});

/**
 * THE EVIDENCE THE DWELL COUNTS — the seam that did not connect.
 *
 * Until this was fixed, `countRecordedIntents` counted `IntegrationExecution`
 * rows whose `automationKey` ended in `:external-write`, and nothing has ever
 * written one: the dispatch (#2983) records intents as `ExternalWriteJournal`
 * rows. The count was therefore 0 for every connection forever, and the ladder
 * refused `DRY_RUN → PROPOSE_ONLY` saying the rung had recorded nothing while
 * the journal filled up beside it.
 *
 * The suite already had a test for the zero case, and it could not have caught
 * this: with no journal rows AND no execution rows, the broken and the fixed
 * implementation both return 0. Every assertion below is written so that it
 * FAILS against the old query — the count is taken after a real `recordIntent`,
 * through the same seam the dispatch uses.
 */
describe('what the dwell counts as evidence', () => {
    let conn = '';

    /** One dry-run intent, written the way the dispatch writes it. */
    const intent = (connectionId: string) =>
        recordIntent(ctx1, {
            connectionId,
            connectionName: 'evidence-conn',
            endpointUrl: 'https://mcp.example.test/endpoint',
            toolName: `mcp__${connectionId}__set_employee_work_email`,
            advertisedToolName: 'set_employee_work_email',
            mode: 'DRY_RUN',
            argumentsJson: JSON.stringify({ empNumber: 7 }),
            priorStateJson: JSON.stringify({ workEmail: 'before@example.test' }),
        });

    /** Open the window and backdate it past the dwell, leaving only evidence. */
    async function armPastDwell(connectionId: string) {
        await setExternalWriteMode(ctx1, connectionId, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await prisma.integrationConnection.update({
            where: { id: connectionId },
            data: {
                externalWriteModeSince: new Date(Date.now() - (MODE_MIN_DAYS + 30) * 86_400_000),
            },
        });
    }

    beforeEach(async () => {
        // A connection per test. These tests move a connection UP the ladder, so
        // sharing one would let an earlier climb decide a later assertion.
        conn = await makeConnection(T1, `evidence-${Date.now()}-${Math.random()}`);
    });

    it('counts a recorded intent that the journal actually holds', async () => {
        // THE MUTATION PROOF. Against the old query this is 0, because the row
        // `recordIntent` writes is an ExternalWriteJournal row and the old
        // counter read IntegrationExecution.
        await armPastDwell(conn);
        await intent(conn);

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(1);
    });

    it('lets a connection CLIMB once the rung has produced something', async () => {
        // The behaviour the count exists for, and the half a count assertion
        // alone would not show: with one real intent and the dwell served, the
        // widen is granted rather than refused.
        await armPastDwell(conn);
        await intent(conn);

        // Clamp raised for this call only, so what is exercised is the dwell and
        // not the ceiling — the same device the zero-case test above uses.
        const after = await setExternalWriteMode(ctx1, conn, 'PROPOSE_ONLY', 'AUTOMATIC');
        expect(after.mode).toBe('PROPOSE_ONLY');
    });

    it('ignores intents recorded BEFORE the window opened', async () => {
        // The window is the point of the dwell: evidence from a previous stint at
        // this rung is not evidence about this one.
        await setExternalWriteMode(ctx1, conn, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await intent(conn);
        await prisma.externalWriteJournal.updateMany({
            where: { tenantId: T1, connectionId: conn },
            data: { attemptedAt: new Date(Date.now() - 400 * 86_400_000) },
        });
        // Window opens AFTER that row was attempted.
        await prisma.integrationConnection.update({
            where: { id: conn },
            data: { externalWriteModeSince: new Date(Date.now() - 60 * 86_400_000) },
        });

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(0);
    });

    it("does not count another connection's intents", async () => {
        // Scoping, asserted rather than assumed: the count is per connection, and
        // a query that dropped the connectionId filter would pass every other
        // assertion in this block.
        const other = await makeConnection(T1, `evidence-other-${Date.now()}`);
        await armPastDwell(conn);
        await intent(other);

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(0);
    });

    it('reports AUTOMATIC as UNCOUNTABLE rather than zero', async () => {
        // The surviving `undefined` case, and the reason the two answers are not
        // collapsed. `AUTOMATIC` is the top rung: nothing is widened off it, so
        // `MODE_MIN_EVIDENCE` names no requirement and no query is written for
        // it. "We could not look" and "we looked and found none" are different
        // answers, and a 0 here would claim the second.
        //
        // Stored directly: the real clamp refuses this rung, which is the
        // behaviour a different test covers.
        await prisma.integrationConnection.update({
            where: { id: conn },
            data: {
                externalWriteMode: 'AUTOMATIC',
                externalWriteModeSince: new Date(Date.now() - (MODE_MIN_DAYS + 30) * 86_400_000),
            },
        });

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBeUndefined();
    });
});

/**
 * WHAT PROPOSE_ONLY COUNTS — step 4 of #2861.
 *
 * That rung returned `undefined` on a premise step 6 falsified: "no external
 * write can be proposed yet". `EXTERNAL_MAX_MODE` is now `PROPOSE_ONLY`, so
 * proposals and approvals both exist and the rung can be counted.
 *
 * ## The join these tests are really about
 *
 * `AgentProposal` carries no `connectionId` — it lives inside the encrypted
 * `payloadJson`, which cannot be filtered in SQL. So an approved proposal is
 * counted through the `ExternalWriteJournal` row the APPROVAL opens:
 * `approveAgentProposal` calls `openApprovedExternalWrite` once the full
 * approval requirement is met, and that is the only thing in the build that
 * writes a journal row at `mode = 'PROPOSE_ONLY'`.
 *
 * Every row below is therefore created through `openApprovedExternalWrite`
 * itself rather than through `beginWrite` — the seam under test is the join, and
 * a row inserted past the seam would not exercise it.
 *
 * ## UNRUN
 *
 * These are DB-backed and the shared test database could not be written to in
 * the environment this was authored in. They have never been executed.
 */
describe('what PROPOSE_ONLY counts as evidence', () => {
    let conn = '';
    let proposalSeq = 0;

    const payloadFor = (connectionId: string) => ({
        connectionId,
        connectionName: 'approved-conn',
        endpointUrl: 'https://mcp.example.test/endpoint',
        toolName: `mcp__${connectionId}__set_employee_work_email`,
        advertisedToolName: 'set_employee_work_email',
        arguments: { empNumber: 7, workEmail: 'after@example.test' },
        priorState: { workEmail: 'before@example.test' },
    });

    /**
     * One approved external write, opened exactly as an approval opens it.
     *
     * `openApprovedExternalWrite` re-reads the connection's rung and refuses
     * anything below `PROPOSE_ONLY`, so the connection must be armed first —
     * which is itself part of the claim: a journal row at this rung cannot exist
     * unless the connection permitted the write when a human committed to it.
     */
    const approvedWrite = (connectionId: string) =>
        openApprovedExternalWrite(ctx1, {
            id: `prp_${(proposalSeq += 1)}`,
            payloadJson: JSON.stringify(payloadFor(connectionId)),
            agentId: null,
            runId: null,
        });

    /** Hold the rung with a window already past the dwell. */
    async function armAtProposeOnly(connectionId: string) {
        // Stored directly rather than through `setExternalWriteMode`: reaching
        // PROPOSE_ONLY legitimately costs a DRY_RUN stint plus recorded intents,
        // and that path is covered by the DRY_RUN block above.
        await prisma.integrationConnection.update({
            where: { id: connectionId },
            data: {
                externalWriteMode: 'PROPOSE_ONLY',
                externalWriteModeSince: new Date(Date.now() - (MODE_MIN_DAYS + 30) * 86_400_000),
            },
        });
    }

    beforeEach(async () => {
        conn = await makeConnection(T1, `approved-${Date.now()}-${Math.random()}`);
    });

    it('counts an approved proposal, through the row the approval opens', async () => {
        // THE MUTATION PROOF for this change: against the old code this is
        // `undefined`, because the PROPOSE_ONLY branch returned `undefined`
        // unconditionally.
        await armAtProposeOnly(conn);
        await approvedWrite(conn);

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(1);
    });

    it('reports ZERO — not "could not count" — when the rung has approved nothing', async () => {
        // The half that makes the number mean something. An empty population is
        // now a LOOK that found nothing, and the refusal says so; the old code
        // could not distinguish this connection from one it had never queried.
        await armAtProposeOnly(conn);

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(0);
        expect(policy.refusals.AUTOMATIC).toMatch(/above the ceiling/);
    });

    it('refuses PROPOSE_ONLY → AUTOMATIC naming the count, not the probe', async () => {
        // The sentence an operator reads. With the clamp raised for this call
        // only — the same device the DRY_RUN block uses — the refusal must be the
        // evidence one, never the "we could not look" one.
        await armAtProposeOnly(conn);

        await expect(
            setExternalWriteMode(ctx1, conn, 'AUTOMATIC', 'AUTOMATIC'),
        ).rejects.toThrow(/has recorded 0 of the 1 required approved proposals/);
    });

    it('lets a connection climb to AUTOMATIC once a proposal has been approved', async () => {
        // The behaviour the count exists for, and the half a count assertion
        // alone would not show. Clamp raised for this call only.
        await armAtProposeOnly(conn);
        await approvedWrite(conn);

        const after = await setExternalWriteMode(ctx1, conn, 'AUTOMATIC', 'AUTOMATIC');
        expect(after.mode).toBe('AUTOMATIC');
    });

    it('does NOT count a DRY_RUN intent recorded against the same connection', async () => {
        // The cross-rung pin. A dry-run intent is evidence for leaving DRY_RUN
        // and says nothing about whether a human ever reviewed a write, so a
        // query that filtered on `connectionId` and the window alone would count
        // it and grant unattended writes off the wrong proof.
        await armAtProposeOnly(conn);
        await recordIntent(ctx1, {
            connectionId: conn,
            connectionName: 'approved-conn',
            endpointUrl: 'https://mcp.example.test/endpoint',
            toolName: `mcp__${conn}__set_employee_work_email`,
            advertisedToolName: 'set_employee_work_email',
            mode: 'DRY_RUN',
            argumentsJson: JSON.stringify({ empNumber: 7 }),
            priorStateJson: JSON.stringify({ workEmail: 'before@example.test' }),
        });

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(0);
    });

    it('does NOT count a RECORDED_ONLY row that claims the PROPOSE_ONLY rung', async () => {
        // The `DISPATCHED_OUTCOMES` pin. `recordIntent` refuses every mode but
        // DRY_RUN, so this row is unreachable through either write seam and has
        // to be inserted directly — which is the point: the filter pins the claim
        // rather than trusting `recordIntent` to remain the only writer of a
        // terminal RECORDED_ONLY row.
        await armAtProposeOnly(conn);
        await prisma.externalWriteJournal.create({
            data: {
                tenantId: T1,
                connectionId: conn,
                connectionName: 'approved-conn',
                endpointUrl: 'https://mcp.example.test/endpoint',
                toolName: `mcp__${conn}__set_employee_work_email`,
                advertisedToolName: 'set_employee_work_email',
                mode: 'PROPOSE_ONLY',
                argumentsJson: JSON.stringify({ empNumber: 7 }),
                priorStateJson: JSON.stringify({ workEmail: 'before@example.test' }),
                outcome: 'RECORDED_ONLY',
                settledAt: new Date(),
            },
        });

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(0);
    });

    it('counts an approval the far end later REFUSED', async () => {
        // What the rung is asked to prove is that a human reviewed the write, and
        // the far end's answer is a different fact. Filtering on APPLIED would
        // let an unreliable third party hold a tenant at PROPOSE_ONLY for a
        // reason that has nothing to do with human review.
        await armAtProposeOnly(conn);
        const journalId = await approvedWrite(conn);
        await prisma.externalWriteJournal.update({
            where: { id: journalId },
            data: { outcome: 'FAILED', settledAt: new Date() },
        });

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(1);
    });

    it('ignores approvals from BEFORE the window opened', async () => {
        // Evidence from a previous stint at this rung is not evidence about this
        // one — the same window claim the DRY_RUN block makes.
        await armAtProposeOnly(conn);
        await approvedWrite(conn);
        await prisma.externalWriteJournal.updateMany({
            where: { tenantId: T1, connectionId: conn },
            data: { attemptedAt: new Date(Date.now() - 400 * 86_400_000) },
        });
        await prisma.integrationConnection.update({
            where: { id: conn },
            data: { externalWriteModeSince: new Date(Date.now() - 60 * 86_400_000) },
        });

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(0);
    });

    it("does not count another connection's approved proposals", async () => {
        // Scoping, asserted rather than assumed: the count is per connection, and
        // a query that dropped the connectionId filter would pass every other
        // assertion in this block.
        const other = await makeConnection(T1, `approved-other-${Date.now()}`);
        await armAtProposeOnly(conn);
        await armAtProposeOnly(other);
        await approvedWrite(other);

        const policy = await getExternalWritePolicy(ctx1, conn);
        expect(policy.evidenceInWindow).toBe(0);
    });
});
