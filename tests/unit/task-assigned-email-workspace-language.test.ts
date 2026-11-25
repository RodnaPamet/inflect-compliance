/**
 * THE TASK-ASSIGNED EMAIL IS WRITTEN IN THE WORKSPACE'S DEFAULT LANGUAGE
 * (owner decision 2026-11-25).
 *
 *   1. A `bg` workspace gets the Bulgarian subject, body and HTML — button and
 *      sign-off included — with the task key, title and names as written.
 *   2. An `en` workspace gets exactly the email every workspace got before:
 *      subject, text and HTML byte for byte.
 *   3. A stored value the product does not support, or no row at all, reads
 *      as English.
 *   4. The language is read where the email is enqueued (the outbox row is
 *      sent as rendered), once, and only for this email: the bulk digest and
 *      every other email stay English and read nothing.
 */
jest.mock('@/env', () => ({ env: { APP_URL: 'https://app.example.test/' } }));
jest.mock('@/app-layer/notifications/settings', () => ({
    ...jest.requireActual('@/app-layer/notifications/settings'),
    isNotificationsEnabled: jest.fn().mockResolvedValue(true),
}));

import { withSkipDuplicates } from '../helpers/outbox-double';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';
import type { TaskAssignedPayload } from '@/app-layer/notifications/templates';

const PAYLOAD: TaskAssignedPayload = {
    taskTitle: 'Review the <vendor> DPA',
    taskKey: 'TSK-42',
    taskType: 'AUDIT_FINDING',
    assigneeName: 'Алиса Петрова',
    assignerName: 'Bob & Co',
    tenantSlug: 'acme',
};

/** The email as `buildTaskAssignedEmail` wrote it before it took a language. */
function previousEnglish(p: TaskAssignedPayload) {
    const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const keyLabel = p.taskKey ? `[${p.taskKey}] ` : '';
    const byLine = p.assignerName ? ` by ${p.assignerName}` : '';
    const link = `https://app.example.test/t/${p.tenantSlug}/tasks`;
    return {
        subject: `Task assigned to you: ${keyLabel}${p.taskTitle}`,
        bodyText: [
            `Hi ${p.assigneeName},`,
            '',
            `You have been assigned a ${p.taskType.toLowerCase()} task${byLine}:`,
            '',
            `  ${keyLabel}${p.taskTitle}`,
            '',
            `View your tasks: ${link}`,
            '',
            '— Inflect Compliance',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Task assigned to you</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${esc(p.assigneeName)},</p>
  <p style="color: #444; line-height: 1.5;">You have been assigned a <strong>${esc(p.taskType.toLowerCase())}</strong> task${byLine ? ` by <strong>${esc(p.assignerName!)}</strong>` : ''}:</p>
  <div style="background: #f4f6fa; border-left: 4px solid #4f46e5; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <strong>${esc(keyLabel)}${esc(p.taskTitle)}</strong>
  </div>
  <a href="${esc(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">View Tasks</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
    };
}

/** A transaction double: the outbox insert, and the workspace's stored language. */
function workspace(defaultLocale: unknown | undefined) {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'out-1', ...data }));
    const findUnique = jest.fn(async () => (defaultLocale === undefined ? null : { defaultLocale }));
    const db = { notificationOutbox: withSkipDuplicates(create), tenant: { findUnique } } as never;
    return { db, create, findUnique };
}

async function sent(defaultLocale: unknown | undefined, payload: TaskAssignedPayload | Record<string, unknown> = PAYLOAD) {
    const w = workspace(defaultLocale);
    await enqueueEmail(w.db, {
        tenantId: 'tenant-1',
        type: 'TASK_ASSIGNED',
        toEmail: 'alisa@example.com',
        entityId: 'task-1',
        payload: payload as TaskAssignedPayload,
    });
    const row = w.create.mock.calls[0][0].data as { subject: string; bodyText: string; bodyHtml: string };
    return { row, findUnique: w.findUnique };
}

