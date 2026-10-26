/** @jest-environment jsdom */

/**
 * The policy detail page acts on the right version, and says why when the
 * server refuses (#4127).
 *
 * `currentVersionId` is the PUBLISHED pointer; it does not move when a version
 * is saved. The page read it as "the version to act on", so once a draft had
 * been edited the header's Request Approval asked about the old text, an
 * emergency publish published it, the Current tab showed it and the editor
 * reopened on it. These tests drive the real page against a stubbed `fetch`
 * and assert which version each action names on the wire.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        t.has = (key: string) => typeof resolve(ns, key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', policyId: 'p1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/policies/p1',
    useSearchParams: () => new URLSearchParams(),
}));

const mockPermissions = { canWrite: true, canAdmin: true };
// Stable function identities: the page keys its fetch callback on `apiUrl`,
// so a fresh function per render would refetch forever.
const mockApiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
const mockHref = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: mockPermissions,
        role: mockPermissions.canAdmin ? 'ADMIN' : 'EDITOR',
        tenantSlug: 'acme',
        userId: 'u-viewer',
    }),
    useTenantApiUrl: () => mockApiUrl,
    useTenantHref: () => mockHref,
    useCurrentUserId: () => 'u-viewer',
}));

jest.mock('@/lib/hooks/use-entity-list-ids', () => ({ useEntityListIds: () => [] }));

// The lazily-loaded rich editor (and the traceability panel, which these
// tests never open) render as a plain textarea carrying the editor's value.
jest.mock('next/dynamic', () => () => {
    function DynamicStub(props: { id?: string; value?: string; onChange?: (v: string, t: string) => void; contentType?: string }) {
        return (
            <textarea
                id={props.id}
                data-testid={props.id ?? 'dynamic-stub'}
                value={props.value ?? ''}
                onChange={(e) => props.onChange?.(e.target.value, props.contentType ?? 'MARKDOWN')}
            />
        );
    }
    return DynamicStub;
});

// The document renderer's sanitiser and markdown parser are ESM-only in
// jsdom; which version's text reaches the page is what matters here.
jest.mock('@/lib/security/sanitize', () => ({ sanitizeRichTextHtml: (html: string) => html }));
jest.mock('@/lib/policy/policy-content', () => ({
    renderPolicyMarkdown: (text: string | null | undefined) => text ?? '',
    enrichPolicyHtml: (html: string) => html,
}));

// Panels with their own data fetching, not under test here.
jest.mock('@/components/policies/PolicyAcknowledgementsPanel', () => ({ PolicyAcknowledgementsPanel: () => null }));
jest.mock('@/components/InheritedMappingsPanel', () => ({ InheritedMappingsPanel: () => null }));
jest.mock('@/components/LinkedTasksPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/VersionDiff', () => ({ VersionDiff: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/policies/[policyId]/PolicySharePointSection', () => ({
    PolicySharePointSection: () => null,
}));

import PolicyDetailPage from '@/app/t/[tenantSlug]/(app)/policies/[policyId]/page';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

const EN = (jest.requireActual('../../messages/en.json') as {
    policies: { detail: Record<string, string>; filterEnums: { status: Record<string, string> } };
    approval: Record<string, string>;
}).policies;

const user = (id: string, name: string) => ({ id, name });

function version(n: number, text: string, approvals: unknown[] = []) {
    return {
        id: `v${n}`,
        policyId: 'p1',
        versionNumber: n,
        contentType: 'MARKDOWN',
        contentText: text,
        externalUrl: null,
        changeSummary: null,
        createdAt: `2026-0${n}-01T00:00:00.000Z`,
        createdBy: user('u-author', 'Author'),
        approvals,
    };
}

function approval(id: string, versionId: string, status: string, over: Record<string, unknown> = {}) {
    return {
        id,
        policyId: 'p1',
        policyVersionId: versionId,
        status,
        requestedBy: user('u-requester', 'Requester'),
        approvedBy: status === 'PENDING' ? null : user('u-reviewer', 'Reviewer'),
        decidedAt: status === 'PENDING' ? null : '2026-05-02T00:00:00.000Z',
        comment: null,
        createdAt: '2026-05-01T00:00:00.000Z',
        ...over,
    };
}

function policyFixture(over: Record<string, unknown>) {
    return {
        id: 'p1',
        tenantId: 't1',
        slug: 'access-control',
        title: 'Access Control Policy',
        status: 'DRAFT',
        currentVersionId: 'v1',
        lifecycleVersion: 1,
        lifecycleHistoryJson: [],
        approvals: [],
        evidenceItems: [],
        controlLinks: [],
        ...over,
    };
}

/** A draft created with content (pointer seeded at v1), then edited to v2. */
const EDITED_DRAFT = (() => {
    const v1 = version(1, 'OLD TEXT from version one');
    const v2 = version(2, 'NEW TEXT from version two');
    return policyFixture({ status: 'DRAFT', currentVersionId: 'v1', currentVersion: v1, versions: [v2, v1] });
})();

