/**
 * The SSO hand-off and the SAML flow spend, against a real Postgres (#5376).
 *
 * `tests/unit/sso-handoff-session.test.ts` proves single use against an
 * in-memory double of `VerificationToken`. A double cannot prove what these
 * two modules actually rely on, which is the database: that a `deleteMany`
 * racing another `deleteMany` over the same row reports the row to exactly
 * one of them, and that the unique index on `token` refuses the second
 * insert. So this file runs the real modules over the real table:
 *
 *   - two (and more) concurrent redemptions of one hand-off: exactly one
 *     returns the hand-off, the rest are `USED`;
 *   - an expired hand-off redeems nothing, and stays unredeemable;
 *   - a flow spent twice returns `false` the second time, and of concurrent
 *     spends exactly one returns `true`;
 *   - the two namespaces in `VerificationToken` do not cross: a spent flow id
 *     presented as a hand-off redeems nothing, and spending a hand-off's raw
 *     token as a flow id neither consumes nor redeems the hand-off.
 */
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';

import {
    issueSsoHandoff,
    redeemSsoHandoff,
    redeemSsoHandoffOutcome,
} from '@/lib/auth/sso-handoff';
import { spendSsoFlowOnce } from '@/lib/auth/sso-flow-spend';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const HANDOFF_PREFIX = 'sso-handoff:';
const FLOW_IDENTIFIER = 'sso-flow-spent:saml';

describeFn('SSO hand-off and flow spend — single use against Postgres', () => {
    let prisma: PrismaClient;
    const run = `h${Date.now()}${randomBytes(3).toString('hex')}`;
    const tenantId = `tenant-${run}`;
    const spentFlowIds: string[] = [];

    function flowHash(flowId: string): string {
        return createHash('sha256').update(`${FLOW_IDENTIFIER}:${flowId}`).digest('hex');
    }

    function handoffFor(userId: string) {
        return { tenantId, userId: `${userId}-${run}` };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.verificationToken.deleteMany({
            where: { identifier: { startsWith: `${HANDOFF_PREFIX}${tenantId}:` } },
        });
        await prisma.verificationToken.deleteMany({
            where: { identifier: FLOW_IDENTIFIER, token: { in: spentFlowIds.map(flowHash) } },
        });
        await prisma.$disconnect();
    });

    describe('hand-off', () => {
        it('stores only a hash, under the hand-off namespace', async () => {
            const raw = await issueSsoHandoff(handoffFor('stored'));
            const rows = await prisma.verificationToken.findMany({
                where: { identifier: `${HANDOFF_PREFIX}${tenantId}:stored-${run}` },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0].token).toMatch(/^[a-f0-9]{64}$/);
            expect(rows[0].token).not.toBe(raw);
        });

        it('redeems once, then refuses as USED', async () => {
            const handoff = handoffFor('once');
            const raw = await issueSsoHandoff(handoff);

            await expect(redeemSsoHandoff(raw)).resolves.toEqual(handoff);
            await expect(redeemSsoHandoffOutcome(raw)).resolves.toEqual({ refused: 'USED' });
        });

        it('of concurrent redemptions of one hand-off, exactly one succeeds', async () => {
            const handoff = handoffFor('race');
            const raw = await issueSsoHandoff(handoff);

            const outcomes = await Promise.all(
                Array.from({ length: 8 }, () => redeemSsoHandoffOutcome(raw)),
            );

            const won = outcomes.filter((o) => 'handoff' in o);
            expect(won).toEqual([{ handoff }]);
            for (const o of outcomes.filter((x) => !('handoff' in x))) {
                expect(o).toEqual({ refused: 'USED' });
            }
            // And the row is gone: nothing left to redeem later.
            const left = await prisma.verificationToken.count({
                where: { identifier: `${HANDOFF_PREFIX}${tenantId}:race-${run}` },
            });
            expect(left).toBe(0);
        });

        it('two concurrent redemptions: one hand-off, one USED', async () => {
            const handoff = handoffFor('pair');
            const raw = await issueSsoHandoff(handoff);

            const [a, b] = await Promise.all([redeemSsoHandoff(raw), redeemSsoHandoff(raw)]);
            expect([a, b].filter((x) => x !== null)).toEqual([handoff]);
        });

        it('an expired hand-off redeems nothing, and stays unredeemable', async () => {
            const handoff = handoffFor('expired');
            const raw = await issueSsoHandoff(handoff);
            await prisma.verificationToken.updateMany({
                where: { identifier: `${HANDOFF_PREFIX}${tenantId}:expired-${run}` },
                data: { expires: new Date(Date.now() - 1000) },
            });

            await expect(redeemSsoHandoffOutcome(raw)).resolves.toEqual({ refused: 'EXPIRED' });
            await expect(redeemSsoHandoff(raw)).resolves.toBeNull();
        });

        it('an unknown or missing token redeems nothing', async () => {
            await expect(redeemSsoHandoffOutcome(randomBytes(32).toString('base64url')))
                .resolves.toEqual({ refused: 'USED' });
            await expect(redeemSsoHandoffOutcome('')).resolves.toEqual({ refused: 'MISSING' });
            await expect(redeemSsoHandoffOutcome(null)).resolves.toEqual({ refused: 'MISSING' });
        });
    });

    describe('flow spend', () => {
        function flowRowCount(): Promise<number> {
            return prisma.verificationToken.count({ where: { identifier: FLOW_IDENTIFIER } });
        }

        function flow(name: string): string {
            const id = `${name}-${run}`;
            spentFlowIds.push(id);
            return id;
        }

        it('a flow spent twice returns false the second time', async () => {
            const flowId = flow('flow-twice');
            await expect(spendSsoFlowOnce(flowId)).resolves.toBe(true);
            await expect(spendSsoFlowOnce(flowId)).resolves.toBe(false);
        });

        it('of concurrent spends of one flow, exactly one returns true', async () => {
            const flowId = flow('flow-race');
            const results = await Promise.all(
                Array.from({ length: 8 }, () => spendSsoFlowOnce(flowId)),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(results.filter((r) => !r)).toHaveLength(7);
        });

        it('different flows are spent independently', async () => {
            await expect(spendSsoFlowOnce(flow('flow-a'))).resolves.toBe(true);
            await expect(spendSsoFlowOnce(flow('flow-b'))).resolves.toBe(true);
        });

        it('a spent flow id presented as a hand-off redeems nothing, and the flow stays spent', async () => {
            const flowId = flow('flow-cross');
            await expect(spendSsoFlowOnce(flowId)).resolves.toBe(true);
            const before = await flowRowCount();

            await expect(redeemSsoHandoff(flowId)).resolves.toBeNull();

            expect(await flowRowCount()).toBe(before);
            await expect(spendSsoFlowOnce(flowId)).resolves.toBe(false);
        });

        it("spending a hand-off's raw token as a flow id neither consumes nor redeems the hand-off", async () => {
            const handoff = handoffFor('cross');
            const raw = await issueSsoHandoff(handoff);

            // A different namespace: the flow spend sees a flow it has never
            // seen, and must not have touched the hand-off row.
            spentFlowIds.push(raw);
            await expect(spendSsoFlowOnce(raw)).resolves.toBe(true);
            await expect(redeemSsoHandoff(raw)).resolves.toEqual(handoff);
        });
    });
});
