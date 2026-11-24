/**
 * The stock notification sentences (`src/lib/notifications/stock-notifications.ts`):
 * what the emitters store is what the reader parses back, and each English
 * template IS the `en` catalogue message for its kind — the template the
 * mobile audit's leak detector needs to tell the stored English from tenant
 * data (#5929).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

jest.mock('@/lib/notifications/notification-bus', () => ({ publishNotificationEvent: jest.fn() }));

import {
    ATTESTATION,
    INCIDENT_REPORT,
    NIS2_GROUP,
    SOMEBODY,
    STOCK_NOTIFICATIONS,
    WATCH_DETAIL,
    WATCH_DETAIL_SEPARATOR,
    localizedStockNotification,
    nis2QuestionCount,
    parseStockTemplate,
    recordLabel,
    stockNotificationText,
    stockNotificationTitle,
    watchDueDetail,
    watchStatusDetail,
    type StockNotificationKind,
} from '@/lib/notifications/stock-notifications';
import { createAssignmentNotification, type AssignmentNotificationKind } from '@/app-layer/notifications/assignment';
import { createTaskDueNotification, TASK_DUE_WINDOWS } from '@/app-layer/notifications/task-due';
import { createWatcherNotifications } from '@/app-layer/notifications/watcher';

const root = path.resolve(__dirname, '..', '..');
const catalogue = (locale: 'en' | 'bg') =>
    JSON.parse(readFileSync(path.join(root, 'messages', `${locale}.json`), 'utf8')) as {
        notificationTitles: { stock: Record<string, string> };
        notificationBodies: { stock: Record<string, unknown> };
    };
const EN = catalogue('en');
const BG = catalogue('bg');

/** A translator rooted at one namespace of a catalogue, `{name}` substitution only. */
function translator(ns: Record<string, unknown>) {
    return (key: string, values: Record<string, string | number> = {}): string => {
        const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], ns);
        if (typeof v !== 'string') throw new Error(`missing message ${key}`);
        return v.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
    };
}
const bgTitles = translator(BG.notificationTitles);
const bgBodies = translator(BG.notificationBodies);
const enBodies = translator(EN.notificationBodies);
const inBulgarian = (row: { type: string; title: string; message: string }) =>
    localizedStockNotification(row, bgTitles, bgBodies);

const KINDS = Object.keys(STOCK_NOTIFICATIONS) as StockNotificationKind[];
const CYRILLIC = /[Ѐ-ӿ]/;

/** A fake Prisma client that keeps what was inserted. */
function captureDb() {
    const rows: Array<{ type: string; title: string; message: string }> = [];
    const db = {
        notification: {
            createMany: jest.fn(async ({ data }: { data: typeof rows }) => {
                rows.push(...data);
                return { count: 0 }; // "duplicate": skips the read-back and the bus.
            }),
            findMany: jest.fn(async () => []),
        },
    };
    return { db, rows };
}

describe('the English templates are the en catalogue', () => {
    it.each(KINDS)('%s: its stored title and body are its en messages', (kind) => {
        expect(EN.notificationTitles.stock[kind]).toBe(STOCK_NOTIFICATIONS[kind].title);
        expect(EN.notificationBodies.stock[kind]).toBe(STOCK_NOTIFICATIONS[kind].body);
    });

    it('every phrase the emitters write into a slot has an en message with the same words', () => {
        for (const [code, words] of Object.entries(NIS2_GROUP)) expect(enBodies(`stock.group.${code}`)).toBe(words);
        for (const [code, words] of Object.entries(WATCH_DETAIL)) expect(enBodies(`stock.detail.${code}`)).toBe(words);
        for (const [code, words] of Object.entries(INCIDENT_REPORT)) expect(enBodies(`stock.report.${code}`)).toBe(words);
        expect(enBodies('stock.count.one', { n: 1 })).toBe(nis2QuestionCount(1));
        expect(enBodies('stock.count.other', { n: 12 })).toBe(nis2QuestionCount(12));
        expect(enBodies('stock.detail.status', { from: 'OPEN', to: 'DONE' })).toBe(watchStatusDetail('OPEN', 'DONE'));
        expect(enBodies('stock.somebody')).toBe(SOMEBODY);
        expect(enBodies('stock.attestation')).toBe(ATTESTATION);
    });

    it.each(KINDS)('%s: Bulgarian words it differently, in Cyrillic', (kind) => {
        const title = BG.notificationTitles.stock[kind];
        expect(title).toMatch(CYRILLIC);
        expect(title).not.toBe(STOCK_NOTIFICATIONS[kind].title);
        // A watched task's body is its label and its change, both slots.
        if (kind !== 'TASK_WATCH_UPDATE') expect(BG.notificationBodies.stock[kind]).toMatch(CYRILLIC);
    });
});