const fetchMock = jest.fn();
function json(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function serve(policy: unknown, writes: (url: string, init: RequestInit) => Response = () => json({})) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method && init.method !== 'GET') return writes(url, init);
        if (url === '/api/t/acme/policies/p1') return json(policy);
        return json([]);
    });
}

function writesTo(suffix: string): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
        .filter(([url, init]) => url === `/api/t/acme/policies/p1${suffix}` && init?.method === 'POST')
        .map(([, init]) => JSON.parse(String(init.body ?? '{}')));
}

async function renderPage() {
    render(
        <KeyboardShortcutProvider>
            <TooltipProvider>
                <PolicyDetailPage />
            </TooltipProvider>
        </KeyboardShortcutProvider>,
    );
    await waitFor(() => expect(document.getElementById('policy-title')).not.toBeNull());
}

const openTab = (label: string) => fireEvent.click(screen.getByRole('tab', { name: label }));

beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockPermissions.canWrite = true;
    mockPermissions.canAdmin = true;
});

describe('an edited draft — the newest version is the one acted on', () => {
    it('the Current tab shows the newest version, not the seeded pointer', async () => {
        serve(EDITED_DRAFT);
        await renderPage();
        expect(screen.getByText(/NEW TEXT from version two/)).toBeInTheDocument();
        expect(screen.queryByText(/OLD TEXT from version one/)).not.toBeInTheDocument();
    });

    it('the header Request Approval asks about the newest version', async () => {
        serve(EDITED_DRAFT);
        await renderPage();
        fireEvent.click(document.getElementById('header-request-approval')!);
        await waitFor(() => expect(writesTo('/approval')).toEqual([{ versionId: 'v2' }]));
    });

    it('the editor starts from the newest version', async () => {
        serve(EDITED_DRAFT);
        await renderPage();
        fireEvent.click(document.getElementById('new-version-btn')!);
        expect(await screen.findByTestId('version-editor')).toHaveValue('NEW TEXT from version two');
    });

    it('the editor offers Write and External link, and no file upload', async () => {
        serve(EDITED_DRAFT);
        await renderPage();
        openTab(EN.detail.tabEditor);
        expect(document.getElementById('mode-markdown')).not.toBeNull();
        expect(document.getElementById('mode-external_link')).not.toBeNull();
        expect(document.getElementById('mode-file')).toBeNull();
        expect(document.getElementById('file-upload-input')).toBeNull();
    });

    it('Publish without approval names and publishes the newest version', async () => {
        serve(EDITED_DRAFT);
        await renderPage();
        fireEvent.click(document.getElementById('header-publish-bypass')!);
        expect(await screen.findByTestId('policy-bypass-body')).toHaveTextContent(/\bv2\b/);
        fireEvent.change(screen.getByTestId('policy-bypass-reason'), { target: { value: 'Incident IR-7' } });
        fireEvent.click(screen.getByTestId('policy-bypass-confirm'));
        await waitFor(() =>
            expect(writesTo('/publish')).toEqual([{ versionId: 'v2', bypassApprovalReason: 'Incident IR-7' }]),
        );
    });
});

