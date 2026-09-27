/**
 * The Processes nav entry follows the MODULE, not a permission.
 *
 * The route itself is gated server-side (`processes/layout.tsx` calls
 * `notFound()` when the module is off). This pins the other half: the sidebar
 * must not offer a link to it. A visible link to a 404 is the worst failure
 * available to a nav gate — the reader concludes the product is broken rather
 * than that they do not have the feature.
 *
 * Both halves read the SAME value, threaded from one server-side read in
 * `getTenantServerContext`, so the nav and the route cannot disagree.
 */
import { render } from '@testing-library/react';

jest.setTimeout(120_000);

// next-intl is ESM (jest cannot parse it); resolve real en.json values so a
// label assertion reads the catalogue rather than a dotted path.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const make = (ns: string) => (key: string) => {
        const dict = (en[ns] ?? {}) as Record<string, unknown>;
        const v = dict[key];
        return typeof v === 'string' ? v : `${ns}.${key}`;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme',
    useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

const mockModules = jest.fn();

// Spread the real module and override only what this file drives. A factory
// that LISTS exports is a snapshot of the module as it looked the day it was
// written — the mistake this very change surfaced in `agentic-nav-item`.
jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantId: 'tenant-1' }),
    usePermissions: () => ({
        admin: { view: true, manage: true, agent_registry: true },
        reports: { view: true },
        controls: { view: true, create: true, edit: true },
        tasks: { view: true, edit: true },
    }),
    useModules: () => mockModules(),
}));

jest.mock('@/components/layout/use-calendar-badge', () => ({
    useCalendarBadge: () => undefined,
}));

import { useNavSections } from '@/components/layout/SidebarNav';

interface Item { href: string; visible?: boolean }
interface Section { title?: string; items: Item[] }

function hrefs(processCanvas: boolean): string[] {
    mockModules.mockReturnValue({ processCanvas });
    let captured: Section[] = [];
    function Host() {
        captured = useNavSections() as unknown as Section[];
        return null;
    }
    render(<Host />);
    return captured.flatMap((s) => s.items.map((i) => i.href));
}

describe('the Processes nav entry follows the module', () => {
    it('is ABSENT when the module is off', () => {
        expect(hrefs(false)).not.toContain('/t/acme/processes');
    });

    it('is PRESENT when the module is on — the control that gives the above meaning', () => {
        // Without this, a nav that had dropped the entry entirely, or a filter
        // that removed everything, would satisfy the assertion above forever.
        expect(hrefs(true)).toContain('/t/acme/processes');
    });

    it('the rest of the nav is unaffected either way', () => {
        // The module governs ONE entry. A gate wired to the wrong value — or to
        // the whole section — would show up here as other items disappearing
        // with it, which the two assertions above cannot see.
        const on = hrefs(true);
        const off = hrefs(false);
        expect(off).toEqual(on.filter((h) => h !== '/t/acme/processes'));
        expect(off.length).toBe(on.length - 1);
    });
});
