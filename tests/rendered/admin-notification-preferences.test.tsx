/** @jest-environment jsdom */

/**
 * THE PREFERENCE SURFACE EXISTS AND REACHES THE API — #2564.
 *
 * `/admin/notifications` governed EMAIL only. It had two tabs and four
 * controls (enable, sender name, sender email, compliance mailbox) and listed
 * no notification type at all — so neither of the two agentic types, nor the
 * twenty before them, had anything to toggle. This file is the rendered half
 * of the fix; the emitter half is
 * `tests/integration/agentic-notification-preference.test.ts`.
 *
 * ## Three properties, and the weaker version of each that would not do
 *
 *   1. **Every agentic type in the RUNTIME enum reaches the page.** Driven
 *      from `Object.values(NotificationType)`, not from a list written here
 *      and not from the catalogue itself. Iterating the catalogue and checking
 *      each entry renders would pass on a catalogue that had silently dropped
 *      a type — it would simply check fewer things and report success.
 *
 *   2. **The page renders exactly what the server listed, no more.** The
 *      complement of (1): it catches a client that filters the server's list,
 *      which is the way a type could reach the payload and still not reach the
 *      operator.
 *
 *   3. **The body the UI actually sends survives the API's own schema.**
 *      `UpdateNotificationSettingsSchema` is `.strict()`, so an unknown key is
 *      a 400. The PUT is captured off the mocked fetch and fed to the REAL
 *      schema. Asserting "the fetch was called" instead would pass while every
 *      save 400'd in production — a swallowed rejection is exactly this page's
 *      failure mode, since `handleSave` never checks `res.ok`.
 *
 * The assertion in (1) is written against the runtime enum ON PURPOSE, and not
 * as `expect(readFileSync(enums.prisma)).toContain('AGENT_KILL_SWITCH_ENGAGED')`.
 * That shape is the tempting one and it is the one that costs: a whole-file
 * read with a `.toContain` needle lands in the assertion-needle ratchet's
 * Class D population, whose baselines carry DRIFT_ALLOWANCE 0. A runtime value
 * plus a DOM query is outside both reach ratchets entirely.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { NotificationType } from '@prisma/client';

import { listInAppNotificationTypes } from '@/app-layer/notifications/agentic';
import { UpdateNotificationSettingsSchema } from '@/app-layer/schemas/notification-settings.schemas';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en as unknown,
        );
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

/**
 * The mocked hooks return STABLE references, and that is load-bearing rather
 * than tidy.
 *
 * The page's fetch effect is `useEffect(fetchData, [fetchData])` over a
 * `useCallback(…, [apiUrl])`. The real `useTenantApiUrl` is memoised
 * (`useCallback(…, [tenantSlug])`), so `fetchData` is stable and the page
 * fetches once. A mock that returns a fresh closure per render gives the
 * effect a new dependency on EVERY render, so each toggle re-fetches and
 * overwrites the edit with the server's copy — the control flips back and the
 * PUT carries an empty list. That is the mock breaking the page's contract,
 * not the page; it cost a debugging pass, so it is written down here.
 */
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path}`;
    const permissions = { admin: { view: true, tenant_lifecycle: true } };
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        usePermissions: () => permissions,
    };
});

import NotificationSettingsPage from '@/app/t/[tenantSlug]/(app)/admin/notifications/page';

/**
 * The agentic members of the runtime enum.
 *
 * Derived by prefix rather than listed, so a third agentic type added to
 * `enums.prisma` is IN this expectation the moment it exists — which is the
 * regression this file is really here for: the last one shipped with no
 * preference surface and nothing said so.
 */
const AGENTIC_ENUM_TYPES = Object.values(NotificationType).filter((t) => t.startsWith('AGENT_'));

const BASE_SETTINGS = {
    enabled: true,
    defaultFromName: 'Inflect Compliance',
    defaultFromEmail: 'noreply@example.test',
    complianceMailbox: null,
    mutedInAppTypes: [] as string[],
};

const EMPTY_STATS = {
    last24h: { pending: 0, sent: 0, failed: 0 },
    last7d: { pending: 0, sent: 0, failed: 0 },
    last30d: { pending: 0, sent: 0, failed: 0 },
};

interface PutCall { url: string; body: Record<string, unknown> }

/**
 * Serve the page the shape the REAL route builds: the catalogue comes from the
 * emitter's own `listInAppNotificationTypes`, joined to a mute list. Hand-
 * writing the catalogue here would make the test agree with itself rather than
 * with the server.
 */
function installFetch(muted: string[]): PutCall[] {
    const puts: PutCall[] = [];
    const settings = { ...BASE_SETTINGS, mutedInAppTypes: muted };
    const inAppTypes = listInAppNotificationTypes().map((info) => ({
        ...info,
        muted: muted.includes(info.type),
    }));

    global.fetch = jest.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
        if (init?.method === 'PUT') {
            puts.push({ url: String(url), body: JSON.parse(init.body ?? '{}') });
            return { ok: true, json: async () => settings } as unknown as Response;
        }
        return {
            ok: true,
            json: async () => ({ settings, stats: EMPTY_STATS, inAppTypes }),
        } as unknown as Response;
    }) as unknown as typeof fetch;

    return puts;
}

/** Every in-app toggle the page actually rendered, by type. */
function renderedToggleTypes(): string[] {
    return screen
        .getAllByTestId(/^in-app-type-/)
        .map((el) => el.getAttribute('data-testid')!.replace(/^in-app-type-/, ''));
}

afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
});

describe('/admin/notifications in-app preferences (#2564)', () => {
    it('lists every agentic type in the runtime enum, each with a toggle', async () => {
        installFetch([]);
        render(<NotificationSettingsPage />);
        await waitFor(() => expect(screen.getByTestId('in-app-notification-types')).toBeTruthy());

        // Driven by the ENUM, so a catalogue that dropped a type fails here
        // rather than quietly checking one thing fewer.
        expect(AGENTIC_ENUM_TYPES.length).toBeGreaterThan(0);
        for (const type of AGENTIC_ENUM_TYPES) {
            expect(screen.getByTestId(`in-app-type-${type}`)).toBeTruthy();
        }
    });

    it('the server catalogue covers every agentic member of the runtime enum', async () => {
        const catalogued = listInAppNotificationTypes().map((info) => info.type);
        // Set equality both ways: a MISSING type is the #2564 regression, and
        // an EXTRA one would be a toggle for something the bell never sends.
        expect([...catalogued].sort()).toEqual([...AGENTIC_ENUM_TYPES].sort());
    });

    it('renders exactly what the server listed and nothing the server did not', async () => {
        installFetch([]);
        render(<NotificationSettingsPage />);
        await waitFor(() => expect(screen.getByTestId('in-app-notification-types')).toBeTruthy());

        const served = listInAppNotificationTypes().map((info) => info.type);
        expect(renderedToggleTypes().sort()).toEqual([...served].sort());
    });

    it('shows a muted type as switched OFF and an unmuted one as switched ON', async () => {
        const [first, ...rest] = AGENTIC_ENUM_TYPES;
        installFetch([first]);
        render(<NotificationSettingsPage />);
        await waitFor(() => expect(screen.getByTestId('in-app-notification-types')).toBeTruthy());

        // The checkbox means "notify", so a MUTED type reads unchecked. Getting
        // this inverted would ship a page that lies about the current state
        // while saving the right thing.
        expect((screen.getByTestId(`in-app-type-${first}`) as HTMLInputElement).checked).toBe(false);
        for (const type of rest) {
            expect((screen.getByTestId(`in-app-type-${type}`) as HTMLInputElement).checked).toBe(true);
        }
    });

    it('PUTs a muted list the API schema accepts', async () => {
        const target = AGENTIC_ENUM_TYPES[0];
        const puts = installFetch([]);
        render(<NotificationSettingsPage />);
        await waitFor(() => expect(screen.getByTestId('in-app-notification-types')).toBeTruthy());

        // `fireEvent`, not `userEvent`, for the toggle. The input is nested
        // inside its `<label>`, so a synthesised pointer click is forwarded by
        // the label back to the input and the control toggles TWICE — landing
        // back where it started and sending an empty list, which is how this
        // assertion first failed. The intermediate state is asserted below so
        // a future change to that markup cannot make this pass vacuously.
        const toggle = screen.getByTestId(`in-app-type-${target}`) as HTMLInputElement;
        expect(toggle.checked).toBe(true);
        fireEvent.click(toggle);
        await waitFor(() => expect((screen.getByTestId(`in-app-type-${target}`) as HTMLInputElement).checked).toBe(false));

        await userEvent.click(screen.getByText('Save Settings'));

        await waitFor(() => expect(puts.length).toBe(1));

        // The REAL schema, not a copy of it. `.strict()` rejects an unknown
        // key, so a body carrying `mutedInAppTypes` against a schema that does
        // not declare it throws here — where production would 400 and this
        // page would swallow it, because `handleSave` never reads `res.ok`.
        // Read back through `Record<string, unknown>` DELIBERATELY. Reading
        // `parsed.mutedInAppTypes` off the inferred type makes removing the key
        // from the schema a COMPILE error, which reddens the whole file before
        // a single test runs — a red, but not this one. What must be provable
        // here is the RUNTIME behaviour: `.strict()` throws on an undeclared
        // key, which is the 400 the operator would get and this page would
        // swallow.
        const parsed = UpdateNotificationSettingsSchema.parse(puts[0].body) as Record<string, unknown>;
        expect(parsed.mutedInAppTypes).toEqual([target]);
    });

    it('a partial PUT that omits the list leaves it absent rather than empty', async () => {
        // The `definedOnly` seam the settings module documents: zod OMITS an
        // absent optional key, which is what stops a partial save from
        // clearing a stored mute list. An `undefined` VALUE here would reach
        // Prisma as "not supplied" — same outcome — but a `[]` would wipe it.
        const parsed = UpdateNotificationSettingsSchema.parse({ defaultFromName: 'Acme' });
        expect('mutedInAppTypes' in parsed).toBe(false);
    });

    it('rejects a type that is not a NotificationType member', async () => {
        expect(() =>
            UpdateNotificationSettingsSchema.parse({ mutedInAppTypes: ['NOT_A_REAL_TYPE'] }),
        ).toThrow();
    });
});
