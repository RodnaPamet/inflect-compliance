/** @jest-environment jsdom */

/**
 * `<NavItem prefetch>` — the row hands the host's prefetch to `<Link>`.
 *
 * The default must stay the full-RSC prefetch this sidebar has used since
 * #1827 restored it; the prop exists so a host whose nav lands on a live view
 * can ask for `'auto'` instead of forking the row. jsdom renders `<Link>` as a
 * bare `<a>` and does not prefetch, so the prop is read off a mocked `Link`.
 */
import { render } from '@testing-library/react';
import { Settings } from 'lucide-react';
import * as React from 'react';

const linkProps: Array<Record<string, unknown>> = [];
jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => {
        linkProps.push(props);
        return <a href={props.href as string}>{children}</a>;
    },
}));

import { NavItem } from '@/components/layout/nav-item';

describe('<NavItem> prefetch', () => {
    beforeEach(() => {
        linkProps.length = 0;
    });

    it('defaults to the full prefetch', () => {
        render(<NavItem href="/t/foo/calendar" icon={Settings} label="Calendar" active={false} />);
        expect(linkProps.at(-1)?.prefetch).toBe(true);
    });

    it.each(['auto', null, false] as const)('passes %p through', (prefetch) => {
        render(
            <NavItem
                href="/t/foo/calendar"
                icon={Settings}
                label="Calendar"
                active={false}
                prefetch={prefetch}
            />,
        );
        expect(linkProps.at(-1)?.prefetch).toBe(prefetch);
    });
});
