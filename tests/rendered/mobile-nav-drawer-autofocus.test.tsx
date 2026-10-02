/** @jest-environment jsdom */

/**
 * The phone drawer asks vaul to move focus INTO the panel when it opens.
 *
 * Vaul's `autoFocus` defaults to false, and its content then cancels Radix's
 * open auto-focus. In Chromium at 393 px that left focus on the hamburger
 * behind an open modal: `document.activeElement` was still the opener 2 s
 * after Enter, so a keyboard or switch user had to Tab blind to reach a link.
 *
 * WHY THIS READS THE PROP INSTEAD OF WHERE FOCUS LANDS. jsdom does not
 * reproduce the defect: with `autoFocus={false}` focus still ends up inside
 * the panel here (measured: the "panel takes focus on open" assertion in
 * `mobile-nav-drawer-a11y.test.tsx` passes either way). A focus assertion
 * would therefore pass against the bug. The property that differs between
 * the two browsers' outcomes is the prop handed to the primitive, so that is
 * what is pinned; the browser outcome is covered by playerz's E2E (its T19
 * `mobile/admin-shell.spec.ts`).
 */

import { render } from '@testing-library/react';
import * as React from 'react';

const sheetProps: Array<Record<string, unknown>> = [];
jest.mock('@/components/ui/sheet', () => {
    const Sheet = ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => {
        sheetProps.push(props);
        return <div>{children}</div>;
    };
    const Header = () => null;
    const Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
    Header.displayName = 'SheetHeader';
    Body.displayName = 'SheetBody';
    Sheet.Header = Header;
    Sheet.Body = Body;
    return { Sheet };
});

import { MobileNavDrawer } from '@/components/layout/MobileNavDrawer';

describe('MobileNavDrawer — focus goes in', () => {
    it('passes autoFocus to the Sheet', () => {
        render(
            <MobileNavDrawer open onClose={jest.fn()}>
                <a href="/dashboard">Board</a>
            </MobileNavDrawer>,
        );
        expect(sheetProps.at(-1)?.autoFocus).toBe(true);
    });
});
