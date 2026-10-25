/**
 * A STORED ENGINE THIS BUILD DOES NOT KNOW (#4224).
 *
 * `TenantSecuritySettings.agentDriver` is the Prisma enum `AgentDriverMode`, and
 * `coerceStoredDriverMode` exists to turn an unrecognised value into `STATIC`
 * with the reason `UNRECOGNISED_SETTING`. Read through the generated client it
 * never ran: a Prisma client meeting an enum value it was not generated with
 * fails the whole read. So `GET /admin/agent-driver` answered 500, and `PUT`
 * answered 500 too — because `setAgentDriverSetting` reads the old value through
 * the same helper before its upsert. An owner was told to "choose an engine
 * again to replace it" by a page that could not load and an API that refused the
 * write.
 *
 * ═══ WHY THIS IS AN INTEGRATION TEST, AND THE ONE ASSERTION THAT MATTERS ═══
 *
 * The unit suite already covered the unrecognised case — `agent-driver-setting`
 * sets `row = { agentDriver: 'PROPOSE' }` and passes. It passed because its
 * double RETURNS the string, which is the one thing the real client will not do.
 * A mock cannot express this failure, so no unit test could have caught it, and
 * the repo's evidence for the behaviour was five pieces of PROSE (CLAUDE.md,
 * `docs/claude-agent-sdk-design.md`, two sibling suites' docblocks) and two
 * two-deploy rollouts, with no live measurement anywhere.
 *
 * `the generated client cannot read this row at all` below IS that measurement.
 * It is the control for every other assertion here: without it, a passing suite
 * would not distinguish "the text read fixed it" from "there was never a
 * problem".
 *
 * ═══ HOW THE STATE IS BUILT, AND WHY IT IS SAFE ═══
 *
 * `ALTER TYPE … ADD VALUE IF NOT EXISTS` widens the PHYSICAL type only. The
 * generated client was built from `prisma/schema`, which declares `STATIC` and
 * `FLUE`, so it does not know the added value — exactly the state a rollback
 * produces when a later image shipped a third mode and wrote it.
 *
 * The added label is left behind on purpose: Postgres cannot drop an enum value
 * without recreating the type, and a `RENAME VALUE` round trip would mutate a
 * label other suites read while they run. An unused label is inert, and the
 * repo's own enum guard is one-way —
 * `tests/integration/prisma-enum-values-exist-in-pg.test.ts` reports values
 * Prisma declares that Postgres LACKS, so an extra physical value is not a
 * finding there. The statement is idempotent, so re-runs add nothing.
 *
 * ═══ WHAT IS DELIBERATELY NOT ASSERTED ═══
 *
 * The run path. `resolveDriverForTenant` short-circuits on `ENV_DISABLED`
 * before it reads the column, and `AGENT_DRIVER_FLUE` is unset under test, so a
 * DB-level assertion here would pass whether or not the read were fixed — a
 * control with no discriminating power. What the fix changes there is the
 * REASON (`UNRECOGNISED_SETTING` rather than the catch's `TENANT_NOT_OPTED_IN`),
 * and that is asserted below against the bytes this database really holds, via
 * the pure resolver the run path calls.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { readStoredDriverMode } from '@/lib/agentic/agent-driver-stored-mode';
import { resolveAgentDriver } from '@/lib/agentic/agent-driver';
import {
    getAgentDriverSetting,
    setAgentDriverSetting,
} from '@/app-layer/usecases/agent-driver-setting';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const T = `driver-unknown-${SUITE}`;
/** A value this build's `AgentDriverMode` union does not contain. */
const UNKNOWN = 'TEST_UNKNOWN_DRIVER';

/**
 * A REAL user row, because the PUT audits. `AuditLog.userId` carries a foreign
 * key, so a fabricated id fails the write inside `logEvent` and the test would
 * report the audit's FK rather than anything about #4224.
 */
let ownerId = '';
const ctx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: ownerId });

/** The stored bytes, read the one way that works. */
const storedBytes = () => readStoredDriverMode(prisma, T);

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `owner@${T}.test`;
    const owner = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    ownerId = owner.id;
    await prisma.tenantMembership.create({
        data: { tenantId: T, userId: ownerId, role: 'OWNER', status: 'ACTIVE' },
    });
    await prisma.$executeRawUnsafe(
        `ALTER TYPE "AgentDriverMode" ADD VALUE IF NOT EXISTS '${UNKNOWN}'`,
    );
    await prisma.tenantSecuritySettings.create({ data: { tenantId: T } });
    // Written by raw SQL because the typed client cannot express this value —
    // which is the whole premise.
    await prisma.$executeRawUnsafe(
        `UPDATE "TenantSecuritySettings" SET "agentDriver" = '${UNKNOWN}'::"AgentDriverMode" WHERE "tenantId" = $1`,
        T,
    );
});

afterAll(async () => {
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
});

describe('a stored agent engine this build does not recognise', () => {
    it('THE CONTROL: the generated client cannot read this row at all', async () => {
        // The measurement the repo had only in prose. If this ever stops
        // throwing, the premise of #4224 is gone and the text read below is
        // merely redundant rather than load-bearing — so this failing is
        // information, not noise.
        await expect(
            prisma.tenantSecuritySettings.findUnique({
                where: { tenantId: T },
                select: { agentDriver: true },
            }),
        ).rejects.toThrow();
    });

    it('the text reader returns the bytes the typed client refuses', async () => {
        expect(await storedBytes()).toBe(UNKNOWN);
    });

    it('the settings read answers instead of failing, and reports STATIC', async () => {
        const setting = await getAgentDriverSetting(ctx());
        expect(setting.mode).toBe('STATIC');
    });

    it('UNRECOGNISED_SETTING is reachable from the bytes this database holds', async () => {
        // End to end: the real stored value, through the resolver the run path
        // calls, reaches the arm written for it. `envEnabled: true` because the
        // run path checks the operator switch first and it is off under test —
        // see the header.
        const decision = resolveAgentDriver({ envEnabled: true, tenantSetting: await storedBytes() });
        expect(decision.driver).toBe('static');
        expect(decision.reason).toBe('UNRECOGNISED_SETTING');
    });

    it('an owner can replace the value — the recovery the 500 prevented', async () => {
        // `setAgentDriverSetting` reads the old value first, to audit it. That
        // read is why the PUT answered 500 as well as the GET, so this is the
        // half of #4224 an owner actually feels.
        await setAgentDriverSetting(ctx(), 'STATIC');
        expect(await storedBytes()).toBe('STATIC');

        // And the row is readable by the typed client again, which is the state
        // the owner was trying to reach.
        const row = await prisma.tenantSecuritySettings.findUnique({
            where: { tenantId: T },
            select: { agentDriver: true },
        });
        expect(row?.agentDriver).toBe('STATIC');
    });
});
