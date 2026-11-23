/**
 * Text the server builds or stores in English, rendered on a Bulgarian page.
 *
 * Mounted with the real `bg` catalog (the repo's global `next-intl` mock
 * reads `en`, so this file resolves `bg` the same way), so these fail when a surface goes back to printing the stored English: the
 * notifications page (agentic titles AND bodies, rows written before the
 * bodies were translatable included), the audit log's chip and entity column
 * for codes outside the composed verbs, and a report metric's definition.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const bg = jest.requireActual('../../messages/bg.json') as Record<string, unknown>;
    const lookup = (path: string): unknown =>
        path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bg);
    const make = (ns?: string) => {
        const at = (key: string) => lookup(ns ? `${ns}.${key}` : key);
        const t = (key: string, values: Record<string, string | number> = {}) => {
            const v = at(key);
            return typeof v === 'string'
                ? v.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
                : key;
        };
        t.has = (key: string) => typeof at(key) === 'string';
        t.rich = t;
        t.raw = at;
        return t;
    };
    return {
        useTranslations: make,
        useLocale: () => 'bg',
        useNow: () => new Date(0),
        useTimeZone: () => 'UTC',
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
    const href = (p: string) => `/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/notifications',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import NotificationsPage from '@/app/t/[tenantSlug]/(app)/notifications/page';
import { AuditLogClient, type AuditLogRow } from '@/app/t/[tenantSlug]/(app)/admin/audit-log/AuditLogClient';
import { Metric } from '@/app/t/[tenantSlug]/(app)/agents/reports/Metric';
import { AGENTIC_NOTIFICATION_TITLES } from '@/lib/notifications/agentic-titles';
import { AGENTIC_SUBJECT, agenticBodyText } from '@/lib/notifications/agentic-bodies';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';

const BG = jest.requireActual('../../messages/bg.json') as Record<string, Record<string, unknown>>;
const bgAt = (path: string): string =>
    path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], BG) as string;

function inBulgarian(ui: React.ReactElement) {
    return render(ui);
}

describe('the notifications page, in Bulgarian', () => {
    const killBody = agenticBodyText('AGENT_KILL_SWITCH_ENGAGED', AGENTIC_SUBJECT.EVERY_AGENT, null);
    const breakerBody = agenticBodyText('AGENT_CIRCUIT_BREAKER_TRIPPED', 'Kestrel', 'GUARD_BLOCK');
    const rows = [
        {
            id: 'n1',
            type: 'AGENT_KILL_SWITCH_ENGAGED',
            title: AGENTIC_NOTIFICATION_TITLES.AGENT_KILL_SWITCH_ENGAGED,
            message: killBody,
            linkUrl: null,
            createdAt: '2026-11-20T09:00:00.000Z',
            read: false,
        },
        {
            id: 'n2',
            type: 'AGENT_CIRCUIT_BREAKER_TRIPPED',
            title: AGENTIC_NOTIFICATION_TITLES.AGENT_CIRCUIT_BREAKER_TRIPPED,
            message: breakerBody,
            linkUrl: null,
            createdAt: '2026-11-20T09:00:00.000Z',
            read: true,
        },
        {
            id: 'n3',
            type: 'TASK_ASSIGNED',
            title: 'Task assigned',
            message: 'Ivo assigned you “Rotate keys”',
            linkUrl: null,
            createdAt: '2026-11-20T09:00:00.000Z',
            read: true,
        },
    ];

    beforeEach(() => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch;
    });

    it('renders an agentic row’s title and body from the catalog, and another emitter’s row as stored', async () => {
        inBulgarian(<NotificationsPage />);
        expect(await screen.findByText(bgAt('notificationTitles.AGENT_KILL_SWITCH_ENGAGED'))).toBeInTheDocument();
        expect(
            screen.getByText(
                bgAt('notificationBodies.body.AGENT_KILL_SWITCH_ENGAGED').replace(
                    '{subject}',
                    bgAt('notificationBodies.subject.everyAgent'),
                ),
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                bgAt('notificationBodies.bodyWithDetail.AGENT_CIRCUIT_BREAKER_TRIPPED')
                    .replace('{subject}', 'Kestrel')
                    .replace('{detail}', bgAt('notificationBodies.signal.GUARD_BLOCK')),
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText(killBody)).toBeNull();
        expect(screen.queryByText(breakerBody)).toBeNull();
        expect(screen.getByText('Ivo assigned you “Rotate keys”')).toBeInTheDocument();
    });
});

describe('the audit log, in Bulgarian', () => {
    const row = (id: string, action: string, entity: string): AuditLogRow => ({
        id,
        createdAt: '2026-11-20T09:00:00.000Z',
        action,
        entity,
        details: null,
        userName: 'Ivo',
    });

    it('labels the long tail of codes and entity types, and shows an unknown code as words', () => {
        inBulgarian(
            <AuditLogClient
                auditLog={[
                    row('a', 'ACCESS_REVIEW_CLOSE_REFUSED', 'AccessReview'),
                    row('b', 'CREATE', 'TenantCustomRole'),
                    row('c', 'AGENT_HARNESS_SCAN_INGESTED', 'AGENT_HARNESS_SCAN'),
                    row('d', 'SOMETHING_NEW_HAPPENED', 'BrandNewThing'),
                ]}
                olderHref={null}
                newestHref={null}
                translations={{
                    time: 'Време',
                    user: 'Потребител',
                    action: 'Действие',
                    entity: 'Обект',
                    details: 'Подробности',
                    noEntries: '—',
                    older: '›',
                    newest: '‹',
                    pages: 'Страници',
                }}
            />,
        );
        const table = screen.getByTestId('audit-log-table');
        for (const key of [
            'auditCodes.action.ACCESS_REVIEW_CLOSE_REFUSED',
            'auditCodes.entity.access_review',
            'auditCodes.action.CREATE',
            'auditCodes.entity.tenant_custom_role',
            'auditCodes.action.AGENT_HARNESS_SCAN_INGESTED',
            'auditCodes.entity.agent_harness_scan',
        ]) {
            expect(within(table).getAllByText(bgAt(key)).length).toBeGreaterThan(0);
        }
        // A code no catalog holds yet still reads as words, never as the code.
        expect(within(table).getByText('Something new happened')).toBeInTheDocument();
        expect(within(table).queryByText('ACCESS_REVIEW_CLOSE_REFUSED')).toBeNull();
    });
});

describe('a report metric, in Bulgarian', () => {
    it('shows the label and population from the catalog, not the payload’s English', () => {
        const def = METRIC_DEFINITIONS['inventory.registered_agents'];
        inBulgarian(
            <Metric
                id={def.id}
                measure={{ state: 'MEASURED', value: 3, basis: null }}
                definition={{ ...def, includes: [...def.includes], excludes: [...def.excludes] }}
            />,
        );
        expect(screen.getByText(bgAt('agentMetrics.inventory.registered_agents.label'))).toBeInTheDocument();
        expect(screen.getByTestId(`metric-definition-${def.id}`)).toHaveTextContent(
            bgAt('agentMetrics.inventory.registered_agents.population'),
        );
        expect(screen.queryByText(def.label)).toBeNull();
    });
});
