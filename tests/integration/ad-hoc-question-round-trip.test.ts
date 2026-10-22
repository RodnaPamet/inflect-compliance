/**
 * A QUESTION ASKED AND READ BACK, OVER A REAL DATABASE (#3869).
 *
 * The last of M2's named tests. The unit suites mock both ends — the starter on
 * one side, `runInTenantContext` on the other — so neither can show that
 * `askAdHocQuestion` and `readAdHocQuestionResult` actually COMPOSE. This does:
 * one real run row written by the real `startWorkflowRun`, read back through
 * the real requester gate against real RLS.
 *
 * ## What is stubbed, and what is emphatically not
 *
 * The MODEL is. `driver: 'flue'` is a REQUEST, and with Flue not enabled for
 * this tenant the selector resolves to the STATIC engine, which walks steps and
 * calls no model. That is the honest shape available here: `@flue/runtime` is
 * an ESM-only optional dependency, the `flue` Jest project exists for it alone,
 * every test in that project is a double, and it needs Node 24 where this
 * runs on 22.
 *
 * Everything else is real — the tenant, the membership, the register row, the
 * designation, the budget pre-flight, the concurrency slot, the Flue gate's
 * standing check, the run row, the step rows, the `WHERE` clause of the
 * requester gate.
 *
 * ## So the static arm is the subject, and that is a feature
 *
 * The workflow's static arm returns "No answer was produced: this run used the
 * static engine, which calls no model." Reading it back proves something worth
 * proving: an honest non-answer SURVIVES the round trip instead of being
 * swallowed into a null the surface would render as an empty answer. A reader
 * handed nothing cannot tell "no answer" from "answer not loaded".
 *
 * The Flue-shaped path is covered beside it by writing the `AiDecisionLog` row
 * Flue would write, which is the ONLY thing the model's participation
 * contributes to what this reader returns.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';

/**
 * The deployment half of the gate, turned on for this suite.
 *
 * Mocked rather than assigned on `process.env`: an assignment at module scope
 * runs AFTER the import hoisting that loads `@/env`, so it would have no effect
 * and every case here would refuse itself DEPLOYMENT_NOT_ENABLED.
 *
 * DELEGATED THROUGH A PROXY, NOT SPREAD — and the first attempt spread it,
 * which cost an hour of looking at the wrong thing. `createEnv` returns a
 * PROXY, and spreading one whose `ownKeys` trap is not implemented yields an
 * EMPTY object: the mock's `env` then held exactly one key, every other var
 * read as `undefined`, and the app's Prisma client fell back to a default
 * connection string. The failure surfaced as
 * `Can't reach database server at 127.0.0.1:5432` from inside
 * `resolveInteractiveAgent` — a database error with no obvious connection to a
 * feature flag.
 *
 * A proxy that delegates every other key preserves the real values by
 * CONSTRUCTION rather than by copying them, so nothing silently goes missing.
 */
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (key === 'AGENT_INTERACTIVE_RUNS' ? '1' : Reflect.get(target, key)),
        }),
    };
});

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const TAG = `ask-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let askerId = '';
let agentId = '';
let aiSystemId = '';

/**
 * A READER's context — deliberately the lowest role that may ask.
 *
 * Built with the shared helper rather than by hand: `permissions` is the coarse
 * `{ canRead, canWrite, canAdmin, canAudit, canExport }` tier and
 * `appPermissions` the granular set, and a hand-rolled pair drifts from how
 * every other suite builds one.
 */
const readerCtx = (): RequestContext =>
    makeRequestContext('READER', { requestId: `req-${TAG}`, userId: askerId, tenantId: TENANT_ID, tenantSlug: TAG });

describeFn('a question asked and read back (integration)', () => {
    beforeAll(async () => {
        // WITH A PER-TENANT DEK. Without one the row exists and everything
        // writes fine — `WorkflowStep.outputJson` is in the encryption manifest
        // and stores a `v2:` ciphertext — but every READ through the app's
        // client decrypts to NULL, because `v2:` is wrapped under a DEK this
        // tenant does not have. The symptom is a column that is present and
        // empty, which reads like a driver that stored nothing.
        const { wrapped } = generateAndWrapDek();
        await prisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: { encryptedDek: wrapped },
            create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG, encryptedDek: wrapped },
        });
        const email = `${TAG}@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        askerId = u.id;
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId: askerId, role: Role.READER, status: MembershipStatus.ACTIVE },
        });

        const sys = await prisma.aiSystem.create({ data: { tenantId: TENANT_ID, name: `sys ${TAG}` } });
        aiSystemId = sys.id;

        // ACTIVE, because the Flue gate refuses any other standing before the
        // run row exists — `flue_requires_registered_agent`.
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT_ID,
                aiSystemId,
                name: `agent ${TAG}`,
                autonomyLevel: 1,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: askerId,
                status: 'ACTIVE',
            },
        });
        agentId = agent.id;

        // The TENANT half of the gate. Without this the resolver refuses
        // NO_AGENT_DESIGNATED, which is a refusal this suite asserts separately.
        await prisma.tenantSecuritySettings.upsert({
            where: { tenantId: TENANT_ID },
            update: { interactiveAgentId: agentId },
            create: { tenantId: TENANT_ID, interactiveAgentId: agentId },
        });
    });

    afterAll(async () => {
        // AUDIT ROWS FIRST, with the immutability triggers disabled.
        //
        // `AuditLog` has real foreign keys to Tenant and User, and every suite
        // that drives a usecase writes audit rows — this one starts real runs,
        // so it writes several. Deleting the parents without clearing them
        // fails, and whether it fails depends on whether the table happens to
        // be empty, which depends on which sibling suite ran first. That is an
        // order-dependent teardown, which is worse than a failing one.
        //
        // Through the helper rather than a raw delete: the rows are protected
        // by immutability triggers, so a plain `deleteMany` cannot remove them.
        // By TENANT is enough: every audit row this suite writes carries this
        // tenantId, and the user is only ever an actor on those rows. There is
        // no `deleteAuditRowsForUsers` helper, which is consistent with that.
        await deleteAuditRowsForTenants(prisma, [TENANT_ID]);

        const t = { tenantId: TENANT_ID };
        for (const m of [
            'aiDecisionLog',
            'workflowStep',
            'workflowRun',
            'registeredAgent',
            'aiSystem',
            'tenantSecuritySettings',
            'tenantMembership',
        ] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (prisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await prisma.user.deleteMany({ where: { id: askerId } }); } catch { /* best effort */ }
        try { await prisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await prisma.$disconnect();
    });

    it('a READER asks, a run row exists, and the result reads back through the requester gate', async () => {
        const { askAdHocQuestion } = await import('@/app-layer/usecases/ad-hoc-question');
        const { readAdHocQuestionResult } = await import('@/app-layer/usecases/ad-hoc-question-result');

        const started = await askAdHocQuestion(readerCtx(), '<b>Which</b> controls have no evidence?');
        expect(started.runId).toBeTruthy();

        // The row is REAL, written by the real starter, and carries the facts
        // the reader's gate depends on.
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId } });
        expect(row).toMatchObject({
            tenantId: TENANT_ID,
            workflowKey: 'ad-hoc-question',
            // The asker, which is what makes `startedByUserId` the right gate
            // term for a directly-started run.
            startedByUserId: askerId,
            // No automation rule caused this — the third gate term.
            parentExecutionId: null,
            // The agent the TENANT designated, bound by the starter.
            agentId,
        });

        const result = await readAdHocQuestionResult(readerCtx(), started.runId);
        expect(result.runId).toBe(started.runId);
        // The honest non-answer SURVIVES rather than becoming a null the
        // surface would render as an empty answer.
        expect(result.answer).toContain('No answer was produced');
        expect(result.catalogueWasEmpty).toBe(false);
        // Nothing ran, so no model is reported — not a fallback to what the
        // agent declares.
        expect(result.model).toBeNull();
    });

    it('the SANITISED question reached the run, not the markup', async () => {
        const { askAdHocQuestion } = await import('@/app-layer/usecases/ad-hoc-question');
        // READ THROUGH `runInTenantContext`, which is how the app reads it, and
        // the only way this assertion can see its subject. Three things had to
        // line up, and each failure looked like something else:
        //
        //   1. `WorkflowStep.outputJson` is in the encryption manifest, so this
        //      suite's own client returns `v2:` ciphertext. A
        //      `not.toContain('<script>')` against that passes VACUOUSLY — it
        //      reads as a security assertion while being unable to fail.
        //   2. The tenant needs a per-tenant DEK. Without one the writes
        //      succeed and every read decrypts to NULL.
        //   3. The extension resolves that DEK from the BOUND TENANT, so even
        //      with a DEK a bare `findMany` outside this context returns NULL.
        //
        // All three present as "the column is empty", which reads like a driver
        // that stored nothing. The POSITIVE half is what exposed each of them:
        // a negation alone would have passed throughout.
        const { runInTenantContext } = await import('@/lib/db-context');
        const started = await askAdHocQuestion(readerCtx(), '<script>x</script>Which risks are untreated?');

        const steps = await runInTenantContext(readerCtx(), (db) =>
            db.workflowStep.findMany({ where: { runId: started.runId, tenantId: TENANT_ID } }),
        );
        const stored = JSON.stringify(steps.map((x) => x.outputJson));
        expect(stored).toContain('Which risks are untreated');
        expect(stored).not.toContain('<script>');
    });

    it('the Flue-shaped answer is read from the decision log, keyed on the run', async () => {
        const { askAdHocQuestion } = await import('@/app-layer/usecases/ad-hoc-question');
        const { readAdHocQuestionResult } = await import('@/app-layer/usecases/ad-hoc-question-result');
        const started = await askAdHocQuestion(readerCtx(), 'Which controls are overdue?');

        // The ONE thing the model's participation contributes to what this
        // reader returns. Written directly because the engine that would write
        // it cannot run in this Jest project.
        await prisma.aiDecisionLog.create({
            data: {
                tenantId: TENANT_ID,
                sessionRef: started.runId,
                model: 'claude-sonnet-5-5',
                outputSummary: 'Three controls have no evidence this quarter.',
                // Required columns. `inputDigest` is a digest rather than the
                // input, which is the point of the column — the log records
                // THAT an input was seen without keeping it.
                feature: 'ad-hoc-question',
                provider: 'anthropic',
                inputDigest: 'digest-not-the-input',
            },
        });

        const result = await readAdHocQuestionResult(readerCtx(), started.runId);
        expect(result.model).toBe('claude-sonnet-5-5');
        expect(result.answer).toBe('Three controls have no evidence this quarter.');
    });

    it('ANOTHER person in the same tenant cannot read it', async () => {
        const { askAdHocQuestion } = await import('@/app-layer/usecases/ad-hoc-question');
        const { readAdHocQuestionResult } = await import('@/app-layer/usecases/ad-hoc-question-result');
        const started = await askAdHocQuestion(readerCtx(), 'A private question?');

        // Same tenant, same role, different person — so this is the requester
        // gate being tested, not tenant isolation, which has its own coverage.
        const other: RequestContext = { ...readerCtx(), userId: `${askerId}-someone-else` };
        await expect(readAdHocQuestionResult(other, started.runId)).rejects.toThrow(/RUN_NOT_READABLE/);
    });

    it('and an inventory reader CAN, which is what makes the refusal above mean something', async () => {
        const { askAdHocQuestion } = await import('@/app-layer/usecases/ad-hoc-question');
        const { readAdHocQuestionResult } = await import('@/app-layer/usecases/ad-hoc-question-result');
        const started = await askAdHocQuestion(readerCtx(), 'Another question?');

        // Without this the refusal above would pass for a reader that refused
        // everybody, including the person who asked.
        const admin: RequestContext = {
            ...readerCtx(),
            userId: `${askerId}-admin`,
            role: 'OWNER',
            appPermissions: getPermissionsForRole('OWNER'),
        };
        const result = await readAdHocQuestionResult(admin, started.runId);
        expect(result.runId).toBe(started.runId);
    });
});