describe('the task-assigned email follows the workspace language', () => {
    it('a Bulgarian workspace gets the Bulgarian subject, body, button and sign-off', async () => {
        const { row, findUnique } = await sent('bg');

        expect(findUnique).toHaveBeenCalledTimes(1);
        expect(findUnique).toHaveBeenCalledWith({ where: { id: 'tenant-1' }, select: { defaultLocale: true } });

        expect(row.subject).toBe('Възложена ви е задача: [TSK-42] Review the <vendor> DPA');
        expect(row.bodyText).toBe([
            'Здравейте, Алиса Петрова,',
            '',
            'Bob & Co ви възложи задача от вид „одитна констатация“:',
            '',
            '  [TSK-42] Review the <vendor> DPA',
            '',
            'Вижте задачите си: https://app.example.test/t/acme/tasks',
            '',
            '— Inflect Compliance',
        ].join('\n'));

        expect(row.bodyHtml).toContain('>Възложена ви е задача</h2>');
        expect(row.bodyHtml).toContain('<p style="color: #444; line-height: 1.5;">Здравейте, Алиса Петрова,</p>');
        expect(row.bodyHtml).toContain(
            '<strong>Bob &amp; Co</strong> ви възложи задача от вид „<strong>одитна констатация</strong>“:',
        );
        expect(row.bodyHtml).toContain('<strong>[TSK-42] Review the &lt;vendor&gt; DPA</strong>');
        expect(row.bodyHtml).toContain('font-weight: 500;">Към задачите</a>');
        expect(row.bodyHtml).not.toContain('<vendor>');
        // Nothing of the English wording is left.
        for (const english of ['Task assigned', 'Hi ', 'You have been assigned', 'View your tasks', 'View Tasks', 'audit_finding']) {
            expect(`${row.subject}\n${row.bodyText}\n${row.bodyHtml}`).not.toContain(english);
        }
    });

    it('a Bulgarian workspace words an assignment with no assigner without a by-line', async () => {
        const { row } = await sent('bg', { ...PAYLOAD, assignerName: undefined, taskType: 'TASK' });

        expect(row.bodyText).toContain('\nВъзложена ви е задача от вид „задача“:\n');
        expect(row.bodyHtml).toContain('Възложена ви е задача от вид „<strong>задача</strong>“:');
    });

    it.each([
        ['with a key and an assigner', PAYLOAD],
        ['with no key and no assigner', { ...PAYLOAD, taskKey: null, assignerName: undefined }],
        ['for every task type', { ...PAYLOAD, taskType: 'CONTROL_GAP' }],
        ['for a type the catalogue does not word', { ...PAYLOAD, taskType: 'SOMETHING_NEW' }],
    ])('an English workspace gets exactly the previous email %s', async (_label, payload) => {
        const { row } = await sent('en', payload);

        expect(row).toEqual(expect.objectContaining(previousEnglish(payload as TaskAssignedPayload)));
    });

    it.each(['INCIDENT', 'IMPROVEMENT', 'TASK'])('an English workspace words a %s task as before', async (taskType) => {
        const { row } = await sent('en', { ...PAYLOAD, taskType });

        expect(row.bodyText).toBe(previousEnglish({ ...PAYLOAD, taskType }).bodyText);
    });

    it.each([
        ['an unsupported stored value', 'fr'],
        ['a non-string stored value', 42],
        ['no workspace row', undefined],
    ])('%s reads as English', async (_label, stored) => {
        const { row } = await sent(stored);

        expect(row).toEqual(expect.objectContaining(previousEnglish(PAYLOAD)));
    });

    it('the bulk digest stays English and reads no workspace language', async () => {
        const { row, findUnique } = await sent('bg', {
            tasks: [
                { taskTitle: 'A', taskKey: 'TSK-1', taskType: 'TASK' },
                { taskTitle: 'B', taskKey: null, taskType: 'TASK' },
            ],
            assigneeName: 'Алиса Петрова',
            tenantSlug: 'acme',
        });

        expect(row.subject).toBe('2 tasks assigned to you');
        expect(findUnique).not.toHaveBeenCalled();
    });
});
