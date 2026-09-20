/**
 * E2E — EVERY AGENTIC ROUTE, RENDERING ITS DATA RATHER THAN ITS EMPTY STATE.
 *
 * ── THE GAP THIS CLOSES, MEASURED ───────────────────────────────────────────
 *
 * The agentic subsystem is covered at every layer and still had this hole. On
 * 2026-09-20: 31 rendered tests, integration coverage on every page loader, and
 * `tests/integration/agents-subpage-authz.test.ts` invoking all six page modules
 * against a real database. But the whole E2E suite visited exactly ONE agentic
 * route — `/agents` — and posted to two endpoints.
 *
 * Each of those layers stops short of the same seam, and it is not the same
 * seam each time:
 *
 *   · The rendered tests HAND-BUILD their props. They prove the component draws
 *     what it is given, never that the page gives it that. A loader whose field
 *     is renamed, or mapped to the wrong prop, keeps all 31 green.
 *   · The integration tests call the loader DIRECTLY. Real data, real database
 *     — and no component, so the same mapping is again unobserved.
 *   · `agents-subpage-authz` does drive the pages, but asks whether they REFUSE
 *     and whether they LEAK. A page that renders every row as blank satisfies
 *     both.
 *
 * So this walks the whole surface with rows actually in it, which is the only
 * arrangement in which a wrong mapping has to show.
 *
 * ── WHY EACH ASSERTION HAS TWO HALVES ───────────────────────────────────────
 *
 * "The page rendered something" is not "the page rendered the data". Every
 * check below both names a value that was SEEDED and requires the page's own
 * empty-state string to be ABSENT. One half alone is satisfied by the wrong
 * outcome: a page stuck on its empty state still shows a heading, and a page
 * that renders a spinner forever never shows the empty state either.
 *
 * ── WHERE EMPTY IS THE RIGHT ANSWER, AND IS ASSERTED AS SUCH ────────────────
 *
 * Proposals and quarantine are deliberately left empty. `agent-proposals` is
 * GET-only by design: a proposal is created by an AGENT over MCP, never by an
 * operator, so there is no endpoint this spec could call and an empty queue is
 * the correct state for a tenant no agent has ever called into. Asserting the
 * empty state there is the honest claim — and it is still worth making, because
 * it distinguishes "correctly empty" from "broken and therefore empty", which
 * is exactly the pair nobody could tell apart in production.
 *
 * MUTATING: seeds an agent, a run and a receipt, so it takes `isolatedTenant`
 * and gets a fresh empty tenant. Everything is one `test()` with steps — the
 * seed is shared state, and a `let` assigned in one test and read by another is
 * the cascade `tests/guards/e2e-isolation.test.ts` bans.
 *
 * Scoped to `getByRole('main')` throughout: these pages stream through a
 * Suspense boundary and CI load can leave a second hidden copy of the subtree,
 * which is harmless to a reader and fatal to a bare locator under strict mode.
 */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { test, expect } from './fixtures';
import { safeGoto } from './e2e-utils';
import en from '../../messages/en.json';

/**
 * A well-formed receipt, signed by a key generated here.
 *
 * IT IS NOT EXPECTED TO VERIFY, and that is the realistic case rather than a
 * shortcut. The server checks the signature against `env.PIPELOCK_PUBLIC_KEY`,
 * which neither the E2E stack nor production sets, so no receipt either of them
 * sees can verify. `ingestReceipt` persists the row regardless — verification
 * gates only the hash-chained audit link, and the `create` sits outside that
 * branch — so the UNVERIFIED path is the one this exercises and the one a real
 * deployment is on today.
 *
 * Because verification is not the subject, this signs the record's plain JSON
 * rather than importing the server's canonical form. That import would be the
 * FIRST `@/…` in the whole E2E suite (measured: zero today), which is a runtime
 * module-resolution risk taken for a byte sequence whose only requirement here
 * is that the zod schema accept its shape. `tests/unit/agent-action-receipt.ts`
 * owns the verifying case and uses the real `receiptSignedMessage`.
 */
function signedReceipt(actionRecord: Record<string, unknown>) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const sig = cryptoSign(null, Buffer.from(JSON.stringify(actionRecord)), privateKey);
    return {
        action_record: actionRecord,
        signature: `ed25519:${sig.toString('hex')}`,
        signer_key: pubHex,
    };
}