describe('what the emitters store reads back in Bulgarian', () => {
    const target = {
        tenantId: 'ten1',
        assigneeUserId: 'u1',
        entityId: 'e1',
        entityLabel: 'Rotate keys',
        entityKey: 'T-12',
        tenantSlug: 'acme',
    };
    const assignmentKinds: AssignmentNotificationKind[] = [
        'TASK_ASSIGNED',
        'CONTROL_ASSIGNED',
        'RISK_ASSIGNED',
        'ASSET_ASSIGNED',
        'TASK_REVIEW_REQUESTED',
    ];

    it.each(assignmentKinds)('%s', async (kind) => {
        const { db, rows } = captureDb();
        await createAssignmentNotification(db as never, kind, target);
        expect(inBulgarian(rows[0])).toEqual({
            title: BG.notificationTitles.stock[kind],
            message: bgBodies(`stock.${kind}`, { label: 'T-12 "Rotate keys"' }),
        });
    });

    it.each(Object.keys(TASK_DUE_WINDOWS) as Array<keyof typeof TASK_DUE_WINDOWS>)('TASK_DUE, %s', async (window) => {
        const now = new Date('2026-11-24T08:00:00.000Z');
        const dueAt = new Date(now.getTime() + TASK_DUE_WINDOWS[window].days * 86_400_000);
        const { db, rows } = captureDb();
        await createTaskDueNotification(
            db as never,
            { id: 't1', tenantId: 'ten1', tenantSlug: 'acme', key: null, title: 'Rotate keys', assigneeUserId: 'u1', dueAt },
            now,
        );
        const kind = TASK_DUE_WINDOWS[window].kind;
        expect(inBulgarian(rows[0])).toEqual({
            title: BG.notificationTitles.stock[kind],
            message: bgBodies(`stock.${kind}`, { label: '"Rotate keys"' }),
        });
    });

    it.each([
        [WATCH_DETAIL.commented, 'stock.detail.commented', {}],
        [WATCH_DETAIL.unassigned, 'stock.detail.unassigned', {}],
        [watchStatusDetail('OPEN', 'IN_REVIEW'), 'stock.detail.status', { from: 'Отворена', to: 'В преглед' }],
        [watchDueDetail(null, '2026-12-01'), 'stock.detail.due', { from: 'без срок', to: '2026-12-01' }],
    ] as const)('TASK_WATCH_UPDATE, "%s"', async (detail, key, values) => {
        const { db, rows } = captureDb();
        await createWatcherNotifications(db as never, ['u1'], {
            tenantId: 'ten1',
            tenantSlug: 'acme',
            taskId: 't1',
            taskKey: 'T-3',
            taskTitle: 'Fix: the export',
            kind: 'commented',
            discriminator: 'd1',
            detail,
        });
        // The label's own colon stays in the label: the detail is what follows the LAST one.
        expect(inBulgarian(rows[0])).toEqual({
            title: BG.notificationTitles.stock.TASK_WATCH_UPDATE,
            message: `T-3 "Fix: the export": ${bgBodies(key, values)}`,
        });
    });

    it('NIS2_GAP_ASSIGNED, for every respondent group and both counts', () => {
        for (const [code, words] of Object.entries(NIS2_GROUP)) {
            for (const n of [1, 12]) {
                const row = {
                    type: 'GENERAL',
                    title: stockNotificationTitle('NIS2_GAP_ASSIGNED'),
                    message: stockNotificationText('NIS2_GAP_ASSIGNED', { count: nis2QuestionCount(n), group: words }),
                };
                expect(inBulgarian(row)?.message).toBe(
                    bgBodies('stock.NIS2_GAP_ASSIGNED', {
                        count: bgBodies(`stock.count.${n === 1 ? 'one' : 'other'}`, { n }),
                        group: bgBodies(`stock.group.${code}`),
                    }),
                );
            }
        }
    });

    it('an incident deadline names its report in Bulgarian, in the title and the body', () => {
        for (const kind of ['INCIDENT_DEADLINE_DUE', 'INCIDENT_DEADLINE_OVERDUE'] as const) {
            for (const [code, words] of Object.entries(INCIDENT_REPORT)) {
                const params = { report: words, reportLower: words.toLowerCase(), reference: 'INC-7' };
                const row = { type: kind, title: stockNotificationTitle(kind, params), message: stockNotificationText(kind, params) };
                const report = bgBodies(`stock.report.${code}`);
                expect(inBulgarian(row)).toEqual({
                    title: bgTitles(`stock.${kind}`, { report, reference: 'INC-7' }),
                    message: bgBodies(`stock.${kind}`, { reportLower: report, reference: 'INC-7' }),
                });
            }
        }
    });

    it('several changes to a watched task read as one list, each in Bulgarian', () => {
        const detail = [watchDueDetail('2026-11-01', '2026-12-01'), WATCH_DETAIL.reviewerCleared].join(WATCH_DETAIL_SEPARATOR);
        const row = {
            type: 'TASK_WATCH_UPDATE',
            title: stockNotificationTitle('TASK_WATCH_UPDATE'),
            message: stockNotificationText('TASK_WATCH_UPDATE', { label: '"Rotate keys"', detail }),
        };
        expect(inBulgarian(row)?.message).toBe('"Rotate keys": срок: 2026-11-01 → 2026-12-01, рецензентът е премахнат');
    });

    it('a framework update reads as the kind its body names, with and without controls to re-review', () => {
        const title = stockNotificationTitle('FRAMEWORK_UPDATED', { framework: 'ISO27001', version: '2022' });
        expect(inBulgarian({ type: 'GENERAL', title, message: stockNotificationText('FRAMEWORK_UPDATED', { added: 3 }) })).toEqual({
            title: bgTitles('stock.FRAMEWORK_UPDATED', { framework: 'ISO27001', version: '2022' }),
            message: bgBodies('stock.FRAMEWORK_UPDATED', { added: '3' }),
        });
        const review = stockNotificationText('FRAMEWORK_UPDATED_REVIEW', { added: 3, flagged: 2 });
        expect(inBulgarian({ type: 'GENERAL', title, message: review })?.message).toBe(
            bgBodies('stock.FRAMEWORK_UPDATED_REVIEW', { added: '3', flagged: '2' }),
        );
    });

    it('the product’s own fallback words are translated, a person’s name and a report type are not', () => {
        const scim = (who: string) => ({
            type: 'GENERAL',
            title: stockNotificationTitle('SCIM_AI_ADMIN_DEACTIVATED'),
            message: stockNotificationText('SCIM_AI_ADMIN_DEACTIVATED', { who }),
        });
        expect(inBulgarian(scim(SOMEBODY))?.message).toBe(
            bgBodies('stock.SCIM_AI_ADMIN_DEACTIVATED', { who: bgBodies('stock.somebody') }),
        );
        expect(inBulgarian(scim('Ivo Petrov'))?.message).toBe(bgBodies('stock.SCIM_AI_ADMIN_DEACTIVATED', { who: 'Ivo Petrov' }));
        const expired = (attestation: string) => ({
            type: 'VENDOR_POSTURE_ALERT',
            title: stockNotificationTitle('VENDOR_ATTESTATION_EXPIRED', { name: 'Acme Cloud' }),
            message: stockNotificationText('VENDOR_ATTESTATION_EXPIRED', { attestation, date: '2026-10-01' }),
        });
        expect(inBulgarian(expired(ATTESTATION))?.message).toBe(
            bgBodies('stock.VENDOR_ATTESTATION_EXPIRED', { attestation: bgBodies('stock.attestation'), date: '2026-10-01' }),
        );
        expect(inBulgarian(expired('SOC 2 Type II'))?.message).toBe(
            bgBodies('stock.VENDOR_ATTESTATION_EXPIRED', { attestation: 'SOC 2 Type II', date: '2026-10-01' }),
        );
    });

    it('rows stored before this module existed carry the same bytes, and read back too', () => {
        // Verbatim from the emitters as they stood before #5929.
        expect(inBulgarian({ type: 'TASK_ASSIGNED', title: 'You were assigned a task', message: 'T-7 "Ship it" is now yours.' })).toEqual({
            title: 'Възложена ви е задача',
            message: 'T-7 "Ship it" вече е ваша отговорност.',
        });
        expect(inBulgarian({ type: 'TASK_DUE', title: 'Task due tomorrow', message: 'TSK-9 "Ship it" is due tomorrow.' })?.message).toBe(
            'Срокът на TSK-9 "Ship it" изтича утре.',
        );
        expect(
            inBulgarian({
                type: 'GENERAL',
                title: 'NIS2 gap assessment assigned',
                message: 'You have 23 questions to answer in the NIS2 gap assessment, for anyone in the organisation.',
            })?.message,
        ).toBe('Имате 23 въпроса за отговор в оценката на пропуските по NIS2 от името на всеки в организацията.');
        expect(
            inBulgarian({
                type: 'VENDOR_REVIEW_DUE',
                title: 'Vendor review due: Acme Cloud',
                message: 'Vendor "Acme Cloud" is past its scheduled review date. Re-assess the vendor or extend the review date.',
            })?.title,
        ).toBe('Прегледът на доставчик е просрочен: Acme Cloud');
    });
});

