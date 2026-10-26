/**
 * A requirement outside the packs a workspace chose is labelled so in the
 * framework explorer, and is never shown as an unmapped gap.
 *
 * The tree usecase marks such a node `outOfScope` with status `na`
 * (`decorateTreeWithCompliance`); this proves the explorer reads the flag
 * rather than falling through to the unmapped chip a requirement with no
 * controls otherwise wears, both on the row and in the detail pane.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { FrameworkExplorer } from '@/components/frameworks/FrameworkExplorer';
import type { FrameworkTreeNode, FrameworkTreePayload } from '@/lib/framework-tree/types';

const en = require('../../messages/en.json');
const OUT_OF_SCOPE: string = en.panels.framework.outOfScope;
const OUT_OF_SCOPE_DETAIL: string = en.panels.framework.outOfScopeDetail;
const UNMAPPED: string = en.panels.framework.unmapped;

function requirement(id: string, code: string, extra: Partial<FrameworkTreeNode> = {}): FrameworkTreeNode {
    return {
        id,
        kind: 'requirement',
        label: code,
        title: `Requirement ${code}`,
        description: null,
        code,
        sortOrder: 0,
        descendantCount: 0,
        childCount: 0,
        hasChildren: false,
        children: [],
        complianceStatus: 'gap',
        statusCounts: { compliant: 0, partial: 0, gap: 1, na: 0, unknown: 0 },
        ...extra,
    };
}

const tree: FrameworkTreePayload = {
    framework: { id: 'fw', key: 'EU-UAS-OPS', name: 'EU drone operations', version: null, kind: 'REGULATION', description: null },
    nodes: [
        requirement('r-in', 'UAS.A2.1'),
        requirement('r-out', 'UAS.LUC.1', {
            complianceStatus: 'na',
            statusCounts: { compliant: 0, partial: 0, gap: 0, na: 1, unknown: 0 },
            outOfScope: true,
        }),
    ],
    totals: { sections: 0, requirements: 2, maxDepth: 1 },
};

function row(code: string): HTMLElement {
    const item = screen.getAllByRole('treeitem').find((el) => within(el).queryByText(code));
    if (!item) throw new Error(`no tree row for ${code}`);
    return item;
}

describe('FrameworkExplorer — requirements outside the chosen packs', () => {
    it('labels the out-of-scope row and leaves the in-scope gap as it was', () => {
        render(<FrameworkExplorer tree={tree} coverage={{ controlMappings: [] }} />);

        expect(within(row('UAS.LUC.1')).getByText(OUT_OF_SCOPE)).toBeInTheDocument();
        expect(within(row('UAS.A2.1')).queryByText(OUT_OF_SCOPE)).not.toBeInTheDocument();
    });

    it('explains the scope in the detail pane instead of calling it unmapped', () => {
        render(<FrameworkExplorer tree={tree} coverage={{ controlMappings: [] }} />);

        fireEvent.click(within(row('UAS.LUC.1')).getByText('Requirement UAS.LUC.1'));
        expect(screen.getByText(OUT_OF_SCOPE_DETAIL)).toBeInTheDocument();
        expect(screen.queryByText(UNMAPPED)).not.toBeInTheDocument();

        // The in-scope requirement with no controls is still called unmapped.
        fireEvent.click(within(row('UAS.A2.1')).getByText('Requirement UAS.A2.1'));
        expect(screen.queryByText(OUT_OF_SCOPE_DETAIL)).not.toBeInTheDocument();
        expect(screen.getByText(UNMAPPED)).toBeInTheDocument();
    });
});
