/**
 * The sidebar's AGENT entry (#2423, #2424, #2425).
 *
 * Four claims, and each one is a defect that shipped or nearly did:
 *
 *   1. IT IS IN THE MANAGE SECTION, BETWEEN VENDORS AND PROCESSES. Not merely
 *      "somewhere in the sidebar": the register is a governance register with
 *      an accountable owner per row, the same tier as Policy and Vendor. An
 *      entry that drifted into Workspace or Comply would say the agent
 *      register is a daily-cadence work surface, which is what the old `/admin`
 *      placement said and got wrong in the other direction.
 *
 *   2. THE LABEL IS THE SINGULAR "Agent". The key is `nav.agents` — PLURAL key,
 *      SINGULAR value — because all seven sibling entity keys are shaped that
 *      way (`nav.assets` = "Asset", `nav.vendors` = "Vendor"). The roadmap
 *      prompt asked for `nav.agent`, which would have been the only one
 *      breaking the shape. Asserted BOTH ways round: the value is "Agent", and
 *      the key it comes from is the plural one.
 *
 *   3. WITHOUT THE AGENT PERMISSION IT IS ABSENT — asserted on the `visible`
 *      PREDICATE, not on CSS. `useNavSections` runs a FAIL-CLOSED filter:
 *      `visible` must be strictly `true` or omitted, so an item whose gate
 *      resolves to `undefined` disappears with no error anywhere. A test that
 *      read a class name would pass for an item that was rendered and hidden,
 *      and pass for an item that was silently dropped, and could not tell those
 *      apart — which is the exact failure mode the fail-closed filter creates.
 *
 *   4. THE GLYPH IS NUCLEO `Robot`, NOT LUCIDE `Bot`. `SidebarNav` is on
 *      `LEGACY_LUCIDE_USERS` in `no-lucide.test.ts` as a migration TODO, so
 *      "the file already imports lucide" is an argument for the wrong family.
 *      Robot is already the glyph on both existing agent surfaces.
 *
 * `useNavSections` is a HOOK returning plain data, so these are assertions
 * about the section structure rather than about rendered DOM — which is what
 * claims 1 and 3 are about. It is rendered through a host component because a
 * hook cannot be called outside one.
 */
import * as React from 'react';
import { render } from '@testing-library/react';

jest.setTimeout(120_000);

// next-intl is ESM (jest cannot parse it); resolve real en.json values so a
// label assertion reads the catalogue rather than a dotted path. A missing key
// renders as its own path in next-intl, so asserting on the path would pass
// only while the catalogue is INCOMPLETE.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const cache = new Map<string, (key: string) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string) => {
            const bag = ns.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en,
            );
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                bag,
            );
            return typeof v === 'string' ? v : key;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/dashboard',
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

const mockPerms = jest.fn();
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantId: 'tenant-1' }),
    usePermissions: () => mockPerms(),
}));

// The calendar badge fires a fetch on mount; the sidebar's nav data does not
// depend on it and this file asserts nothing about it.
jest.mock('@/components/layout/use-calendar-badge', () => ({
    useCalendarBadge: () => undefined,
}));

import { useNavSections } from '@/components/layout/SidebarNav';
import { Robot } from '@/components/ui/icons/nucleo';

const EN = require('../../messages/en.json') as { nav: Record<string, string> };

interface Item {
    href: string;
    label: string;
    icon: unknown;
    visible?: boolean;
}
interface Section {
    title?: string;
    items: Item[];
}

/**
 * Build the permission bag `usePermissions` returns, with the ONE key this file
 * is about under the caller's control.
 *
 * `agent_registry` is passed through verbatim — including `undefined`, which is
 * the state a permission bag from an older session or a custom role that has
 * never heard of the key arrives in. That is the case the fail-closed filter
 * exists for, and a helper that defaulted it to `false` would make the third
 * arm of the test below unwritable.
 */
function permsWith(agentRegistry: boolean | undefined) {
    return {
        admin: { view: true, manage: true, agent_registry: agentRegistry },
        reports: { view: true },
        controls: { view: true, create: true, edit: true },
        tasks: { view: true, edit: true },
    };
}

/** Run `useNavSections` inside a host component and hand back its output. */
function sections(agentRegistry: boolean | undefined): Section[] {
    mockPerms.mockReturnValue(permsWith(agentRegistry));
    let captured: Section[] = [];
    function Host() {
        captured = useNavSections() as unknown as Section[];
        return null;
    }
    render(<Host />);
    return captured;
}

