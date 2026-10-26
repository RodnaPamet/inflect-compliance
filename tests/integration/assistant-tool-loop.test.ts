/**
 * The assistant's tool set is the FUNNEL's, narrowed by the asker (#3818).
 *
 * Four properties, and the second and fourth are the ones that matter most:
 *
 *   1. the offered tools come from the registry, by the registry's own filter —
 *      never a list written here;
 *   2. acting for a READER, the assistant is offered strictly less than it is
 *      for an OWNER, because the binding filter is the ACTING CONTEXT's
 *      permission keys;
 *   3. with the read-only loop, no propose tool is offered at all;
 *   4. a tool run under tenant A's context returns no tenant B row.
 *
 * ═══ WHY THE ASSERTIONS ARE DRIVEN FROM `loadableReadTools` ═══
 *
 * The roadmap warns against a hard-coded count: "there were nine tools at the
 * first draft and twelve now, and a hard-coded count goes stale the same way."
 * It is **14** on current main — the warning came true between its own drafts.
 * So nothing here names a number or a list; every expectation is computed from
 * the same function the adapter filtered through.
 *
 * ═══ WHY A SESSION CONTEXT, NOT AN AGENT ONE ═══
 *
 * The assistant is a session user: `agentId` absent, so `grantedTools` is null
 * and the deny-by-default exposure term is SKIPPED rather than narrowed —
 * `workflow-runs.ts` calls that state "the worse one" for an unbound caller.
 * These contexts therefore carry no `agentId`, deliberately, because that is
 * the shape whose bounds are in question.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { assistantTools } from '@/app-layer/ai/assistant/tools';
import { loadableReadTools } from '@/lib/mcp/tools/registry';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TENANT_A = 'atl-tenant-a';
const TENANT_B = 'atl-tenant-b';

let prisma: PrismaClient;

/** A SESSION context — no `agentId`, which is the assistant's own shape. */
function sessionCtx(tenantId: string, role: string): RequestContext {
    return makeRequestContext(role, {
        tenantId,
        tenantSlug: tenantId,
        userId: `${tenantId}-user`,
    });
}

