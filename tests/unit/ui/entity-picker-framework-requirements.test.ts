/**
 * The entity picker reads framework requirements out of the framework
 * tree the route actually returns (#5129).
 *
 * `GET /frameworks/{key}/tree` answers with a `FrameworkTreePayload`
 * (`{ framework, nodes, totals }`), requirements nested in `nodes`. The
 * picker read a top-level `requirements` array the route never sends, so it
 * listed nothing, and a preset requirement link showed its raw id.
 */
import { fetchEntityLabel, requirementRowsOf } from '@/components/ui/entity-picker';
import type { FrameworkTreeNode } from '@/lib/framework-tree/types';

function node(partial: Partial<FrameworkTreeNode> & Pick<FrameworkTreeNode, 'id' | 'kind' | 'label' | 'title'>): FrameworkTreeNode {
    return {
        descendantCount: 0,
        childCount: partial.children?.length ?? 0,
        hasChildren: Boolean(partial.children?.length),
        children: [],
        ...partial,
    };
}

const NODES: FrameworkTreeNode[] = [
    node({
        id: 'section:fw:A.5',
        kind: 'section',
        label: 'A.5',
        title: 'Organizational controls',
        children: [
            node({
                id: 'req_a51',
                kind: 'requirement',
                label: 'A.5.1',
                code: 'A.5.1',
                title: 'Policies for information security',
                children: [
                    node({ id: 'req_a511', kind: 'requirement', label: 'A.5.1.1', code: 'A.5.1.1', title: 'Policy review' }),
                ],
            }),
        ],
    }),
];

describe('requirementRowsOf', () => {
    it('flattens every requirement at any depth and never offers a section', () => {
        expect(requirementRowsOf(NODES)).toEqual([
            { id: 'req_a51', code: 'A.5.1', title: 'Policies for information security' },
            { id: 'req_a511', code: 'A.5.1.1', title: 'Policy review' },
        ]);
    });

    it('falls back to the label when a requirement carries no code', () => {
        expect(
            requirementRowsOf([node({ id: 'r', kind: 'requirement', label: 'Art. 21', title: 'Measures' })]),
        ).toEqual([{ id: 'r', code: 'Art. 21', title: 'Measures' }]);
    });
});

describe('fetchEntityLabel for a framework requirement', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('resolves a requirement out of the tree payload', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                framework: { id: 'fw', key: 'iso27001', name: 'ISO 27001', version: null, kind: 'ISO', description: null },
                nodes: NODES,
                totals: { sections: 1, requirements: 2, maxDepth: 2 },
            }),
        })) as unknown as typeof fetch;

        await expect(
            fetchEntityLabel('acme', 'FRAMEWORK_REQUIREMENT', 'req_a511', 'Untitled', { frameworkKey: 'iso27001' }),
        ).resolves.toBe('A.5.1.1: Policy review');
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/t/acme/frameworks/iso27001/tree'),
            expect.anything(),
        );
    });
});
