/**
 * The public vendor questionnaire on a phone (#5896), and the key phone
 * journey of answering one (#5899): a respondent who submits with one required
 * answer missing lands on that question with its error in view, answers it,
 * submits every answer, and is told the questionnaire is submitted.
 *
 * The questionnaire is created in an isolated tenant through the product's
 * own API — a template with one section of required questions, published, and
 * sent to a vendor — and opened from the link the send returns, as a vendor
 * would open it. The page is held to the layout invariants the mobile project
 * holds every fixed route to: nothing clipped at the screen edge, no tap
 * target under 24 px.
 */
import { test, expect } from './fixtures';
import type { APIResponse } from '@playwright/test';
import { PHONE_CONFIGS, preferenceCookies } from '../../scripts/mobile-audit/configs';
import { measurePage } from '../../scripts/mobile-audit/measure';
import { MOBILE_E2E_CONFIGS } from './mobile-ratchet';
import { safeGoto } from './e2e-utils';
import { holdScreen } from './mobile-journey-support';

async function created<T = { id: string }>(res: APIResponse, what: string): Promise<T> {
    if (!res.ok()) throw new Error(`creating ${what} failed: ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
}

/** Twelve required yes/no questions: enough that the form runs well past one screen. */
const QUESTIONS = Array.from({ length: 12 }, (_, i) => `Do you review privileged access at least quarterly? (${i + 1})`);
/** The one left unanswered: in the middle, so landing on it means scrolling to it. */
const MISSING = 7;

for (const config of MOBILE_E2E_CONFIGS) {
    test(`vendor questionnaire: a missing answer is found, then the form submits — ${config}`, async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(4 * 60_000);
        const slug = isolatedTenant.tenantSlug;
        const api = (p: string) => `/api/t/${slug}${p}`;
        const json = { 'Content-Type': 'application/json' };

        const template = await created(await page.request.post(api('/vendor-assessment-templates'), {
            headers: json,
            data: { key: `mobile-q-${Date.now()}`, name: 'Supplier security questionnaire' },
        }), 'a template');
        const section = await created(await page.request.post(api(`/vendor-assessment-templates/${template.id}/sections`), {
            headers: json,
            data: { title: 'Access control' },
        }), 'a section');
        const questionIds: string[] = [];
        for (const prompt of QUESTIONS) {
            const q = await created(await page.request.post(
                api(`/vendor-assessment-templates/${template.id}/sections/${section.id}/questions`),
                { headers: json, data: { prompt, answerType: 'YES_NO', required: true } },
            ), 'a question');
            questionIds.push(q.id);
        }
        await created(await page.request.post(api(`/vendor-assessment-templates/${template.id}/publish`)), 'the published template');
        const vendor = await created(await page.request.post(api('/vendors'), {
            headers: json,
            data: { name: 'Northwind Logistics' },
        }), 'a vendor');
        const sent = await created<{ assessmentId: string; externalAccessToken: string }>(
            await page.request.post(api(`/vendors/${vendor.id}/assessments/send`), {
                headers: json,
                data: { templateVersionId: template.id, respondentEmail: 'security@northwind.example' },
            }),
            'the sent assessment',
        );

        const baseURL = testInfo.project.use.baseURL!;
        const phone = PHONE_CONFIGS[config];
        await page.setViewportSize({ width: phone.width, height: phone.height });
        await page.context().addCookies(preferenceCookies(phone, baseURL));
        await safeGoto(page, `/vendor-assessment/${sent.assessmentId}?t=${encodeURIComponent(sent.externalAccessToken)}`, {
            waitUntil: 'domcontentloaded',
        });
        const form = page.getByTestId('vendor-assessment-form');
        await expect(form).toBeVisible({ timeout: 60_000 });

        await test.step('the page fits the phone', async () => {
            const m = await measurePage(page);
            expect(m.clippedControls.count, JSON.stringify(m.clippedControls.samples)).toBe(0);
            expect(m.clippedText.count, JSON.stringify(m.clippedText.samples)).toBe(0);
            expect(m.tapUnder24.count, JSON.stringify(m.tapUnder24.samples)).toBe(0);
            await page.evaluate(() => window.scrollTo(0, 0));
        });

        const question = (i: number) => page.locator(`#question-${questionIds[i]}`);
        // The row is the tap target (the 20 px input ignores pointer events), so
        // a phone user taps the row, and so does this spec.
        const yesRow = (i: number) => question(i).locator('label:has(input[type="radio"])').first();
        const yes = (i: number) => question(i).getByRole('radio').first();

        await test.step('every answer but one, and the submit bar is on screen all along', async () => {
            for (let i = 0; i < QUESTIONS.length; i++) {
                if (i === MISSING) continue;
                await yesRow(i).click();
                await expect(yes(i)).toBeChecked();
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            await expect(page.getByTestId('vendor-assessment-submit-btn')).toBeInViewport();
            await expect(page.getByTestId('vendor-assessment-progress')).toContainText(`${QUESTIONS.length - 1}`);
        });

        await test.step('submitting lands on the unanswered question, with its error in view', async () => {
            await page.getByTestId('vendor-assessment-submit-btn').click();
            const error = page.getByTestId(`q-${questionIds[MISSING]}-error`);
            await expect(error).toBeVisible();
            await expect(error).toBeInViewport();
            await expect(question(MISSING)).toBeInViewport();
            // Focus is on the question, so the next tap or key acts there.
            expect(await question(MISSING).evaluate((el) => el.contains(document.activeElement))).toBe(true);
            // Nothing else is marked.
            await expect(page.locator('[data-testid$="-error"]')).toHaveCount(1);
        });

        await test.step('answering it clears the error, and the form submits every answer', async () => {
            await yesRow(MISSING).click();
            await expect(yes(MISSING)).toBeChecked();
            await expect(page.getByTestId(`q-${questionIds[MISSING]}-error`)).toHaveCount(0);
            const isSubmit = (url: string) => url.includes(`/api/vendor-assessment/${sent.assessmentId}/submit`);
            const submitted = page.waitForRequest((req) => req.method() === 'POST' && isSubmit(req.url()));
            const answered = page.waitForResponse((res) => res.request().method() === 'POST' && isSubmit(res.url()));
            await page.getByTestId('vendor-assessment-submit-btn').click();
            // What leaves the phone is the whole questionnaire, the answer it
            // was missing included.
            const body = (await submitted).postDataJSON() as { answers: Array<{ questionId: string }> };
            expect(body.answers.map((a) => a.questionId).sort()).toEqual([...questionIds].sort());
            // And the server takes it (#5910: every submit used to roll back
            // on the audit row's foreign key and answer "Submission failed").
            const res = await answered;
            expect(res.status(), await res.text().catch(() => '')).toBe(200);
        });

        await test.step('the vendor is told it is submitted, in Bulgarian, on a page that fits', async () => {
            await expect(page.getByTestId('vendor-assessment-submitted')).toBeVisible({ timeout: 30_000 });
            await expect(page.getByTestId('vendor-assessment-error')).toHaveCount(0);
            await holdScreen(page, 'questionnaire submitted', ['Supplier security questionnaire', 'Northwind Logistics', 'Access control']);
        });
    });
}
