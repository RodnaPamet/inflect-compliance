/**
 * The key phone journeys (Phase 5 of docs/mobile-roadmap.md, #5899): what a
 * person must be able to do from a phone, end to end, in Bulgarian.
 *
 *   - sign in with MFA;
 *   - triage a task: assign it, comment, close it;
 *   - approve an agent's proposal;
 *   - stop an agent;
 *   - decide an access review;
 *   - open a shared audit link;
 *
 * and, in `mobile-vendor-questionnaire.spec.ts`, answer a vendor
 * questionnaire through to a successful submit.
 *
 * Each journey runs in its own isolated tenant (`./fixtures`) and creates what
 * it starts from through the product's own API, never the database. Each
 * screen it passes through is held to the phone invariants
 * (`holdScreen`), and the action it exists to take is held to the size a
 * thumb needs (`expectThumbSized`). Controls are found by id, role or test id,
 * never by an English label: the page is in Bulgarian.
 *
 * The journeys share the two E2E phone configurations between them rather
 * than each running in both, which would double the mobile project's time
 * for the same coverage of the two widths and the two themes.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import bg from '../../messages/bg.json';
import { installFramework, safeGoto } from './e2e-utils';
import { addMember, created, expectThumbSized, holdScreen, onPhone, tenantApi, totpAt, totpStepNow } from './mobile-journey-support';

/** Sign in through the credentials form, as a person on the phone would. */
async function signInOnPhone(page: Page, email: string, password: string): Promise<void> {
    await safeGoto(page, '/login', { waitUntil: 'domcontentloaded' });
    const form = page.locator('#credentials-form');
    const emailInput = form.locator('input[type="email"][name="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForFunction(() => {
        const f = document.querySelector('#credentials-form');
        return !!f && Object.keys(f).some((k) => k.startsWith('__react'));
    }, undefined, { timeout: 30_000 });
    await emailInput.fill(email);
    await form.locator('input[type="password"]').fill(password);
    await form.locator('button[type="submit"]').click();
}

