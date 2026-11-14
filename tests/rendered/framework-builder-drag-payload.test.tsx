/** @jest-environment jsdom */

/**
 * Dragging a requirement in the Framework Builder carries the requirement and
 * nothing else (#5309).
 *
 * The requirement row sits inside its draggable section card, so its
 * dragstart bubbled to the card's handler and the drag carried a SECTION
 * payload too. Released on the gap between two sections — a section drop zone,
 * which accepts that payload — it moved the whole section instead.
 */
import * as React from 'react';
import { fireEvent, render } from '@testing-library/react';

import { FrameworkBuilder } from '@/components/ui/FrameworkBuilder';
import type { FrameworkTreePayload } from '@/lib/framework-tree/types';

const requirement = (id: string, code: string) => ({
    id,
    kind: 'requirement' as const,
    label: code,
    title: `Requirement ${code}`,
    description: null,
    code,
    sortOrder: 0,
    descendantCount: 0,
    childCount: 0,
    hasChildren: false,
    children: [],
});

const section = (id: string, label: string, children: ReturnType<typeof requirement>[]) => ({
    id,
    kind: 'section' as const,
    label,
    title: label,
    description: null,
    descendantCount: children.length,
    childCount: children.length,
    hasChildren: true,
    children,
});

const TREE = {
    framework: { id: 'fw', key: 'TEST', name: 'Test', version: null, kind: 'ISO_STANDARD', description: null },
    nodes: [
        section('s-a', 'A', [requirement('r-a1', 'A.1')]),
        section('s-b', 'B', [requirement('r-b1', 'B.1'), requirement('r-b2', 'B.2')]),
    ],
    totals: { sections: 2, requirements: 3, maxDepth: 2 },
} as unknown as FrameworkTreePayload;

function dataTransfer() {
    const store = new Map<string, string>();
    return {
        store,
        setData: (type: string, value: string) => store.set(type, value),
        getData: (type: string) => store.get(type) ?? '',
        get types() {
            return [...store.keys()];
        },
        effectAllowed: 'none',
        dropEffect: 'none',
    };
}

describe('FrameworkBuilder drag payloads', () => {
    it('a requirement drag carries only the requirement payload', () => {
        const { container } = render(<FrameworkBuilder tree={TREE} onSave={jest.fn()} />);
        const row = container.querySelector('[data-builder-requirement-id="r-b2"]')!;
        const dt = dataTransfer();
        fireEvent.dragStart(row, { dataTransfer: dt });
        expect(dt.types).toEqual(['application/x-framework-requirement']);
        expect(JSON.parse(dt.getData('application/x-framework-requirement'))).toEqual({
            sectionId: 's-b',
            requirementId: 'r-b2',
        });
    });

    it('a section drag still carries the section payload', () => {
        const { container } = render(<FrameworkBuilder tree={TREE} onSave={jest.fn()} />);
        const card = container.querySelector('[data-builder-section-id="s-b"]')!;
        const dt = dataTransfer();
        fireEvent.dragStart(card, { dataTransfer: dt });
        expect(dt.types).toEqual(['application/x-framework-section']);
        expect(dt.getData('application/x-framework-section')).toBe('s-b');
    });
});