test.describe('every agentic route renders its data', () => {
    test('seed the subsystem, then walk all of it', async ({
        authedPage: page,
        isolatedTenant,
    }) => {
        const { tenantSlug, ownerUserId } = isolatedTenant;
        const main = page.getByRole('main');
        const stamp = Date.now();
        const agentName = `E2E surface agent ${stamp}`;
        const receiptTool = `e2e_surface_tool_${stamp}`;

        const post = async (path: string, data: unknown) => {
            const res = await page.request.post(`/api/t/${tenantSlug}${path}`, {
                headers: { 'Content-Type': 'application/json' },
                data: data as Record<string, unknown>,
            });
            expect(
                res.ok(),
                `POST ${path} failed ${res.status()}: ${(await res.text()).slice(0, 400)}`,
            ).toBe(true);
            return res;
        };

        // ─── SEED ───────────────────────────────────────────────────────────
        //
        // Through the real APIs, never a direct DB write: a fixture inserted
        // behind the usecase would prove the page can render a shape this test
        // invented, which is the rendered tests' limitation reproduced one layer
        // down.

        const agentId = await test.step('register an agent', async () => {
            const res = await post('/admin/agents', {
                name: agentName,
                description: 'Exercises every agentic surface with real rows.',
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId,
                classification: {},
            });
            const body = (await res.json()) as { id?: string; agent?: { id?: string } };
            const id = body.id ?? body.agent?.id;
            expect(id, `no agent id in: ${JSON.stringify(body)}`).toBeTruthy();
            return id as string;
        });

        await test.step('start a workflow run', async () => {
            // `diagnostic` is the registry's own smallest definition
            // (`lib/agentic/workflow-registry.ts`), chosen so this seeds a RUN
            // without asserting anything about what a particular workflow does.
            await post('/agent-runs', { workflowKey: 'diagnostic', input: {} });
        });

        await test.step('ingest an action receipt', async () => {
            await post(
                '/agent-receipts',
                signedReceipt({
                    tool: receiptTool,
                    verdict: 'allow',
                    policy: 'e2e-surface-policy',
                    timestamp: new Date().toISOString(),
                }),
            );
        });

        // ─── WALK ───────────────────────────────────────────────────────────

        await test.step('the register lists the agent it was given', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents`, { waitUntil: 'domcontentloaded' });
            await expect(main.getByText(agentName)).toBeVisible({ timeout: 30_000 });
            await expect(main.getByText(en.agents.register.emptyTitle)).toHaveCount(0);
        });

        await test.step('the runs page lists the run, and is not its empty state', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/runs`, { waitUntil: 'domcontentloaded' });
            // The empty state is the discriminator that matters here: this page
            // has never rendered a non-empty list anywhere in the suite, so a
            // mapping that dropped every row would have looked identical to a
            // tenant with no runs.
            await expect(main.getByText(en.agents.runs.emptyTitle)).toHaveCount(0, {
                timeout: 30_000,
            });
            await expect(main.getByText(/diagnostic/i).first()).toBeVisible({ timeout: 30_000 });
        });

        await test.step('the receipt log shows the tool the receipt named', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/receipts`, {
                waitUntil: 'domcontentloaded',
            });
            // The tool name is carried on the receipt's `action_record` and
            // extracted server-side by `extractReceiptFields`, so finding it on
            // the page walks the whole chain: POST -> extract -> persist ->
            // list -> render.
            await expect(main.getByText(receiptTool).first()).toBeVisible({ timeout: 30_000 });
        });

        await test.step('the reports page counts the register it can see', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/reports`, {
                waitUntil: 'domcontentloaded',
            });
            // `emptyTitle` here means "no agents are registered" — with one
            // registered, its presence would mean the pack read a different
            // tenant or none at all.
            await expect(main.getByText(en.agents.reports.emptyTitle)).toHaveCount(0, {
                timeout: 30_000,
            });
        });

        await test.step('review quality renders for a register with one agent', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/review-quality`, {
                waitUntil: 'domcontentloaded',
            });
            await expect(main).toBeVisible({ timeout: 30_000 });
        });

        await test.step('the agent detail page opens on the seeded agent', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/${agentId}`, {
                waitUntil: 'domcontentloaded',
            });
            await expect(
                main.getByRole('heading', { level: 1 }).filter({ hasText: agentName }),
            ).toBeVisible({ timeout: 30_000 });
        });

        // ─── WHERE EMPTY IS CORRECT ─────────────────────────────────────────

        await test.step('the proposal queue is empty, and that is the right answer', async () => {
            // No operator endpoint creates a proposal — `agent-proposals` is
            // GET-only because proposals arrive from an agent over MCP. So this
            // asserts the state a tenant no agent has called into SHOULD be in,
            // which is the claim nobody could make about production while
            // "correctly empty" and "silently broken" looked the same.
            await safeGoto(page, `/t/${tenantSlug}/agents/proposals`, {
                waitUntil: 'domcontentloaded',
            });
            await expect(main.getByText(en.agents.proposals.emptyTitle)).toBeVisible({
                timeout: 30_000,
            });
        });

        await test.step('quarantine is empty, and says what it is for', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/quarantine`, {
                waitUntil: 'domcontentloaded',
            });
            await expect(main.getByText(en.agents.quarantine.terminalNotice)).toBeVisible({
                timeout: 30_000,
            });
        });
    });
});