test.describe('key phone journeys', () => {
    test('sign in with MFA — 360-light-bg', async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(4 * 60_000);
        const { tenantSlug, ownerEmail, ownerPassword } = isolatedTenant;
        const api = tenantApi(page, tenantSlug);

        const secret = await test.step('the owner has enrolled an authenticator, and the workspace requires MFA', async () => {
            const start = await created<{ secret: string }>(await api('/security/mfa/enroll/start'), 'an MFA enrolment');
            await created(await api('/security/mfa/enroll/verify', { code: totpAt(start.secret, totpStepNow()) }), 'the verified enrolment');
            const policy = await page.request.put(`/api/t/${tenantSlug}/security/mfa/policy`, {
                headers: { 'Content-Type': 'application/json' },
                data: { mfaPolicy: 'REQUIRED' },
            });
            expect(policy.ok(), `setting the MFA policy: ${policy.status()} ${await policy.text()}`).toBe(true);
            return start.secret;
        });

        await test.step('signed out, on a phone, the password leads to the code', async () => {
            await page.context().clearCookies();
            await onPhone(page, '360-light-bg', testInfo);
            await signInOnPhone(page, ownerEmail, ownerPassword);
            await page.waitForURL(new RegExp(`/t/${tenantSlug}/auth/mfa`), { timeout: 60_000 });
            await expect(page.locator('#mfa-challenge-input')).toBeVisible({ timeout: 30_000 });
            await holdScreen(page, 'MFA challenge');
            // The field asks a phone for its number pad and its one-time-code autofill.
            await expect(page.locator('#mfa-challenge-input')).toHaveAttribute('inputmode', 'numeric');
            await expect(page.locator('#mfa-challenge-input')).toHaveAttribute('autocomplete', 'one-time-code');
        });

        await test.step('the code from the authenticator opens the workspace', async () => {
            // The next time step: a code is accepted once, and only for a step
            // later than the one the enrolment used.
            await page.locator('#mfa-challenge-input').fill(totpAt(secret, totpStepNow() + 1));
            const submit = page.locator('#mfa-challenge-submit');
            await expectThumbSized(submit, 'MFA challenge');
            await submit.click();
            await page.waitForURL(new RegExp(`/t/${tenantSlug}/dashboard`), { timeout: 60_000 });
            await expect(page.getByRole('main')).toBeVisible({ timeout: 30_000 });
            // And the session holds: the next page is not the challenge again.
            await safeGoto(page, `/t/${tenantSlug}/tasks`, { waitUntil: 'domcontentloaded' });
            await expect(page).not.toHaveURL(/\/auth\/mfa/);
        });
    });

    test('triage a task: assign, comment, close — 390-dark-bg', async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(4 * 60_000);
        const { tenantSlug, ownerName } = isolatedTenant;
        const title = 'Rotate the backup encryption key';
        const comment = 'Rotated, and the old key is destroyed.';
        const task = await created(await tenantApi(page, tenantSlug)('/tasks', {
            title,
            type: 'TASK',
            severity: 'HIGH',
            description: 'The backup key has not been rotated this year.',
        }), 'a task');

        await onPhone(page, '390-dark-bg', testInfo);
        await safeGoto(page, `/t/${tenantSlug}/tasks/${task.id}`, { waitUntil: 'domcontentloaded' });
        const main = page.getByRole('main');
        await expect(main.locator('#task-title')).toContainText(title, { timeout: 60_000 });
        await holdScreen(page, 'task detail', [title, ownerName]);

        await test.step('assign it', async () => {
            await main.locator('#task-assignee-input').click();
            await page.getByRole('option').filter({ hasText: ownerName }).first().click();
            const assign = main.locator('#assign-task-btn');
            await expectThumbSized(assign, 'assign');
            await assign.click();
            await expect(main.locator('#task-assignee')).toContainText(ownerName, { timeout: 30_000 });
        });

        await test.step('comment on it', async () => {
            await main.locator('#tab-comments').click();
            await main.locator('#comment-body').fill(comment);
            const submit = main.locator('#submit-comment-btn');
            await expectThumbSized(submit, 'comment');
            await submit.click();
            await expect(main.locator('#comments-list')).toContainText(comment, { timeout: 30_000 });
            await holdScreen(page, 'task comments', [title, ownerName, comment]);
        });

        await test.step('close it, with a resolution', async () => {
            await main.locator('#task-status-select').click();
            await page.getByRole('option', { name: bg.tasks.statusLabels.CLOSED }).click();
            const resolution = page.locator('#task-resolution-input');
            await expect(resolution).toBeVisible({ timeout: 15_000 });
            await resolution.fill('Key rotated on schedule.');
            await holdScreen(page, 'close task dialog', [title, ownerName]);
            const confirm = page.locator('#confirm-task-status-btn');
            await expectThumbSized(confirm, 'close task');
            await confirm.click();
            await expect(main.locator('#task-status')).toContainText(bg.tasks.statusLabels.CLOSED, { timeout: 30_000 });
        });
    });

    test('stop an agent — 360-light-bg', async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(4 * 60_000);
        const { tenantSlug, ownerUserId, ownerName } = isolatedTenant;
        const agentName = 'Vendor intake triage agent';
        const agent = await registerActiveAgent(page, tenantSlug, ownerUserId, agentName, ['list_risks']);
        // A diagnostic run, whose summary the product writes in English and
        // the runs page must show in the reader's language (#5883).
        await created(await tenantApi(page, tenantSlug)('/agent-runs', { workflowKey: 'diagnostic', input: {} }), 'a diagnostic run');

        await onPhone(page, '360-light-bg', testInfo);
        const main = page.getByRole('main');

        await test.step('the runs read in Bulgarian, the summary the product wrote included', async () => {
            await safeGoto(page, `/t/${tenantSlug}/agents/runs`, { waitUntil: 'domcontentloaded' });
            await expect(main.getByText(bg.agentWorkflows.diagnostic.name).first()).toBeVisible({ timeout: 60_000 });
            await holdScreen(page, 'agent runs', [agentName, ownerName]);
        });

        await safeGoto(page, `/t/${tenantSlug}/agents/${agent}`, { waitUntil: 'domcontentloaded' });
        const stop = main.getByTestId('agent-kill-engage-open');
        await expect(stop).toBeVisible({ timeout: 60_000 });
        await holdScreen(page, 'agent detail', [agentName, ownerName]);

        await test.step('the stop is in reach, and asks why', async () => {
            await expectThumbSized(stop, 'stop agent');
            await stop.click();
            const reason = page.locator('#agent-kill-reason');
            await expect(reason).toBeVisible({ timeout: 15_000 });
            await reason.fill('It proposed changes outside its remit; stopped while we review.');
            await holdScreen(page, 'stop agent dialog', [agentName, ownerName]);
        });

        await test.step('stopped: the banner says so, and the way back is offered', async () => {
            const confirm = page.getByTestId('agent-kill-engage-confirm');
            await expectThumbSized(confirm, 'confirm stop');
            await confirm.click();
            await expect(main.getByText(bg.admin.agentDetail.kill.bannerAgentTitle)).toBeVisible({ timeout: 30_000 });
            await expect(main.locator('#agent-kill-lift-btn')).toBeVisible();
            await expect(main.getByTestId('agent-kill-engage-open')).toHaveCount(0);
        });
    });
});