describe('Publish is offered only for the version the server accepts', () => {
    it('no per-version Publish on a draft whose old version carries an APPROVED row', async () => {
        const v1 = version(1, 'one', [approval('a-old', 'v1', 'APPROVED')]);
        const v2 = version(2, 'two');
        serve(policyFixture({ status: 'DRAFT', currentVersion: v1, versions: [v2, v1], approvals: [approval('a-old', 'v1', 'APPROVED')] }));
        await renderPage();
        openTab(EN.detail.tabVersions);
        expect(document.getElementById('publish-version-1')).toBeNull();
        expect(document.getElementById('publish-version-2')).toBeNull();
        expect(document.getElementById('header-publish')).toBeNull();
    });

    it('"Approved — ready to publish" is shown to those who can publish, not to Editors', async () => {
        const v1 = version(1, 'one', [approval('a1', 'v1', 'APPROVED')]);
        const approved = policyFixture({ status: 'APPROVED', currentVersion: v1, versions: [v1], approvals: [approval('a1', 'v1', 'APPROVED')] });

        serve(approved);
        await renderPage();
        expect(screen.getByText(EN.detail.guideApprovedTitle)).toBeInTheDocument();
    });

    it('…and an Editor, who cannot publish, does not see it', async () => {
        mockPermissions.canAdmin = false;
        const v1 = version(1, 'one', [approval('a1', 'v1', 'APPROVED')]);
        serve(policyFixture({ status: 'APPROVED', currentVersion: v1, versions: [v1], approvals: [approval('a1', 'v1', 'APPROVED')] }));
        await renderPage();
        expect(screen.queryByText(EN.detail.guideApprovedTitle)).not.toBeInTheDocument();
    });
});

describe('revising a published policy', () => {
    const v1 = version(1, 'LIVE TEXT', [approval('a1', 'v1', 'APPROVED', { createdAt: '2026-01-01T00:00:00.000Z' })]);

    it('the Current tab keeps showing the live version, and Request Approval targets the revision', async () => {
        const v2 = version(2, 'REVISED TEXT');
        serve(policyFixture({ status: 'PUBLISHED', currentVersion: v1, versions: [v2, v1], approvals: [v1.approvals[0]] }));
        await renderPage();
        expect(screen.getByText(/LIVE TEXT/)).toBeInTheDocument();
        expect(screen.getByText(EN.detail.guideRevisionTitle)).toBeInTheDocument();
        fireEvent.click(document.getElementById('header-request-approval')!);
        await waitFor(() => expect(writesTo('/approval')).toEqual([{ versionId: 'v2' }]));
    });

    it('a pending revision shows the approval banner, and its comment travels with the decision', async () => {
        const pending = approval('a2', 'v2', 'PENDING', { createdAt: '2026-02-01T00:00:00.000Z' });
        const v2 = version(2, 'REVISED TEXT', [pending]);
        serve(
            policyFixture({ status: 'PUBLISHED', currentVersion: v1, versions: [v2, v1], approvals: [pending, v1.approvals[0]] }),
            () => json({ id: 'a2', status: 'REJECTED' }),
        );
        await renderPage();
        const banner = screen.getByTestId('approval-banner');
        fireEvent.click(within(banner).getByTestId('approval-banner-add-comment'));
        fireEvent.change(within(banner).getByTestId('approval-banner-comment-input'), {
            target: { value: 'Section 3 needs the new retention period' },
        });
        fireEvent.click(within(banner).getByTestId('approval-banner-reject'));
        await waitFor(() =>
            expect(writesTo('/approval/a2/decide')).toEqual([
                { decision: 'REJECTED', comment: 'Section 3 needs the new retention period' },
            ]),
        );
    });

    it('an approved revision is published from the header and from its own card only', async () => {
        const approvedRev = approval('a2', 'v2', 'APPROVED', { createdAt: '2026-02-01T00:00:00.000Z', comment: 'Looks right' });
        const v2 = version(2, 'REVISED TEXT', [approvedRev]);
        serve(policyFixture({ status: 'PUBLISHED', currentVersion: v1, versions: [v2, v1], approvals: [approvedRev, v1.approvals[0]] }));
        await renderPage();
        openTab(EN.detail.tabVersions);
        expect(document.getElementById('publish-version-2')).not.toBeNull();
        expect(document.getElementById('publish-version-1')).toBeNull();
        // The decision's comment is shown with it.
        expect(screen.getByTestId('approval-comment-a2')).toHaveTextContent('Looks right');
        fireEvent.click(document.getElementById('header-publish')!);
        await waitFor(() => expect(writesTo('/publish')).toEqual([{ versionId: 'v2' }]));
    });

    it('the editor says what the revision flow is', async () => {
        serve(policyFixture({ status: 'PUBLISHED', currentVersion: v1, versions: [v1], approvals: [v1.approvals[0]] }));
        await renderPage();
        openTab(EN.detail.tabEditor);
        expect(screen.getByText(EN.detail.liveEditProposalNotice)).toBeInTheDocument();
    });

    it('an APPROVED policy is not called live: its editor notice says the approved version stays publishable', async () => {
        serve(policyFixture({ status: 'APPROVED', currentVersion: v1, versions: [v1], approvals: [v1.approvals[0]] }));
        await renderPage();
        openTab(EN.detail.tabEditor);
        expect(screen.getByText(EN.detail.approvedEditNotice)).toBeInTheDocument();
        expect(screen.queryByText(EN.detail.liveEditProposalNotice)).not.toBeInTheDocument();
    });
});