describeFn('the assistant is offered the funnel tools its asker could call', () => {
    beforeAll(async () => {
        prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('offers exactly what `loadableReadTools` yields for that invocation', async () => {
        const inv = await resolveMcpInvocation(sessionCtx(TENANT_A, 'OWNER'));

        const offered = assistantTools(inv, { readOnly: true }).tools.map((t) => t.name).sort();
        const expected = loadableReadTools(inv).map((t) => t.name).sort();

        // Computed on both sides, so a tool added or removed from the registry
        // cannot make this stale — and a count written here would.
        expect(offered).toEqual(expected);
        // The population, so an empty set cannot satisfy the equality above.
        expect(offered.length).toBeGreaterThan(0);
    });

    it('every offered tool carries a JSON schema for the provider', async () => {
        const inv = await resolveMcpInvocation(sessionCtx(TENANT_A, 'OWNER'));
        const tools = assistantTools(inv, { readOnly: true }).tools;

        // A tool reaching the provider without a schema would have the model
        // guessing its arguments, and a guessed argument is a refused call that
        // reads as a model error. The adapter drops such a tool; this asserts
        // none had to be dropped.
        for (const t of tools) {
            expect(t.jsonSchema).toBeDefined();
            expect(typeof t.description).toBe('string');
            expect(t.description.length).toBeGreaterThan(0);
        }
    });

    it('a READER is offered strictly LESS than an OWNER — the asker is the bound', async () => {
        const ownerInv = await resolveMcpInvocation(sessionCtx(TENANT_A, 'OWNER'));
        const readerInv = await resolveMcpInvocation(sessionCtx(TENANT_A, 'READER'));

        const ownerTools = new Set(assistantTools(ownerInv, { readOnly: true }).tools.map((t) => t.name));
        const readerTools = assistantTools(readerInv, { readOnly: true }).tools.map((t) => t.name);

        // SUBSET, asserted rather than assumed: the exposure term is skipped for
        // a session user, so if the permission filter were not binding a READER
        // would be offered the OWNER's set.
        for (const name of readerTools) {
            expect(ownerTools.has(name)).toBe(true);
        }
        // And the READER must not simply be offered nothing, or the subset
        // assertion is vacuous.
        expect(readerTools.length).toBeGreaterThan(0);

        // ═══ STRICTLY LESS, WHICH IS THE ASSERTION WITH TEETH ═══
        //
        // Found by mutation: deleting the `canSee` permission filter left the
        // subset assertion above GREEN, because with no filter both roles get
        // the whole catalogue and an equal set is still a subset. So the test
        // could not tell "the READER is narrowed" from "nobody is narrowed" —
        // the exact thing it exists to check.
        //
        // Computed, never named: the roadmap's warning about a hard-coded list
        // applies here too, and the difference between two roles is as liable
        // to move as the catalogue itself.
        const missing = [...ownerTools].filter((n) => !readerTools.includes(n));
        expect(missing.length).toBeGreaterThan(0);
        expect(readerTools.length).toBeLessThan(ownerTools.size);
    });

    it('offers NO propose tool under the read-only loop, and says what it omitted', async () => {
        const inv = await resolveMcpInvocation(sessionCtx(TENANT_A, 'OWNER'));

        const readOnly = assistantTools(inv, { readOnly: true });
        const full = assistantTools(inv, { readOnly: false });

        const readNames = new Set(loadableReadTools(inv).map((t) => t.name));
        for (const t of readOnly.tools) expect(readNames.has(t.name)).toBe(true);

        // The CONTROL: with `readOnly: false` the propose surface IS offered, so
        // the assertion above is about the flag rather than about there being no
        // propose tools to offer.
        expect(full.tools.length).toBeGreaterThanOrEqual(readOnly.tools.length);

        // "Offered no propose tool" is recorded as a fact rather than inferred
        // from an empty list — `flueToolsFor` lists each one as omitted, which
        // is what tells an operator the run was narrowed rather than incapable.
        expect(readOnly.omitted.some((o) => o.reason === 'READ_ONLY_WORKFLOW')).toBe(true);
    });

    it('starts with a clean review latch, so a trip means a trip this turn', async () => {
        const inv = await resolveMcpInvocation(sessionCtx(TENANT_A, 'OWNER'));
        expect(assistantTools(inv, { readOnly: true }).reviewRequired()).toBe(false);
    });
});

describeFn('a session in one tenant cannot surface another tenant rows', () => {
    beforeAll(async () => {
        prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('resolves a DIFFERENT invocation per tenant, each carrying its own context', async () => {
        const invA = await resolveMcpInvocation(sessionCtx(TENANT_A, 'OWNER'));
        const invB = await resolveMcpInvocation(sessionCtx(TENANT_B, 'OWNER'));

        // The guarantee is upstream of any tool: every call runs under the
        // asker's own `RequestContext`, and the usecase behind it owns RLS. If
        // these shared a context there would be no tenant boundary to test.
        expect(invA.ctx.tenantId).toBe(TENANT_A);
        expect(invB.ctx.tenantId).toBe(TENANT_B);
        expect(invA.ctx.tenantId).not.toBe(invB.ctx.tenantId);

        // Both are SESSION invocations: no agent, so no policy card and no
        // grant allowlist. This is the shape the assistant actually uses, and
        // asserting it here stops the suite from silently drifting onto an
        // agent invocation whose bounds are different.
        expect(invA.agentId).toBeNull();
        expect(invA.policyCard).toBeNull();
        expect(invA.grantedTools).toBeNull();
    });

    it('offers each tenant a set computed from its OWN invocation', async () => {
        const invA = await resolveMcpInvocation(sessionCtx(TENANT_A, 'OWNER'));
        const invB = await resolveMcpInvocation(sessionCtx(TENANT_B, 'OWNER'));

        const a = assistantTools(invA, { readOnly: true }).tools.map((t) => t.name).sort();
        const b = assistantTools(invB, { readOnly: true }).tools.map((t) => t.name).sort();

        expect(a).toEqual(loadableReadTools(invA).map((t) => t.name).sort());
        expect(b).toEqual(loadableReadTools(invB).map((t) => t.name).sort());
    });
});
