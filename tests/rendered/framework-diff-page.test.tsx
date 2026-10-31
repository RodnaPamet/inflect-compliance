/** @jest-environment jsdom */

/**
 * The requirements diff can be reached and read (#4732).
 *
 *   - The framework to compare from is chosen on the page, by name, not
 *     typed into the address as `?from=KEY`.
 *   - A description change is shown, not only named.
 *   - The changed fields are named in the person's language.
 *   - A framework without a version is not shown as "vnull".
 *   - A refusal says which framework is missing; other failures retry.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

let search = new URLSearchParams();
const replace = jest.fn();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', frameworkKey: 'ISO27001-2022' }),
    useRouter: () => ({ push: jest.fn(), replace, back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/frameworks/ISO27001-2022/diff',
    useSearchParams: () => search,
}));

// A stable translator per namespace, as next-intl gives, so effects settle.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

import DiffPage from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/diff/page';

const EN = jest.requireActual('../../messages/en.json') as {
    frameworks: { diff: Record<string, string> & { field: Record<string, string>; refused: Record<string, string> } };
};
const D = EN.frameworks.diff;

const FRAMEWORKS = [
    { key: 'ISO27001-2013', name: 'ISO 27001', version: '2013' },
    { key: 'ISO27001-2022', name: 'ISO 27001', version: '2022' },
    { key: 'CUSTOM', name: 'House rules', version: null },
];
const DIFF = {
    from: { key: 'CUSTOM', name: 'House rules', version: null },
    to: { key: 'ISO27001-2022', name: 'ISO 27001', version: '2022' },
    added: [],
    removed: [],
    changed: [
        {
            code: 'A.5.1',
            changes: ['title', 'description'],
            from: { title: 'Old title', section: 'S', description: 'The old wording.' },
            to: { title: 'New title', section: 'S', description: 'The new wording.' },
        },
    ],
    summary: { added: 0, removed: 0, changed: 1, unmappedNewRequirements: 0 },
};

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
let diffReply: () => ReturnType<typeof reply>;

beforeEach(() => {
    search = new URLSearchParams();
    replace.mockReset();
    diffReply = () => reply(200, DIFF);
    global.fetch = jest.fn(async (url: string) => {
        if (String(url).includes('action=diff')) return diffReply();
        return reply(200, FRAMEWORKS);
    }) as unknown as typeof fetch;
});

describe('requirements diff page', () => {
    it('asks for the framework to compare from on the page, not in the address', async () => {
        render(<DiffPage />);
        expect(screen.getByText(D.chooseHint)).toBeInTheDocument();
        expect(screen.queryByText(/\?from=/)).toBeNull();
        expect((global.fetch as jest.Mock).mock.calls.some(([u]) => String(u).includes('action=diff'))).toBe(false);
    });

    it('offers the other frameworks by name and opens the comparison for the one chosen', async () => {
        render(<DiffPage />);
        const trigger = await waitFor(() => {
            const el = screen.getByRole('combobox') as HTMLButtonElement;
            if (el.disabled) throw new Error('frameworks not loaded yet');
            return el;
        });
        await act(async () => { fireEvent.click(trigger); });
        const option = await screen.findByText('House rules');
        expect(screen.getByText('ISO 27001 v2013')).toBeInTheDocument();
        // The framework on the page is not offered as its own comparison.
        expect(screen.queryByText('ISO 27001 v2022')).toBeNull();
        await act(async () => { fireEvent.click(option); });
        expect(replace).toHaveBeenCalledWith('/t/acme/frameworks/ISO27001-2022/diff?from=CUSTOM');
    });

    it('shows a description change, names the fields in words, and drops "vnull"', async () => {
        search = new URLSearchParams('from=CUSTOM');
        render(<DiffPage />);
        const changedTab = await screen.findByRole('button', { name: `${D.changed} (1)` });
        await act(async () => { fireEvent.click(changedTab); });

        const row = screen.getByTestId('diff-changed-row');
        expect(row).toHaveTextContent(D.changedList.replace('{changes}', `${D.field.title}, ${D.field.description}`));
        const description = screen.getByTestId('diff-description-change');
        expect(description).toHaveTextContent('The old wording.');
        expect(description).toHaveTextContent('The new wording.');
        expect(document.body.textContent).toContain(`${D.comparing} House rules → ISO 27001 v2022`);
        expect(document.body.textContent).not.toContain('vnull');
    });

    it('says which framework is missing, with no retry', async () => {
        search = new URLSearchParams('from=GONE');
        diffReply = () => reply(404, { error: { code: 'NOT_FOUND', message: 'Framework "GONE" not found', details: { reason: 'DIFF_FROM_NOT_FOUND' } } });
        render(<DiffPage />);
        expect(await screen.findByText(D.refused.DIFF_FROM_NOT_FOUND)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: D.retry })).toBeNull();
    });

    it('offers a retry when the comparison failed for another reason, and recovers', async () => {
        search = new URLSearchParams('from=CUSTOM');
        let calls = 0;
        diffReply = () => (calls++ === 0 ? reply(500, {}) : reply(200, DIFF));
        render(<DiffPage />);
        expect(await screen.findByText(D.computeFailed)).toBeInTheDocument();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: D.retry })); });
        await waitFor(() => expect(document.getElementById('diff-summary')).not.toBeNull());
        expect(screen.queryByText(D.computeFailed)).toBeNull();
    });
});
