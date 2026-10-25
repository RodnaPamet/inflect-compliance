/**
 * An owner changes the workspace's agent engine on AI features, and the change
 * is on the audit trail (Step 0c, #4139).
 *
 * MUTATING, so it runs in its own isolated tenant: the change must never reach
 * the shared seeded tenant or another test.
 *
 * The deployment's Flue switch is on in the E2E environment
 * (`AGENT_DRIVER_FLUE=1` in `.env.e2e.example`). With it off, the choice is
 * disabled by design, and the first assertion below says so rather than
 * timing out on a radio that cannot be pressed.
 */
import { test, expect } from './fixtures';

test('an owner switches the agent engine, and the audit log records it', async ({ authedPage, isolatedTenant }) => {
    const page = authedPage;
    const slug = isolatedTenant.tenantSlug;

    await test.step('choose the Flue engine and confirm', async () => {
        await page.goto(`/t/${slug}/admin/ai-features`);
        const main = page.getByRole('main');
        const section = main.locator('#agent-engines');
        await expect(section).toBeVisible({ timeout: 20_000 });
        await expect(section).toHaveAttribute('data-control', 'editable');

        const flue = section.getByRole('radio', { name: /^Flue engine/ });
        await expect(flue).not.toBeChecked();
        await flue.click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Switch this workspace to the Flue engine?');
        await dialog.getByRole('button', { name: 'Switch engine' }).click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });

        await expect(section.getByRole('radio', { name: /^Flue engine/ })).toBeChecked();
        await expect(section.getByRole('radio', { name: /^Built-in engine/ })).not.toBeChecked();
    });

    await test.step('the change is on the audit log', async () => {
        await page.goto(`/t/${slug}/admin/audit-log`);
        const table = page.getByRole('main').locator('#audit-log-table');
        await expect(table).toBeVisible({ timeout: 20_000 });
        await expect(table.getByText('AGENT_DRIVER_MODE_CHANGED')).toBeVisible({ timeout: 15_000 });
        await expect(table).toContainText('Agentic driver: STATIC → FLUE');
    });
});
