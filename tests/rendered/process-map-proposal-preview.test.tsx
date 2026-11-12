/**
 * A process-map proposal is reviewed as its steps and arrows (#5053).
 *
 * The queue renders the map the server previewed: every step numbered with its
 * label, every arrow named by the numbers and labels of its two ends, the notes,
 * and the sentence saying what approval creates. That list is the record, so it
 * is asserted here as text inside the card's diff, with the approve control a
 * descendant of it. The picture under it is the process canvas, loaded with
 * `next/dynamic`; it is replaced by a stub here (the real one is mounted in
 * `proposed-process-map-canvas.test.tsx`), so this file can show it arrives
 * lazily, after the list, and that a canvas that throws leaves the list whole.
 */
import * as React from 'react';
import { render, screen, within, act, cleanup } from '@testing-library/react';

// Read by the `next/dynamic` spy below; `mock` prefix so the hoisted factory may
// reach it.
const mockDynamicCalls: Array<{ loader: () => Promise<unknown>; opts: Record<string, unknown> }> = [];
const mockCanvas = jest.fn();

jest.mock('next/dynamic', () => {
    const actual = jest.requireActual('next/dynamic');
    const real = (actual.default ?? actual) as (loader: unknown, opts: unknown) => unknown;
    return {
        __esModule: true,
        default: (loader: () => Promise<unknown>, opts: Record<string, unknown>) => {
            mockDynamicCalls.push({ loader, opts });
            return real(loader, opts);
        },
    };
});

jest.mock('@/components/processes/ProposedProcessMapCanvas', () => ({
    ProposedProcessMapCanvas: (props: unknown) => mockCanvas(props),
}));

