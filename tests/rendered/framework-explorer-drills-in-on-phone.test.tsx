/**
 * On a phone the framework explorer drills in: tapping a requirement shows
 * its detail IN PLACE of the tree, scrolled into view, and Back returns to
 * the tree at the scroll position it left.
 *
 * Stacked master/detail is what this replaces: a tap changed a pane far below
 * the tree, so it looked like it did nothing. The swap is CSS (`max-md:`
 * classes on the two panes), so this reads the classes that decide which pane
 * a phone shows, and checks a larger screen keeps both panes.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

let belowMd = true;
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useIsBelowMd: () => belowMd,
}));

import { FrameworkExplorer } from '@/components/frameworks/FrameworkExplorer';
import type { FrameworkTreeNode, FrameworkTreePayload } from '@/lib/framework-tree/types';

const en = require('../../messages/en.json');
const BACK: string = en.panels.framework.backToRequirements;

function node(id: string, kind: FrameworkTreeNode['kind'], code: string, children: FrameworkTreeNode[] = []): FrameworkTreeNode {
    return {
        id,
        kind,
        label: code,
        title: `Title ${code}`,
        description: kind === 'requirement' ? `Description of ${code}` : null,
        code: kind === 'requirement' ? code : undefined,
        sortOrder: 0,
        descendantCount: children.length,
        childCount: children.length,
        hasChildren: children.length > 0,
        children,
        complianceStatus: 'gap',
        statusCounts: { compliant: 0, partial: 0, gap: 1, na: 0, unknown: 0 },
    } as FrameworkTreeNode;
}

const tree: FrameworkTreePayload = {
    framework: { id: 'fw', key: 'ISO27001', name: 'ISO 27001', version: null, kind: 'STANDARD', description: null },
    nodes: [node('s-5', 'section', 'A.5', [node('r-51', 'requirement', 'A.5.1'), node('r-52', 'requirement', 'A.5.2')])],
    totals: { sections: 1, requirements: 2, maxDepth: 2 },
} as FrameworkTreePayload;

const treePane = () => document.getElementById('framework-explorer-tree') as HTMLElement;
const detailPane = () => document.getElementById('framework-explorer-detail') as HTMLElement;
const row = (text: string) => {
    const item = screen.getAllByRole('treeitem').find((el) => within(el).queryByText(text));
    if (!item) throw new Error(`no row for ${text}`);
    return item;
};

let scrollIntoView: jest.Mock;
let scrollTo: jest.Mock;

beforeEach(() => {
    belowMd = true;
    scrollIntoView = jest.fn();
    scrollTo = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
});

describe('framework explorer on a phone', () => {
    it('shows the tree alone until a requirement is tapped', () => {
        render(<FrameworkExplorer tree={tree} coverage={{ controlMappings: [] }} />);
        expect(treePane().className).not.toContain('max-md:hidden');
        expect(detailPane().className).toContain('max-md:hidden');
        expect(screen.queryByRole('button', { name: BACK })).toBeNull();
    });

    it('a tap on a section opens it, as its chevron does', () => {
        render(<FrameworkExplorer tree={tree} coverage={{ controlMappings: [] }} />);
        const section = row('A.5');
        expect(section).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(section);
        expect(row('A.5')).toHaveAttribute('aria-expanded', 'true');
        // Still the list: a section is not a destination on a phone.
        expect(treePane().className).not.toContain('max-md:hidden');
    });

    it('a tap on a requirement shows its detail in place of the tree, in view, and Back returns to the same scroll position', () => {
        render(<FrameworkExplorer tree={tree} coverage={{ controlMappings: [] }} />);
        fireEvent.click(row('A.5'));
        (window as { scrollY: number }).scrollY = 640;

        act(() => { fireEvent.click(within(row('A.5.2')).getByText('Title A.5.2')); });

        expect(treePane().className).toContain('max-md:hidden');
        expect(detailPane().className).not.toContain('max-md:hidden');
        expect(within(detailPane()).getByText('Description of A.5.2')).toBeInTheDocument();
        // The detail is brought into view, and focus moves to Back.
        expect(scrollIntoView).toHaveBeenCalled();
        expect(scrollIntoView.mock.contexts[scrollIntoView.mock.contexts.length - 1]).toBe(detailPane());
        const back = screen.getByRole('button', { name: BACK });
        expect(back).toHaveFocus();
        expect(back.className).toContain('min-h-11');

        act(() => { fireEvent.click(back); });

        expect(treePane().className).not.toContain('max-md:hidden');
        expect(detailPane().className).toContain('max-md:hidden');
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 640 });
        // The section the user opened is still open.
        expect(row('A.5')).toHaveAttribute('aria-expanded', 'true');
    });

    it('on a larger screen both panes stay and nothing scrolls', () => {
        belowMd = false;
        render(<FrameworkExplorer tree={tree} coverage={{ controlMappings: [] }} />);
        fireEvent.click(row('A.5'));
        // A section tap selects it and leaves expansion to the chevron.
        expect(row('A.5')).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(row('A.5').querySelector('button') as HTMLElement);
        fireEvent.click(within(row('A.5.1')).getByText('Title A.5.1'));
        expect(within(detailPane()).getByText('Description of A.5.1')).toBeInTheDocument();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: BACK })).toBeNull();
    });
});