test.describe('key phone journeys: an agent proposal', () => {
    test('approve an agent proposal — 390-dark-bg', async ({ authedPage: page, isolatedTenant, browser }, testInfo) => {
        test.setTimeout(5 * 60_000);
        const { tenantSlug, ownerName } = isolatedTenant;
        const agentName = 'Risk intake agent';
        const riskTitle = 'Supplier holds production data without a DPA';

        // The agent's accountable owner is somebody else: its owner may not
        // approve what it proposes (four eyes), so the reviewer on the phone
        // is the workspace owner.
        const agentOwner = await addMember(page, browser, tenantSlug, 'OWNER', testInfo);

        const proposalId = await test.step('an agent proposes a risk over MCP, with its own key', async () => {
            const agentId = await registerActiveAgent(page, tenantSlug, agentOwner.ownerUserId, agentName, ['propose_risks'], 'WRITE_TENANT_DATA');
            const key = await created<{ plaintext: string }>(await tenantApi(page, tenantSlug)('/admin/api-keys', {
                name: `${agentName} key`,
                scopes: ['mcp:read', 'mcp:propose', 'risks:read'],
                agentId,
            }), 'the agent key');
            const res = await page.request.post('/api/mcp', {
                headers: {
                    Authorization: `Bearer ${key.plaintext}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                },
                data: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'propose_risks',
                        arguments: {
                            items: [{ title: riskTitle, description: 'Found while reading the vendor register.', likelihood: 3, impact: 4 }],
                            rationale: 'The vendor register lists the supplier with production access and no signed DPA.',
                        },
                    },
                },
                failOnStatusCode: false,
            });
            const text = await res.text();
            expect(res.ok(), `MCP tools/call: ${res.status()} ${text.slice(0, 400)}`).toBe(true);
            const id = /"proposalIds?"\s*:\s*\[?\s*\\?"([a-z0-9]+)/i.exec(text)?.[1] ?? /\b(c[a-z0-9]{20,})\b/.exec(text)?.[1];
            expect(id, `no proposal id in ${text.slice(0, 400)}`).toBeTruthy();
            return id!;
        });

        await onPhone(page, '390-dark-bg', testInfo);
        await safeGoto(page, `/t/${tenantSlug}/agents/proposals`, { waitUntil: 'domcontentloaded' });
        const main = page.getByRole('main');
        const card = main.locator(`#proposal-${proposalId}`);
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(card).toContainText(riskTitle);
        await holdScreen(page, 'proposal queue', [agentName, ownerName, agentOwner.ownerName, riskTitle]);

        await test.step('approve it from the queue: the first of the two signatures it needs', async () => {
            const approve = card.getByTestId(`proposal-approve-${proposalId}`);
            await expectThumbSized(approve, 'approve proposal');
            await approve.click();
            // An agent with no policy card is on the strictest rung: two
            // people sign. The phone's part is the first signature, recorded
            // and shown, with nothing written until the second.
            await expect(card.getByTestId(`proposal-signed-by-you-${proposalId}`)).toBeVisible({ timeout: 30_000 });
            await expect(main.getByTestId('proposal-action-error')).toHaveCount(0);
            await holdScreen(page, 'proposal queue, signed', [agentName, ownerName, agentOwner.ownerName, riskTitle]);
        });
    });
});

test.describe('key phone journeys: an access review', () => {
    test('decide an access review — 360-light-bg', async ({ authedPage: page, isolatedTenant, browser }, testInfo) => {
        test.setTimeout(5 * 60_000);
        const { tenantSlug, ownerUserId, ownerName } = isolatedTenant;
        // The reviewer may not decide their own access, so the campaign needs
        // somebody else in it.
        const member = await addMember(page, browser, tenantSlug, 'EDITOR', testInfo);
        const name = 'Q4 user access review';
        const { accessReviewId: reviewId } = await created<{ accessReviewId: string }>(
            await tenantApi(page, tenantSlug)('/access-reviews', { name, reviewerUserId: ownerUserId }),
            'an access review',
        );
        const names = [name, ownerName, member.ownerName, member.ownerEmail, isolatedTenant.ownerEmail];

        await onPhone(page, '360-light-bg', testInfo);
        await safeGoto(page, `/t/${tenantSlug}/access-reviews/${reviewId}`, { waitUntil: 'domcontentloaded' });
        const main = page.getByRole('main');
        await expect(main.getByTestId('access-review-detail-title')).toContainText(name, { timeout: 60_000 });
        // Exactly one row can be decided: the member's. The reviewer's own row says why it cannot.
        const decide = main.locator('[data-testid^="decision-select-"]');
        await expect(decide).toHaveCount(1, { timeout: 30_000 });
        await expect(main.locator('[data-testid^="own-row-cannot-decide-"]')).toHaveCount(1);
        await holdScreen(page, 'access review', names);

        await test.step('confirm the member keeps their access, with a reason', async () => {
            await decide.scrollIntoViewIfNeeded();
            await decide.selectOption('CONFIRM');
            const notes = page.getByTestId('decision-modal-notes');
            await expect(notes).toBeVisible({ timeout: 15_000 });
            await notes.fill('Still on the platform team; access matches the role.');
            await holdScreen(page, 'decision dialog', names);
            const submit = page.getByTestId('decision-modal-submit');
            await expectThumbSized(submit, 'record the decision');
            await submit.click();
            await expect(notes).toHaveCount(0, { timeout: 30_000 });
        });

        await test.step('the decision is on the row, and nothing is left to decide', async () => {
            await expect(main.locator('[data-testid^="undo-decision-"]')).toHaveCount(1, { timeout: 30_000 });
            await expect(main.getByText(bg.accessReviews.verdictLabels.CONFIRM).first()).toBeVisible();
            await expect(main.locator('[data-testid^="decision-select-"]')).toHaveCount(0);
        });
    });
});

test.describe('key phone journeys: a shared audit link', () => {
    test('open a shared audit link — 390-dark-bg', async ({ authedPage: page, isolatedTenant, browser }, testInfo) => {
        test.setTimeout(5 * 60_000);
        const { tenantSlug } = isolatedTenant;
        const api = tenantApi(page, tenantSlug);
        const packName = 'ISO 27001 surveillance audit — evidence for the auditor';
        const controlName = 'Access review of privileged production accounts';

        const { token, controlId } = await test.step('a frozen pack, shared with an auditor', async () => {
            await installFramework(page, tenantSlug, 'ISO27001', 'ISO27001_2022_BASE');
            const control = await created(await api('/controls', {
                name: controlName, code: 'MOB-AUD-1', status: 'IMPLEMENTED', isCustom: true,
            }), 'a control');
            const cycle = await created(await api('/audits/cycles', {
                frameworkKey: 'ISO27001', frameworkVersion: '2022', name: 'Surveillance audit 2026',
            }), 'an audit cycle');
            const pack = await created(await api('/audits/packs', { auditCycleId: cycle.id, name: packName }), 'an audit pack');
            await created(await api(`/audits/packs/${pack.id}?action=items`, {
                items: [{ entityType: 'CONTROL', entityId: control.id }],
            }), 'the pack item');
            await created(await api(`/audits/packs/${pack.id}?action=freeze`, {}), 'the frozen pack');
            const share = await created<{ token: string }>(await api(`/audits/packs/${pack.id}?action=share`, {}), 'the share link');
            return { token: share.token, controlId: control.id };
        });

        // The auditor is not signed in: a fresh browser on a phone, with only the link.
        const baseURL = testInfo.project.use.baseURL!;
        const auditor = await browser.newContext({ ...testInfo.project.use, baseURL });
        try {
            const phone = await auditor.newPage();
            await onPhone(phone, '390-dark-bg', testInfo);
            await safeGoto(phone, `/audit/shared/${token}`, { waitUntil: 'domcontentloaded' });
            await expect(phone.locator('#shared-pack-name')).toContainText(packName, { timeout: 60_000 });
            await expect(phone.locator('#shared-pack-summary')).toBeVisible();
            // An item is listed by the name its frozen snapshot carries — a
            // control by its code — never by its database id.
            await expect(phone.getByText('MOB-AUD-1').first()).toBeVisible();
            await expect(phone.getByText(controlId)).toHaveCount(0);
            await holdScreen(phone, 'shared audit pack', [packName, controlName, 'Surveillance audit 2026', 'MOB-AUD-1']);

            await test.step('the auditor asks a question back through the link', async () => {
                const channel = phone.locator('#return-channel');
                await channel.scrollIntoViewIfNeeded();
                const question = 'Please add last quarter’s export of privileged accounts.';
                await channel.locator('textarea').first().fill(question);
                const submit = phone.locator('#return-channel-submit');
                await expectThumbSized(submit, 'send to the auditee');
                await submit.click();
                await expect(channel).toContainText(question, { timeout: 30_000 });
                await expect(phone.locator('#return-channel-error')).toHaveCount(0);
            });
        } finally {
            await auditor.close();
        }
    });
});

/** Register an agent through the API, grant it `tools`, score it, and activate it: the operator journey's order. */
async function registerActiveAgent(
    page: Page,
    tenantSlug: string,
    ownerUserId: string,
    name: string,
    tools: readonly string[],
    dataAccessScope: 'READ_TENANT_DATA' | 'WRITE_TENANT_DATA' = 'READ_TENANT_DATA',
): Promise<string> {
    const api = tenantApi(page, tenantSlug);
    const body = await created<{ id?: string; agent?: { id?: string } }>(await api('/admin/agents', {
        name,
        description: 'Reads the risk register and drafts what a person decides.',
        autonomyLevel: 2,
        dataAccessScope,
        reversibility: 'REVERSIBLE',
        provenance: 'FIRST_PARTY',
        ownerUserId,
        classification: {},
    }), 'an agent');
    const id = body.id ?? body.agent?.id;
    if (!id) throw new Error(`no agent id in ${JSON.stringify(body)}`);
    for (const toolName of tools) await created(await api(`/admin/agents/${id}/tools`, { toolName }), `the ${toolName} grant`);
    await created(await api(`/admin/agents/${id}/risk-assessment/complete`), 'the risk assessment');
    await created(await api(`/admin/agents/${id}/status`, { status: 'ACTIVE' }), 'the activation');
    return id;
}