// ICU plurals, which the shared mock does not do, because the counts line uses
// them: `{steps, plural, one {# step} other {# steps}}`.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const plural = (s: string, values: Record<string, unknown>) =>
        s.replace(/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g, (_m, name, one, other) => {
            const n = Number(values[name]);
            return (n === 1 ? one : other).replace(/#/g, String(n));
        });
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = key
                .split('.')
                .reduce<unknown>(
                    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                    en[ns],
                );
            if (typeof v !== 'string') return key;
            if (!params) return v;
            return plural(v, params).replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
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

import {
    AgentProposalsClient,
    type ProposalRow,
} from '@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';
import {
    buildProcessMapPreview,
    canonicaliseProposedProcessMap,
    ProposedProcessMapSchema,
    type ProcessMapPreview,
} from '@/lib/agentic/process-map-proposal';

function en(dotted: string): string {
    const messages = require('../../messages/en.json') as Record<string, unknown>;
    const value = `agents.${dotted}`
        .split('.')
        .reduce<unknown>(
            (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
            messages,
        );
    if (typeof value !== 'string') throw new Error(`messages/en.json has no string at agents.${dotted}`);
    return value;
}

const INJECTED = '<img src=x onerror="alert(1)">';

/**
 * A map through the REAL schema, canonicaliser and preview builder, with
 * boxes standing in for the server layout (which runs on the server only).
 * Step 4 is a decision with one way out; step 5 touches no arrow.
 */
function previewOf(): ProcessMapPreview {
    const map = canonicaliseProposedProcessMap(
        ProposedProcessMapSchema.parse({
            name: 'Supplier onboarding',
            description: 'From request to an approved supplier.',
            nodes: [
                { nodeKey: 'request', label: 'Receive the request', subtitle: 'Procurement' },
                { nodeKey: 'collect', label: 'Collect evidence' },
                { nodeKey: 'risky', nodeType: 'decision', label: 'High risk?' },
                { nodeKey: 'review', nodeType: 'decision', label: INJECTED },
                { nodeKey: 'archive', label: 'Archive the file' },
            ],
            edges: [
                { sourceKey: 'request', targetKey: 'collect' },
                { sourceKey: 'collect', targetKey: 'risky' },
                { sourceKey: 'risky', targetKey: 'review', labelOverride: 'Yes' },
                { sourceKey: 'risky', targetKey: 'request', labelOverride: 'No' },
            ],
        }),
    );
    const boxes = Object.fromEntries(
        map.nodes.map((n, i) => [n.nodeKey, { x: 32 + i * 300, y: 32, w: 220, h: 88 }]),
    );
    return buildProcessMapPreview(map, boxes);
}

function processMapRow(overrides: Partial<ProposalRow> = {}): ProposalRow {
    const preview = previewOf();
    return {
        id: 'pm1',
        kind: 'PROCESS_MAP',
        operation: 'CREATE',
        status: 'PENDING',
        targetEntityId: null,
        rationale: null,
        proposedViaKeyId: null,
        proposedViaKeyPrefix: null,
        createdAt: '2026-11-11T10:00:00.000Z',
        expiresAt: null,
        windowClosed: false,
        approvalsRecorded: 0,
        signedByViewer: false,
        viewerMayApprove: true,
        runId: null,
        stepSeq: null,
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:0123456789abcdef',
        // The diff `buildProposalDiffs` sends: CREATE, the name and description
        // as its only fields, and the preview beside them.
        diff: {
            ...computeProposalDiff({
                operation: 'CREATE',
                payloadJson: JSON.stringify({ name: preview.name, description: preview.description }),
            }),
            processMap: preview,
        },
        ...overrides,
    };
}

/** `next/dynamic` resolves on a later tick. */
async function settle() {
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
}

/** Renders the queue and lets the lazily loaded canvas arrive inside `act`. */
async function renderQueue(rows: ProposalRow[]) {
    const result = render(<AgentProposalsClient tenantSlug="acme" initialProposals={rows} canOperate />);
    await settle();
    return result;
}

beforeEach(() => {
    mockCanvas.mockReset();
    mockCanvas.mockImplementation((props: { preview: ProcessMapPreview }) => (
        <div data-testid="mock-canvas" data-steps={props.preview.steps.length} />
    ));
});

afterEach(() => {
    cleanup();
});

describe('the list a reviewer reads', () => {
    it('every step label and every arrow is rendered inside the proposal’s diff', async () => {
        await renderQueue([processMapRow()]);
        const diff = screen.getByTestId('proposal-diff-pm1');
        const preview = previewOf();
        for (const s of preview.steps) {
            const step = within(diff).getByTestId(`proposal-processmap-step-pm1-${s.key}`);
            expect(step).toHaveTextContent(`${s.index}.`);
            expect(step.textContent).toContain(s.label);
        }
        for (const a of preview.arrows) {
            const arrow = within(diff).getByTestId(`proposal-processmap-arrow-pm1-${a.key}`);
            expect(arrow.textContent).toContain(`${a.fromIndex}. ${a.fromLabel}`);
            expect(arrow.textContent).toContain(`${a.toIndex}. ${a.toLabel}`);
            expect(arrow.textContent).toContain('→');
            if (a.label !== null) expect(arrow.textContent).toContain(a.label);
            // What a screen reader hears: the glyph is aria-hidden, and the
            // words standing in for it are spaced from both ends.
            const heard = arrow.cloneNode(true) as HTMLElement;
            heard.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
            const squash = (x: string) => x.replace(/\s+/g, ' ');
            expect(squash(heard.textContent ?? '')).toContain(
                squash(`${a.fromIndex}. ${a.fromLabel} ${en('proposals.processMap.arrowTo')} ${a.toIndex}. ${a.toLabel}`),
            );
        }
        expect(within(diff).getByTestId('proposal-processmap-name-pm1')).toHaveTextContent('Supplier onboarding');
        expect(within(diff).getByTestId('proposal-processmap-counts-pm1')).toHaveTextContent('5 steps · 4 arrows');
        // The subtitle is shown under its step.
        expect(within(diff).getByTestId('proposal-processmap-step-pm1-n1')).toHaveTextContent('Procurement');
        // A decision says it is one.
        expect(within(diff).getByTestId('proposal-processmap-step-pm1-n3')).toHaveTextContent(
            en('proposals.processMap.stepType.decision'),
        );
    });

    it('says what approval creates, and what it does not', async () => {
        await renderQueue([processMapRow()]);
        expect(screen.getByTestId('proposal-processmap-creates-pm1')).toHaveTextContent(
            en('proposals.processMap.createsDraft'),
        );
    });

    it('names the step with no arrows and the decision with one way out', async () => {
        await renderQueue([processMapRow()]);
        const notes = screen.getByTestId('proposal-processmap-notes-pm1');
        expect(notes).toHaveTextContent(en('proposals.processMap.noteIsolated').replace('{step}', '5'));
        expect(notes).toHaveTextContent(en('proposals.processMap.noteDecisionExits').replace('{step}', '4'));
        // Decision 3 has two ways out, so it is not named.
        expect(notes.textContent).not.toContain(en('proposals.processMap.noteDecisionExits').replace('{step}', '3'));
    });

    it('injected markup in a label renders as text', async () => {
        const { container } = await renderQueue([processMapRow()]);
        expect(screen.getByTestId('proposal-processmap-step-pm1-n4').textContent).toContain(INJECTED);
        expect(container.querySelector('img')).toBeNull();
    });

    it('shows no step key, raw message key or JSON', async () => {
        await renderQueue([processMapRow()]);
        const text = screen.getByTestId('proposal-processmap-pm1').textContent ?? '';
        for (const forbidden of ['nodeKey', 'processStep', 'proposals.processMap', '{"', 'plural', 'n1', 'e1']) {
            expect(text).not.toContain(forbidden);
        }
        // The two text fields the diff carries are not listed a second time as
        // a field list beside the map.
        expect(screen.queryByTestId('proposal-diff-content-pm1')).toBeNull();
    });

    it('Approve is a descendant of the rendered diff', async () => {
        await renderQueue([processMapRow()]);
        expect(screen.getByTestId('proposal-diff-pm1')).toContainElement(screen.getByTestId('proposal-approve-pm1'));
    });

    it('Approve is withheld when the server says this viewer may not approve a process map', async () => {
        await renderQueue([processMapRow({ viewerMayApprove: false })]);
        expect(screen.queryByTestId('proposal-approve-pm1')).toBeNull();
        expect(screen.getByTestId('proposal-approve-unavailable-pm1')).toHaveTextContent(
            en('proposals.approveNeedsKindPermission'),
        );
        // The list is still the reviewer's to read, and Reject is still theirs.
        expect(screen.getByTestId('proposal-processmap-steps-pm1')).toBeInTheDocument();
        expect(screen.getByTestId('proposal-reject-pm1')).toBeEnabled();
    });

    it('a one-step map says it has no arrows and names no isolated step', async () => {
        const map = canonicaliseProposedProcessMap(
            ProposedProcessMapSchema.parse({ name: 'One step', nodes: [{ nodeKey: 'a', label: 'Only step' }], edges: [] }),
        );
        const preview = buildProcessMapPreview(map, { n1: { x: 32, y: 32, w: 220, h: 88 } });
        await renderQueue([processMapRow({ diff: { ...processMapRow().diff, processMap: preview } })]);
        expect(screen.getByTestId('proposal-processmap-no-arrows-pm1')).toHaveTextContent(
            en('proposals.processMap.noArrows'),
        );
        expect(screen.queryByTestId('proposal-processmap-notes-pm1')).toBeNull();
        expect(screen.getByTestId('proposal-processmap-counts-pm1')).toHaveTextContent('1 step · 0 arrows');
    });
});

describe('the picture is loaded on demand, and is never the record', () => {
    it('is a next/dynamic import of the canvas module, with ssr off', async () => {
        // Recorded when the preview module was imported: exactly one lazy
        // import, server rendering off, and its loader resolves to the canvas
        // component from the process module, not to anything imported here.
        expect(mockDynamicCalls).toHaveLength(1);
        const [{ loader, opts }] = mockDynamicCalls;
        expect(opts.ssr).toBe(false);
        const loaded = (await loader()) as (props: unknown) => unknown;
        const { ProposedProcessMapCanvas } = jest.requireMock('@/components/processes/ProposedProcessMapCanvas') as {
            ProposedProcessMapCanvas: unknown;
        };
        expect(loaded).toBe(ProposedProcessMapCanvas);
    });

    it('draws the preview the server sent, inside a labelled, inert frame', async () => {
        await renderQueue([processMapRow()]);
        const canvas = await screen.findByTestId('mock-canvas');
        expect(canvas).toHaveAttribute('data-steps', '5');
        expect(mockCanvas.mock.calls[0]![0]).toEqual({ preview: previewOf() });
        const frame = screen.getByTestId('proposal-processmap-canvas-pm1');
        expect(frame).toContainElement(canvas);
        expect(frame).toHaveAttribute('role', 'img');
        expect(frame).toHaveAttribute('aria-label', en('proposals.processMap.canvasLabel'));
        expect(canvas.closest('[inert]')).not.toBeNull();
    });

    it('a canvas that fails is replaced by a sentence assistive technology can reach, and the list is whole', async () => {
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        mockCanvas.mockImplementation(() => {
            throw new Error('the editor could not start');
        });
        try {
            await renderQueue([processMapRow()]);
            await settle();
            const unavailable = await screen.findByTestId('proposal-processmap-canvas-unavailable-pm1');
            expect(unavailable).toHaveTextContent(en('proposals.processMap.canvasUnavailable'));
            // Reachable by assistive technology: not inside an inert subtree,
            // not the presentational child of an image, and the image whose
            // label promised a picture is gone.
            expect(unavailable.closest('[inert]')).toBeNull();
            expect(unavailable.closest('[role="img"]')).toBeNull();
            expect(screen.queryByTestId('proposal-processmap-canvas-pm1')).toBeNull();
            expect(screen.queryByRole('img', { name: en('proposals.processMap.canvasLabel') })).toBeNull();
            expect(screen.getByTestId('proposal-processmap-step-pm1-n2')).toHaveTextContent('Collect evidence');
            expect(screen.getByTestId('proposal-approve-pm1')).toBeEnabled();
        } finally {
            quiet.mockRestore();
        }
    });

    it('no preview, no picture: an ordinary CREATE renders its fields and loads no canvas', async () => {
        const row = processMapRow({
            kind: 'RISK',
            diff: computeProposalDiff({ operation: 'CREATE', payloadJson: JSON.stringify({ title: 'A risk' }) }),
        });
        await renderQueue([row]);
        expect(screen.getByTestId('proposal-diff-content-pm1')).toBeInTheDocument();
        expect(screen.queryByTestId('proposal-processmap-pm1')).toBeNull();
        expect(mockCanvas).not.toHaveBeenCalled();
    });
});
