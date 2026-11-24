/**
 * A FOUR-EYES REFUSAL REACHES A BULGARIAN REVIEWER IN BULGARIAN (#5919).
 *
 * The database's four-eyes rules refuse an approval with an English sentence
 * built in `fourEyesRefusal`. The queue words a refusal in the reader's
 * language only when `proposalRefusalKey` knows its `details.reason`, and every
 * rule used to share the one reason `agent_proposal_four_eyes`, which it could
 * not map — so the agent's owner pressing Approve on a Bulgarian page read
 * "This proposal needs two independent approvers…" in English.
 *
 * The response bodies below are the server's own shape: the English sentence
 * as `message`, the rule's reason in `details`. The page must show the
 * Bulgarian message, and none of the English one.
 */
import * as React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';

// The Bulgarian catalogue. `mock`-prefixed so the hoisted factory may read it.
const mockBg: Record<string, unknown> = require('../../messages/bg.json');
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const lookup = (key: string) => walk(mockBg, ns ? `${ns}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = lookup(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = t;
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'bg',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/proposals',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useMediaQuery: () => ({ device: 'desktop', width: 1280, height: 800, isMobile: false, isDesktop: true }),
        useToast: () => ({ error: jest.fn(), success: jest.fn(), warning: jest.fn(), info: jest.fn() }),
        useToastWithUndo: () => (input: { action: () => Promise<unknown>; onError?: (e: unknown) => void }) => {
            void Promise.resolve()
                .then(() => input.action())
                .catch((e) => input.onError?.(e));
            return 'undo-toast';
        },
    };
});

import {
    AgentProposalsClient,
    type ProposalRow,
} from '@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';

function bg(path: string): string {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        mockBg,
    );
    if (typeof v !== 'string') throw new Error(`no bg message ${path}`);
    return v;
}

function row(): ProposalRow {
    return {
        id: 'p1',
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        targetEntityId: null,
        rationale: null,
        proposedViaKeyId: null,
        proposedViaKeyPrefix: null,
        createdAt: '2026-10-29T10:00:00.000Z',
        expiresAt: '2026-11-05T10:00:00.000Z',
        windowClosed: false,
        approvalsRecorded: 0,
        signedByViewer: false,
        viewerMayApprove: true,
        runId: null,
        stepSeq: null,
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:0123456789abcdef',
        diff: computeProposalDiff({
            operation: 'CREATE',
            payloadJson: JSON.stringify({ title: 'Backup failure risk', treatmentNotes: 'Add a second site.' }),
        }),
    };
}

async function approveRefusedWith(message: string, reason: string): Promise<HTMLElement> {
    global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { code: 'FORBIDDEN', message, details: { reason } } }),
    }) as unknown as typeof fetch;
    render(<AgentProposalsClient tenantSlug="acme" initialProposals={[row()]} canOperate />);
    await act(async () => {
        screen.getByTestId('proposal-approve-p1').click();
    });
    return screen.getByTestId('proposal-action-error');
}

afterEach(() => {
    cleanup();
    jest.clearAllMocks();
});

describe('a four-eyes refusal on a Bulgarian page', () => {
    it('the agent’s owner is told in Bulgarian that somebody else has to sign', async () => {
        const english =
            'This proposal needs two independent approvers, and you are the ' +
            'registered owner of the agent that made it. Someone else has to sign.';
        const error = await approveRefusedWith(english, 'agent_proposal_four_eyes_owner');
        expect(error).toHaveTextContent(bg('agents.proposals.refused.fourEyesOwner'));
        expect(error.textContent).not.toContain('registered owner');
        expect(error.textContent).not.toMatch(/[A-Za-z]{4,}/);
    });

    it('a second click by the first approver is told in Bulgarian', async () => {
        const english =
            'You have already approved this proposal. A second approval has to come from a different person.';
        const error = await approveRefusedWith(english, 'agent_proposal_four_eyes_already_signed');
        expect(error).toHaveTextContent(bg('agents.proposals.refused.fourEyesAlreadySigned'));
        expect(error.textContent).not.toMatch(/[A-Za-z]{4,}/);
    });

    it('a proposal the database cannot see is "not found", never worded as the owner refusal', async () => {
        const error = await approveRefusedWith('Proposal not found.', 'agent_proposal_four_eyes_not_found');
        expect(error).toHaveTextContent(bg('agents.proposals.refused.fourEyesNotFound'));
        expect(error.textContent).not.toContain(bg('agents.proposals.refused.fourEyesOwner'));
        expect(error.textContent).not.toMatch(/[A-Za-z]{4,}/);
    });
});
