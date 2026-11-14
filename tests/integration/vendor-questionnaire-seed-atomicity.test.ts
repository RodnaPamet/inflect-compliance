/**
 * #5654 — a vendor questionnaire template exists complete or not at all.
 *
 * Both seeders wrote the template, then its sections, then its questions,
 * outside any transaction, and the idempotency gate reads ONLY the template
 * row — which was written first. An interrupted run therefore left a published
 * template with some or none of its sections, and every later run found it,
 * returned false, and logged "already present". `entrypoint.sh` runs the
 * production seeder on every container start and swallows the exit code, so
 * the interruption is the ordinary case rather than the exotic one.
 *
 * This drives the REAL transaction against the REAL database and injects a
 * failure partway through the questions, because that is the only way to
 * observe a rollback: a mocked client has nothing to roll back, and the
 * existing suites cover the fixtures' content and the production wiring, not
 * the half-written case the gate cannot see.
 */
import type { PrismaClient } from '@prisma/client';

import {
    seedAisvsVendorQuestionnaire,
    type AisvsQuestionnaireFixture,
} from '../../prisma/aisvs-vendor-questionnaire';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';

const prisma = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const KEY = 'test-atomicity-questionnaire';

const FIXTURE: AisvsQuestionnaireFixture = {
    key: KEY,
    name: 'Atomicity probe',
    description: 'Fixture for #5654.',
    attribution: 'none',
    sections: [
        {
            title: 'First',
            weight: 1,
            conditional: false,
            questions: [
                { aisvsId: 'A1', level: '1', weight: 1, prompt: 'q1' },
                { aisvsId: 'A2', level: '1', weight: 1, prompt: 'q2' },
            ],
        },
        {
            title: 'Second',
            weight: 1,
            conditional: false,
            questions: [
                { aisvsId: 'B1', level: '1', weight: 1, prompt: 'q3' },
                { aisvsId: 'B2', level: '1', weight: 1, prompt: 'q4' },
            ],
        },
    ],
};

/**
 * The real client, except that the Nth question create inside the transaction
 * throws. `$transaction` is forwarded to the REAL one, so the rollback being
 * observed is Postgres's, not a fake's.
 */
function failingAfter(nQuestions: number): PrismaClient {
    let seen = 0;
    return new Proxy(prisma, {
        get(target, prop, recv) {
            if (prop === '$transaction') {
                return (cb: (tx: unknown) => Promise<unknown>) =>
                    (target as PrismaClient).$transaction((tx) =>
                        cb(new Proxy(tx as object, {
                            get(t, p, r) {
                                if (p === 'vendorAssessmentTemplateQuestion') {
                                    const delegate = Reflect.get(t, p, r) as {
                                        create: (a: unknown) => Promise<unknown>;
                                    };
                                    return {
                                        ...delegate,
                                        create: async (args: unknown) => {
                                            seen += 1;
                                            if (seen > nQuestions) {
                                                throw new Error('injected failure mid-seed');
                                            }
                                            return delegate.create(args);
                                        },
                                    };
                                }
                                return Reflect.get(t, p, r);
                            },
                        })));
            }
            return Reflect.get(target, prop, recv);
        },
    }) as PrismaClient;
}

describeFn('vendor questionnaire seeding is atomic (#5654)', () => {
    let tenantId: string;

    beforeEach(async () => {
        const t = await prisma.tenant.create({
            data: { name: `atomicity-${Date.now()}`, slug: `atomicity-${Date.now()}` },
            select: { id: true },
        });
        tenantId = t.id;
    });

    afterEach(async () => {
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    });

    const counts = async () => ({
        templates: await prisma.vendorAssessmentTemplate.count({ where: { tenantId, key: KEY } }),
        sections: await prisma.vendorAssessmentTemplateSection.count({ where: { tenantId } }),
        questions: await prisma.vendorAssessmentTemplateQuestion.count({ where: { tenantId } }),
    });

    it('CONTROL — an uninterrupted seed writes the whole tree', async () => {
        // Without this the rollback assertion below could pass against a seeder
        // that writes nothing at all.
        await expect(seedAisvsVendorQuestionnaire(prisma, FIXTURE, tenantId, null))
            .resolves.toBe(true);
        expect(await counts()).toEqual({ templates: 1, sections: 2, questions: 4 });
    });

    it('leaves NO template behind when a question fails partway', async () => {
        await expect(seedAisvsVendorQuestionnaire(failingAfter(3), FIXTURE, tenantId, null))
            .rejects.toThrow(/injected failure mid-seed/);

        // THE DEFECT. Before #5654 the template and three questions were
        // committed, and because the gate reads only the template row the
        // tenant kept a published, incomplete questionnaire for ever.
        expect(await counts()).toEqual({ templates: 0, sections: 0, questions: 0 });
    });

    it('fails on the FIRST question and still leaves nothing', async () => {
        await expect(seedAisvsVendorQuestionnaire(failingAfter(0), FIXTURE, tenantId, null))
            .rejects.toThrow(/injected failure mid-seed/);
        expect(await counts()).toEqual({ templates: 0, sections: 0, questions: 0 });
    });

    it('a later run after a rolled-back one seeds completely, rather than reporting "already present"', async () => {
        // The consequence that mattered in production: the gate could not tell
        // a complete template from a half-written one, so a retry was a no-op.
        await expect(seedAisvsVendorQuestionnaire(failingAfter(2), FIXTURE, tenantId, null))
            .rejects.toThrow();
        await expect(seedAisvsVendorQuestionnaire(prisma, FIXTURE, tenantId, null))
            .resolves.toBe(true);
        expect(await counts()).toEqual({ templates: 1, sections: 2, questions: 4 });
    });

    it('is still idempotent on a COMPLETE template', async () => {
        await seedAisvsVendorQuestionnaire(prisma, FIXTURE, tenantId, null);
        await expect(seedAisvsVendorQuestionnaire(prisma, FIXTURE, tenantId, null))
            .resolves.toBe(false);
        expect(await counts()).toEqual({ templates: 1, sections: 2, questions: 4 });
    });
});