describe('anything else is shown as stored', () => {
    it('a row whose type, title or body is no kind’s', () => {
        // A rule may be named like a stock title, under another type.
        expect(inBulgarian({ type: 'GENERAL', title: 'You were assigned a task', message: 'T-7 "A" is now yours.' })).toBeUndefined();
        expect(inBulgarian({ type: 'TASK_ASSIGNED', title: 'Task assigned', message: 'Ivo assigned you “Rotate keys”' })).toBeUndefined();
        expect(inBulgarian({ type: 'TASK_ASSIGNED', title: 'You were assigned a task', message: 'Ivo assigned you “Rotate keys”' })).toBeUndefined();
        // A GENERAL title shaped like a framework update, from a rule with its own body.
        expect(inBulgarian({ type: 'GENERAL', title: 'Payroll updated to v2', message: 'See the payroll page.' })).toBeUndefined();
    });

    it('a phrase this module did not write', () => {
        const moved = { type: 'TASK_WATCH_UPDATE', title: 'Watched task updated', message: '"Rotate keys": moved to the Q3 board' };
        expect(inBulgarian(moved)).toBeUndefined();
        const odd = 'You have 3 questionnaires to answer in the NIS2 gap assessment, for IT.';
        expect(inBulgarian({ type: 'GENERAL', title: 'NIS2 gap assessment assigned', message: odd })).toBeUndefined();
    });

    it('a person’s own text in a free body, under a worded title', () => {
        const comment = 'Please re-upload the signed copy.';
        expect(
            inBulgarian({ type: 'EVIDENCE_REJECTED', title: stockNotificationTitle('EVIDENCE_REJECTED', { title: 'DPA' }), message: comment }),
        ).toEqual({ title: bgTitles('stock.EVIDENCE_REJECTED', { title: 'DPA' }), message: comment });
        expect(
            inBulgarian({ type: 'GENERAL', title: 'Automation SLA breached', message: 'Page the on-call lead.' }),
        ).toEqual({ title: bgTitles('stock.AUTOMATION_SLA_BREACH'), message: 'Page the on-call lead.' });
    });

    it('parses a text only when the whole of it is the template', () => {
        expect(parseStockTemplate(STOCK_NOTIFICATIONS.TASK_ASSIGNED.body, `${recordLabel('A', 'K-1')} is now yours.`)).toEqual({ label: 'K-1 "A"' });
        expect(parseStockTemplate(STOCK_NOTIFICATIONS.TASK_ASSIGNED.body, 'K-1 "A" is now yours. Also this.')).toBeNull();
    });
});