/** The Manage section, by its own localised title. */
function manage(secs: Section[]): Section {
    const found = secs.find((s) => s.title === EN.nav.manage);
    if (!found) {
        throw new Error(
            `no section titled "${EN.nav.manage}" — sections were: ` +
                secs.map((s) => s.title ?? '(untitled)').join(', '),
        );
    }
    return found;
}

describe('the Agent entry sits in Manage, between Vendor and Process', () => {
    it('renders in the MANAGE section and nowhere else', () => {
        const secs = sections(true);
        const withAgents = secs.filter((s) =>
            s.items.some((i) => i.href === '/t/acme/agents'),
        );
        expect(withAgents.map((s) => s.title)).toEqual([EN.nav.manage]);
    });

    it('sits BETWEEN vendors and processes, as an exact ordered list', () => {
        // The exact href list, pinned in order — not `indexOf(agents) >
        // indexOf(vendors)`, which an item inserted at the end would also
        // satisfy. An empty selection is a pass, so the whole section's
        // membership is the assertion.
        const hrefs = manage(sections(true)).items.map((i) => i.href);
        expect(hrefs).toEqual([
            '/t/acme/policies',
            '/t/acme/vendors',
            '/t/acme/agents',
            '/t/acme/processes',
            '/t/acme/reports',
        ]);
    });
});

describe('the label is the SINGULAR noun, from the PLURAL key', () => {
    it('renders "Agent"', () => {
        const item = manage(sections(true)).items.find((i) => i.href === '/t/acme/agents');
        expect(item?.label).toBe('Agent');
    });

    it('reads it from nav.agents — the plural-key / singular-value shape its siblings use', () => {
        // Both halves. The value alone would be satisfied by a key named
        // `nav.agent`, which is the shape the prompt asked for and the only one
        // of the eight that would have broken the convention.
        expect(EN.nav.agents).toBe('Agent');
        expect((EN.nav as Record<string, string>).agent).toBeUndefined();
        // The siblings this shape comes from, so a future rename of the
        // convention fails here rather than silently leaving Agent the odd one.
        expect(EN.nav.assets).toBe('Asset');
        expect(EN.nav.vendors).toBe('Vendor');
        expect(EN.nav.policies).toBe('Policy');
    });
});

describe('without the agent permission the entry is ABSENT', () => {
    it('is dropped when admin.agent_registry is false', () => {
        const hrefs = manage(sections(false)).items.map((i) => i.href);
        expect(hrefs).not.toContain('/t/acme/agents');
        // Paired positive over the same run: the section still holds its other
        // items, so the absence is this ONE gate rather than a broken render.
        expect(hrefs).toContain('/t/acme/vendors');
    });

    it('is dropped when the key is ABSENT from the permission bag entirely', () => {
        // The fail-closed filter's real case. `visible` is computed as
        // `perms.admin.agent_registry === true`, so an undefined key yields
        // `false` rather than `undefined` — and an item whose `visible` were
        // `undefined` would be treated as UNGATED and shown to everybody,
        // which is the direction that leaks.
        const hrefs = manage(sections(undefined)).items.map((i) => i.href);
        expect(hrefs).not.toContain('/t/acme/agents');
    });

    it('the gate is the `visible` PREDICATE, asserted before the filter runs', () => {
        // Read on the DEF rather than on the rendered row: a class-name
        // assertion cannot tell "rendered and hidden" from "never rendered",
        // and the fail-closed filter's whole failure mode is the silent drop.
        //
        // The ungated siblings are checked in the same breath, because
        // `visible: undefined` and `visible: false` are the two states the
        // filter treats differently and a test that only saw one of them would
        // not notice the predicate being inverted.
        mockPerms.mockReturnValue(permsWith(true));
        let captured: Section[] = [];
        function Host() {
            captured = useNavSections() as unknown as Section[];
            return null;
        }
        render(<Host />);
        const items = manage(captured).items;
        const agent = items.find((i) => i.href === '/t/acme/agents');
        expect(agent?.visible).toBe(true);
        expect(items.find((i) => i.href === '/t/acme/vendors')?.visible).toBeUndefined();
    });
});

describe('the glyph is Nucleo Robot, not lucide Bot', () => {
    it('is the same component the other agent surfaces use', () => {
        const item = manage(sections(true)).items.find((i) => i.href === '/t/acme/agents');
        // Identity, not a name: `icon.name === 'Robot'` would also be
        // satisfied by a lucide export that happened to be called Robot, and
        // the point of the correction is the FAMILY.
        expect(item?.icon).toBe(Robot);
    });
});