describe('status and errors', () => {
    it('the header shows the status label, not the raw enum', async () => {
        const v1 = version(1, 'one');
        serve(policyFixture({ status: 'IN_REVIEW', currentVersion: v1, versions: [v1] }));
        await renderPage();
        expect(screen.getByText(EN.filterEnums.status.inReview)).toBeInTheDocument();
        expect(screen.queryByText('IN_REVIEW')).not.toBeInTheDocument();
    });

    it('a refused action shows the server\'s message, not "[object Object]"', async () => {
        serve(EDITED_DRAFT, () =>
            json({ error: { code: 'CONFLICT', message: 'This policy already has an approval request awaiting a decision.' } }, 409),
        );
        await renderPage();
        fireEvent.click(document.getElementById('header-request-approval')!);
        expect(
            await screen.findByText('This policy already has an approval request awaiting a decision.'),
        ).toBeInTheDocument();
        expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    });

    it('a refused review-schedule save says why and keeps the form open', async () => {
        serve(EDITED_DRAFT, () => json({ error: { code: 'BAD_REQUEST', message: 'Next review must be in the future.' } }, 400));
        await renderPage();
        fireEvent.click(screen.getByText(EN.detail.editReviewSchedule));
        fireEvent.click(screen.getByRole('button', { name: EN.detail.save }));
        expect(await screen.findByText('Next review must be in the future.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: EN.detail.save })).toBeInTheDocument();
    });
});

describe('archiving says what it does (#4279)', () => {
    it('the archive confirmation states only what archiving does', async () => {
        // It used to say the policy is "withdrawn from the library and cannot
        // be edited, reviewed or published" — it stays on the list, and its
        // owner and details stay editable.
        const v1 = version(1, 'one');
        serve(policyFixture({ status: 'PUBLISHED', currentVersion: v1, versions: [v1] }));
        await renderPage();
        fireEvent.click(document.getElementById('archive-btn')!);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(EN.detail.archiveConfirmBody);
        expect(dialog).toHaveTextContent(/stays on the list as Archived/);
        expect(dialog).not.toHaveTextContent(/withdrawn|cannot be edited/i);
    });

    it('an archived policy offers no Mark reviewed (the server refuses it)', async () => {
        const v1 = version(1, 'one');
        serve(policyFixture({ status: 'ARCHIVED', currentVersion: v1, versions: [v1], nextReviewAt: '2026-01-01T00:00:00.000Z' }));
        await renderPage();
        expect(screen.getByText(EN.detail.editReviewSchedule)).toBeInTheDocument();
        expect(document.getElementById('mark-reviewed-btn')).toBeNull();
    });
});
