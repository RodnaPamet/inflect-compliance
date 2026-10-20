/**
 * The assistant launcher (#3851).
 *
 * Renders the REAL `<Providers>` wrapper, because the launcher's open state
 * lives in `AssistantOpenProvider` which is mounted there — a stubbed
 * provider would test the stub's wiring and not the product's.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// A FULL-ish surface, not the two hooks this file happens to read. Mounting
// the real shell pulls in the nav, the breadcrumbs and the palette, each of
// which reaches for a different one of these -- and a missing export here
// surfaces as "(0 , navigation_1.useParams) is not a function" thrown from
// whichever component asked, which reads as a defect in that component.
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    usePathname: () => '/t/acme/controls',
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));


// Keys returned verbatim, so an assertion names the KEY rather than a
// translation that a copy change would invalidate.
// The key is returned VERBATIM, with any interpolated values appended.
//
// Returning the bare key was the first attempt and it hid a real assertion:
// `t('toolTruncated', { tool: 'list_controls' })` rendered as "toolTruncated",
// so a test checking that the tool is NAMED passed on a string containing no
// name. Appending the values keeps assertions pinned to catalogue keys (immune
// to copy changes) while still proving the value reached the message.
jest.mock('next-intl', () => ({
    useTranslations:
        () =>
        (key: string, values?: Record<string, unknown>) =>
            values === undefined ? key : `${key}:${Object.values(values).join(',')}`,
}));

// NO module mock for '@/lib/tenant-context-provider'.
//
// The first attempt mocked it with just `useTenantApiUrl` and
// `useTenantHref`, which is the partial-barrel trap: `SidebarContent` also
// calls `useTenantContext`, `usePermissions` and `useModules`, and a factory
// that omits them resolves each to `undefined`. The symptom was
// "(0 , tenant_context_provider_1.useTenantContext) is not a function"
// thrown from SidebarNav -- which reads as a defect in the nav rather than in
// this fixture.
//
// Wrapping in the REAL `TenantProvider` is both simpler and truer: every hook
// in the module works, and nothing here has to be kept in step with which
// hooks the shell happens to call.

import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { AssistantOpenProvider } from '@/components/assistant/assistant-open-context';
import { AssistantLauncher } from '@/components/assistant/AssistantLauncher';
import { Sheet } from '@/components/ui/sheet';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

/** A complete tenant context — OWNER, so nothing is hidden by permissions. */
const TENANT: TenantContextValue = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as TenantContextValue['role'],
    permissions: {
        canRead: true,
        canWrite: true,
        canAdmin: true,
        canAudit: true,
        canExport: true,
    },
    // The REAL permission set for the role. `{}` was the first attempt and
    // failed with "Cannot read properties of undefined (reading 'view')":
    // the set is nested by domain (`{ reports: { view } }`) and the nav
    // reads those domains directly, so an empty object is not a permissive
    // stub, it is a missing one.
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: true },
};

/**
 * The real providers this feature needs, and nothing else.
 *
 * The first version mounted the whole `<Providers>` tree. It worked and it was
 * unusable: the launcher suite took **302 seconds** and the sheet suite
 * crashed with "Jest worker ran out of memory", because `<Providers>` also
 * mounts SWR, the command palette and its entity search, the theme and
 * tooltip providers, a telemetry sink, a session poller and the toast host —
 * ten times over, once per `render`.
 *
 * These are still the REAL providers, not stubs: `KeyboardShortcutProvider` is
 * the shared registry the shortcut must register on, `AssistantOpenProvider`
 * is the state the palette and launcher share, and `TenantProvider` is what
 * `useTenantHref`/`useTenantApiUrl` read. What is gone is everything this
 * feature does not touch.
 */
function Harness({ children }: { children: React.ReactNode }) {
    return (
        <KeyboardShortcutProvider>
            <AssistantOpenProvider>
                <TenantProvider value={TENANT}>{children}</TenantProvider>
            </AssistantOpenProvider>
        </KeyboardShortcutProvider>
    );
}

function mount(node: React.ReactNode) {
    return render(<Harness>{node}</Harness>);
}

/** The numeric z-index a Tailwind `z-N` class encodes, or null. */
function zOf(el: Element | null): number | null {
    if (el === null) return null;
    const m = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(el.className);
    return m === null ? null : Number(m[1]);
}

describe('the launcher renders and is reachable', () => {
    it('renders with an accessible name, since it is an icon with no text', () => {
        mount(<AssistantLauncher />);
        const btn = screen.getByTestId('assistant-launcher');
        // `aria-label` resolves through the mocked translator, so the KEY is
        // what lands in the DOM — asserting the key proves the label is wired
        // to the catalogue rather than hardcoded.
        expect(btn).toHaveAttribute('aria-label', 'openLauncher');
        expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
        expect(btn).toHaveAttribute('aria-expanded', 'false');
    });

    it('has a visible focus state, not just the browser default', () => {
        mount(<AssistantLauncher />);
        const btn = screen.getByTestId('assistant-launcher');
        // A custom background can swallow the UA outline, so the ring is the
        // thing that has to be present.
        expect(btn.className).toContain('focus-visible:ring-2');
        expect(btn.className).toContain('focus-visible:ring-offset-2');
    });

    it('drops its transition under prefers-reduced-motion', () => {
        mount(<AssistantLauncher />);
        const btn = screen.getByTestId('assistant-launcher');
        // The STATE change must survive; only the animation is opted out.
        expect(btn.className).toContain('motion-reduce:transition-none');
        // And there is no hover TRANSFORM to opt out of any more: the
        // motion-language ratchet bans hover transform/scale/shadow outside
        // its exempt list, so the grow-on-hover was removed rather than
        // wrapped in a `motion-reduce` variant. What remains is a colour
        // transition, which `motion-reduce:transition-none` covers.
        expect(btn.className).toContain('transition-colors');
        expect(btn.className).not.toContain('hover:scale');
    });

    it('becomes the close affordance while the window is open', () => {
        mount(<AssistantLauncher />);
        const btn = screen.getByTestId('assistant-launcher');
        expect(btn).toHaveAttribute('aria-label', 'openLauncher');

        fireEvent.click(btn);

        const after = screen.getByTestId('assistant-launcher');
        expect(after).toHaveAttribute('aria-label', 'closeLauncher');
        expect(after).toHaveAttribute('aria-expanded', 'true');
    });

    it('clears the iOS home indicator instead of sitting under it', () => {
        const { container } = mount(<AssistantLauncher />);
        const wrapper = container.querySelector('.fixed.bottom-0.right-0');
        expect(wrapper).not.toBeNull();
        // The offset stays at 0 and the inset is added as PADDING. A
        // hardcoded `bottom-4` is the bug this replaces: on a phone it lands
        // under the home indicator.
        // Offset 0 — the other half of the requirement. An element with a
        // non-zero bottom offset does not need the inset at all, so this and
        // the inset below only mean something together.
        expect(wrapper!.className).toContain('bottom-0');
        expect(wrapper!.className).toContain('right-0');

        // Asserted on the inset NAME, not on `env(...)`: jsdom's CSS parser
        // rewrites `env(safe-area-inset-bottom, 0px)` as
        // `env(0px * , * safe-area-inset-bottom)` -- the fallback is hoisted
        // and separators are injected. That is an artefact of the parser in
        // this environment, not of the stylesheet the browser receives, so an
        // assertion on the `env(` spelling would be testing jsdom.
        const style = (wrapper as HTMLElement).getAttribute('style') ?? '';
        expect(style).toContain('safe-area-inset-bottom');
        expect(style).toContain('safe-area-inset-right');
        expect(style).toContain('calc(1rem');
    });
});

describe('z-order keeps it under any overlay', () => {
    it('sits below a Sheet overlay, compared against the REAL overlay', () => {
        const { container } = mount(
            <>
                <AssistantLauncher />
                <Sheet open title="t" description="d">
                    <Sheet.Body>body</Sheet.Body>
                </Sheet>
            </>,
        );

        const launcherZ = zOf(container.querySelector('.fixed.bottom-0.right-0'));
        // Queried from the rendered Sheet rather than hardcoded: if the
        // primitive's own layer moves, this comparison moves with it instead
        // of silently comparing against a stale number.
        const overlayZ = zOf(document.querySelector('[data-sheet-overlay]'));

        expect(launcherZ).not.toBeNull();
        expect(overlayZ).not.toBeNull();
        expect(launcherZ as number).toBeLessThan(overlayZ as number);
    });

    it('the comparison can fail — equal layers are not "below"', () => {
        // Positive control. `toBeLessThan` on two nulls would throw, but on
        // two EQUAL numbers it fails quietly in the direction that matters:
        // a button level with the overlay is still a misclick.
        expect(30).toBeLessThan(40);
        expect(40).not.toBeLessThan(40);
    });
});
