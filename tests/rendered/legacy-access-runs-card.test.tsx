/**
 * Reading a legacy application's accounts and matching them to people, from
 * the application's connection page.
 *
 * Each button must send exactly the body its route takes, say that its
 * background job started and where the result appears, show every outcome by
 * NAME (never a generic "failed"), hold itself while its request is in flight,
 * and offer nothing to a viewer without `admin.manage`, the key both routes
 * and the standing read take.
 *
 * Copy is read from the real `messages/en.json` through a local `next-intl`
 * mock that also evaluates the flat ICU plurals the card uses, so a count is
 * asserted as the sentence a person reads rather than as its template.
 */
import * as React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (params: Record<string, unknown> | undefined, name: string) =>
        !!params && Object.prototype.hasOwnProperty.call(params, name);
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!has(params, name)) return block;
                const n = Number(params![name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            return typeof val === 'string' ? format(val, params) : key;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

const permissions = { manage: true };
// Stable across renders, as the real hooks are (`useCallback` on the slug): a
// fresh function per render would re-run every effect that depends on one.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        usePermissions: () => ({ admin: { manage: permissions.manage } }),
    };
});

import {
    LegacyAccessRunsCard,
    MATCH_REASON_CODES,
    PULL_REASON_CODES,
    type LegacyExecutionRow,
} from '@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/LegacyAccessRunsCard';

const EN = jest.requireActual('../../messages/en.json').admin.integrations.legacyRuns;
const BG = jest.requireActual('../../messages/bg.json').admin.integrations.legacyRuns;

const fill = (s: string, params: Record<string, string | number>) =>
    s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));

// ─── Server double ─────────────────────────────────────────────────────────

type Answer = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

interface Call { url: string; method: string; body: unknown; contentType: string | null }

let calls: Call[] = [];
let provider = 'legacy-mcp';
let standingAnswer: Answer;
let pullAnswer: Answer;
let reconcileAnswer: Answer;
const realFetch = global.fetch;

const COMPLETE_STANDING = {
    id: 'snap_1',
    status: 'COMPLETE',
    pulledAt: '2026-10-28T08:00:00.000Z',
    completedAt: '2026-10-28T08:05:00.000Z',
    rowCount: 42,
    rowsReceived: 42,
    refusalReason: null,
    refusalDetail: null,
    populationCoverage: 'UNKNOWN',
    reconciliation: {
        executionId: 'exec_rec_1',
        status: 'PASSED',
        completedAt: '2026-10-28T09:00:00.000Z',
        resolved: 40,
        byOutcome: { LINKED: 30, SUGGESTED: 5, AMBIGUOUS: 2, UNMATCHED: 2, NON_PERSON: 1 },
    },
};

const standing = (over: Record<string, unknown> = {}) => ({
    status: 200,
    body: { snapshot: { ...COMPLETE_STANDING, ...over } },
});

beforeEach(() => {
    calls = [];
    provider = 'legacy-mcp';
    permissions.manage = true;
    standingAnswer = standing();
    pullAnswer = { status: 202, body: { status: 'queued', jobId: 'job-7' } };
    reconcileAnswer = { status: 202, body: { status: 'queued', jobId: 'job-9' } };
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
            url,
            method,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            contentType: headers['content-type'] ?? null,
        });
        const reply = async (a: Answer) => {
            const { status, body } = await a;
            return { ok: status >= 200 && status < 300, status, json: async () => body };
        };
        if (url === '/api/t/acme/admin/integrations') {
            return reply({ status: 200, body: [{ id: 'conn_1', provider }] });
        }
        if (url.startsWith('/api/t/acme/admin/legacy-access/snapshot')) return reply(standingAnswer);
        if (url === '/api/t/acme/admin/legacy-access/pull') return reply(pullAnswer);
        if (url === '/api/t/acme/admin/legacy-access/reconcile') return reply(reconcileAnswer);
        return reply({ status: 404, body: { error: { message: `unexpected ${url}` } } });
    }) as unknown as typeof fetch;
});

afterEach(() => {
    global.fetch = realFetch;
});

const run = (over: Partial<LegacyExecutionRow>): LegacyExecutionRow => ({
    id: `exec_${Math.random().toString(36).slice(2, 8)}`,
    automationKey: 'legacy-mcp.pull',
    status: 'PASSED',
    errorMessage: null,
    executedAt: '2026-10-28T08:00:00.000Z',
    completedAt: '2026-10-28T08:05:00.000Z',
    ...over,
});

function renderCard(runs: LegacyExecutionRow[] = [], onReloadRuns = jest.fn()) {
    const view = render(
        <LegacyAccessRunsCard
            connectionId="conn_1"
            runs={runs}
            runsLoading={false}
            runsError={false}
            onReloadRuns={onReloadRuns}
        />,
    );
    return { ...view, onReloadRuns };
}

const posts = () => calls.filter((c) => c.method === 'POST');
const standingReads = () => calls.filter((c) => c.url.startsWith('/api/t/acme/admin/legacy-access/snapshot'));

async function ready() {
    await waitFor(() => expect(screen.getByTestId('legacy-snapshot-standing')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(EN.standingLoading)).not.toBeInTheDocument());
}

const readButton = () => screen.getByRole('button', { name: EN.readButton });
const matchButton = () => screen.getByRole('button', { name: EN.matchButton });

// ─── Read accounts ────────────────────────────────────────────────────────

describe('Read accounts', () => {
    it('posts exactly { connectionId } to the pull route, as JSON', async () => {
        renderCard();
        await ready();

        fireEvent.click(readButton());

        await waitFor(() => expect(posts()).toHaveLength(1));
        expect(posts()[0]).toEqual({
            url: '/api/t/acme/admin/legacy-access/pull',
            method: 'POST',
            body: { connectionId: 'conn_1' },
            contentType: 'application/json',
        });
    });

    it('says the job started, names it, and says where its result appears; then reloads both reads', async () => {
        const { onReloadRuns } = renderCard();
        await ready();
        const readsBefore = standingReads().length;

        fireEvent.click(readButton());

        expect(await screen.findByText(fill(EN.readStarted, { jobId: 'job-7' }))).toBeInTheDocument();
        await waitFor(() => expect(onReloadRuns).toHaveBeenCalledTimes(1));
        expect(standingReads().length).toBe(readsBefore + 1);
    });

    it('is held, and holds the other button, while its request is in flight', async () => {
        let release!: (a: { status: number; body: unknown }) => void;
        pullAnswer = new Promise((resolve) => { release = resolve; });
        renderCard();
        await ready();

        fireEvent.click(readButton());

        await waitFor(() => expect(readButton()).toBeDisabled());
        expect(matchButton()).toBeDisabled();
        fireEvent.click(readButton());
        expect(posts()).toHaveLength(1);

        release({ status: 202, body: { status: 'queued', jobId: 'job-7' } });
        await waitFor(() => expect(readButton()).toBeEnabled());
        expect(matchButton()).toBeEnabled();
    });

    it('a refused start shows the server\'s own reason, not a generic failure', async () => {
        pullAnswer = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Legacy access connection not found' } } };
        renderCard();
        await ready();

        fireEvent.click(readButton());

        expect(await screen.findByText(fill(EN.startFailed, { reason: 'Legacy access connection not found' })))
            .toBeInTheDocument();
    });
});

// ─── Match to people ──────────────────────────────────────────────────────

describe('Match to people', () => {
    it('posts exactly { snapshotId } of the snapshot the standing read named', async () => {
        renderCard();
        await ready();

        fireEvent.click(matchButton());

        await waitFor(() => expect(posts()).toHaveLength(1));
        expect(posts()[0]).toEqual({
            url: '/api/t/acme/admin/legacy-access/reconcile',
            method: 'POST',
            body: { snapshotId: 'snap_1' },
            contentType: 'application/json',
        });
        expect(await screen.findByText(fill(EN.matchStarted, { jobId: 'job-9' }))).toBeInTheDocument();
    });

    it('is held while its request is in flight', async () => {
        let release!: (a: { status: number; body: unknown }) => void;
        reconcileAnswer = new Promise((resolve) => { release = resolve; });
        renderCard();
        await ready();

        fireEvent.click(matchButton());

        await waitFor(() => expect(matchButton()).toBeDisabled());
        expect(readButton()).toBeDisabled();
        release({ status: 202, body: { status: 'queued', jobId: 'job-9' } });
        await waitFor(() => expect(matchButton()).toBeEnabled());
    });

    it.each([
        ['no read at all', { status: 200, body: { snapshot: null } }, EN.matchNeedsRead],
        ['a read that is not complete', standing({ status: 'PARTIAL', refusalReason: 'TORN_SNAPSHOT', rowCount: 0, reconciliation: null }), EN.matchNeedsComplete],
        ['a read still in progress', standing({ status: 'PENDING', completedAt: null, rowCount: 0, reconciliation: null }), EN.matchNeedsComplete],
        ['a complete read of no accounts', standing({ rowCount: 0, reconciliation: null }), EN.matchNeedsAccounts],
        ['a standing read that failed', { status: 500, body: { error: { message: 'boom' } } }, EN.matchNeedsStanding],
    ])('cannot be pressed over %s, and says why', async (_label, answer, reason) => {
        standingAnswer = answer;
        renderCard();
        await ready();

        // The platform's disabled-with-a-reason shape: still announced as the
        // button it looks like, not a <button>, and described by the reason.
        const blocked = matchButton();
        expect(blocked.tagName).not.toBe('BUTTON');
        expect(blocked).toHaveAttribute('aria-disabled', 'true');
        expect(blocked).toHaveAccessibleDescription(reason);
        expect(screen.getByTestId('legacy-match-blocked')).toHaveTextContent(reason);

        fireEvent.click(blocked);
        expect(posts()).toHaveLength(0);
        // Reading stays available: it is how each of these is put right.
        expect(readButton()).toBeEnabled();
    });
});

// ─── The permission gate ──────────────────────────────────────────────────

describe('the admin.manage gate (both routes, and every read the card makes, take it)', () => {
    it('without the key: no card, no button, and not one request', async () => {
        permissions.manage = false;
        const { container } = renderCard([run({ status: 'PARTIAL', errorMessage: 'TORN_SNAPSHOT' })]);

        // Give any effect that would fetch the chance to run.
        await new Promise((r) => setTimeout(r, 20));
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByRole('button', { name: EN.readButton })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: EN.matchButton })).not.toBeInTheDocument();
        expect(calls).toEqual([]);
    });

    it('with the key, both buttons are live', async () => {
        renderCard();
        await ready();
        expect(readButton()).toBeEnabled();
        expect(matchButton()).toBeEnabled();
        expect(readButton().tagName).toBe('BUTTON');
        expect(matchButton().tagName).toBe('BUTTON');
    });
});

// ─── The latest snapshot's standing ───────────────────────────────────────

describe('the latest read', () => {
    it('shows complete, the account count, coverage unverified, and the matching counts with a way to the queue', async () => {
        renderCard();
        await ready();
        const panel = screen.getByTestId('legacy-snapshot-standing');

        expect(within(panel).getByText(EN.snapshotCOMPLETE)).toBeInTheDocument();
        expect(within(panel).getByText('42 accounts')).toBeInTheDocument();
        expect(within(panel).getByText(EN.coverageUNKNOWN)).toBeInTheDocument();
        expect(within(panel).getByText(EN.coverageUNKNOWNHelp)).toBeInTheDocument();
        expect(within(panel).getByText(
            '40 accounts: 30 linked, 5 suggested, 2 ambiguous, 2 unmatched, 1 not a person',
        )).toBeInTheDocument();
        expect(within(panel).getByRole('link', { name: EN.openQueue }))
            .toHaveAttribute('href', '/t/acme/admin/integrations/conn_1/reconciliation');
        expect(within(panel).queryByText(EN.notMatched)).not.toBeInTheDocument();
    });

    it('a refused read names its reason, says what it was, and how many rows were received', async () => {
        standingAnswer = standing({
            status: 'PARTIAL', refusalReason: 'OVERSHARED_DENIED_COLUMN',
            refusalDetail: 'the server returned PASSWORD_HASH despite a projection that excluded it',
            rowCount: 0, rowsReceived: 250, reconciliation: null,
        });
        renderCard();
        await ready();
        const panel = screen.getByTestId('legacy-snapshot-standing');

        expect(within(panel).getByText(EN.snapshotPARTIAL)).toBeInTheDocument();
        expect(within(panel).getByText('OVERSHARED_DENIED_COLUMN')).toBeInTheDocument();
        expect(within(panel).getByText(EN.pullReason.OVERSHARED_DENIED_COLUMN, { exact: false })).toBeInTheDocument();
        expect(within(panel).getByText(/returned PASSWORD_HASH despite/)).toBeInTheDocument();
        expect(within(panel).getByText('250 rows were received, and none were kept.')).toBeInTheDocument();
        expect(within(panel).getByText(EN.notMatched)).toBeInTheDocument();
    });

    it('a connection that was never read says so', async () => {
        standingAnswer = { status: 200, body: { snapshot: null } };
        renderCard();
        await ready();
        expect(within(screen.getByTestId('legacy-snapshot-standing')).getByText(EN.neverRead)).toBeInTheDocument();
    });

    it('a standing read the server refused shows the server\'s reason', async () => {
        standingAnswer = { status: 500, body: { error: { message: 'database unavailable' } } };
        renderCard();
        await ready();
        expect(screen.getByText(fill(EN.standingLoadFailed, { reason: 'database unavailable' }))).toBeInTheDocument();
    });
});

// ─── Each run's outcome, by name ──────────────────────────────────────────

describe('Last read: every outcome is shown by name', () => {
    const lastRead = () => screen.getByTestId('legacy-read-action');

    it.each(PULL_REASON_CODES)('a refusal %s shows its sentence and its code', async (code) => {
        renderCard([run({ status: 'PARTIAL', errorMessage: code })]);
        await ready();

        expect(within(lastRead()).getByText(EN.pullRun.PARTIAL)).toBeInTheDocument();
        expect(within(lastRead()).getByText(code)).toBeInTheDocument();
        expect(within(lastRead()).getByText(EN.pullReason[code], { exact: false })).toBeInTheDocument();
    });

    it('a code this build does not know is still shown by name', async () => {
        renderCard([run({ status: 'PARTIAL', errorMessage: 'SOMETHING_ADDED_LATER' })]);
        await ready();
        expect(within(lastRead()).getByText('SOMETHING_ADDED_LATER')).toBeInTheDocument();
    });

    it('an error shows its message as written', async () => {
        renderCard([run({ status: 'ERROR', errorMessage: 'No legacy access mapping is saved for this connection' })]);
        await ready();
        expect(within(lastRead()).getByText(EN.pullRun.ERROR)).toBeInTheDocument();
        expect(within(lastRead()).getByText('No legacy access mapping is saved for this connection')).toBeInTheDocument();
    });

    it.each([
        ['PASSED', EN.pullRun.PASSED],
        ['RUNNING', EN.pullRun.RUNNING],
    ])('%s is shown as its own state', async (status, label) => {
        renderCard([run({ status })]);
        await ready();
        expect(within(lastRead()).getByText(label)).toBeInTheDocument();
    });

    it('a complete read of an empty table says the application reported no accounts', async () => {
        renderCard([run({ status: 'NOT_APPLICABLE' })]);
        await ready();
        expect(within(lastRead()).getByText(EN.pullRun.NOT_APPLICABLE)).toBeInTheDocument();
        expect(within(lastRead()).getByText(EN.pullNoAccounts)).toBeInTheDocument();
    });

    it('reads the NEWEST pull row, not the first, and never a match row', async () => {
        renderCard([
            run({ status: 'PASSED', executedAt: '2026-10-27T08:00:00.000Z' }),
            run({ automationKey: 'legacy-mcp.reconcile', status: 'ERROR', errorMessage: 'not mine', executedAt: '2026-10-29T08:00:00.000Z' }),
            run({ status: 'PARTIAL', errorMessage: 'CAP_EXCEEDED', executedAt: '2026-10-28T08:00:00.000Z' }),
        ]);
        await ready();
        expect(within(lastRead()).getByText('CAP_EXCEEDED')).toBeInTheDocument();
        expect(within(lastRead()).queryByText(EN.pullRun.PASSED)).not.toBeInTheDocument();
        expect(within(lastRead()).queryByText('not mine')).not.toBeInTheDocument();
    });

    it('with no run, says so', async () => {
        renderCard([]);
        await ready();
        expect(within(lastRead()).getByText(EN.notRunYet)).toBeInTheDocument();
    });
});

describe('Last match: every outcome is shown by name', () => {
    const lastMatch = () => screen.getByTestId('legacy-match-action');
    const match = (over: Partial<LegacyExecutionRow>) => run({ automationKey: 'legacy-mcp.reconcile', ...over });

    it.each(MATCH_REASON_CODES)('a refusal %s shows its sentence and its code', async (code) => {
        renderCard([match({ status: 'PARTIAL', errorMessage: code })]);
        await ready();

        expect(within(lastMatch()).getByText(EN.matchRun.PARTIAL)).toBeInTheDocument();
        expect(within(lastMatch()).getByText(code)).toBeInTheDocument();
        expect(within(lastMatch()).getByText(EN.matchReason[code], { exact: false })).toBeInTheDocument();
    });

    it('a run that matched the latest read is shown as matched', async () => {
        renderCard([match({ id: 'exec_rec_1', status: 'PASSED' })]);
        await ready();
        expect(within(lastMatch()).getByText(EN.matchRun.PASSED)).toBeInTheDocument();
        expect(within(lastMatch()).queryByText(EN.matchedEarlierRead)).not.toBeInTheDocument();
    });

    it('a run that matched an EARLIER read says so', async () => {
        renderCard([match({ id: 'exec_rec_old', status: 'PASSED' })]);
        await ready();
        expect(within(lastMatch()).getByText(EN.matchedEarlierRead)).toBeInTheDocument();
    });

    it('an error shows its message as written', async () => {
        renderCard([match({ status: 'ERROR', errorMessage: 'resolution count disagreed with the write' })]);
        await ready();
        expect(within(lastMatch()).getByText('resolution count disagreed with the write')).toBeInTheDocument();
    });
});

// ─── Scope and copy ───────────────────────────────────────────────────────

describe('scope and copy', () => {
    it('renders nothing, and reads nothing, for a connection that is not a legacy one', async () => {
        provider = 'entra-id';
        const { container } = renderCard();
        await waitFor(() => expect(calls.some((c) => c.url === '/api/t/acme/admin/integrations')).toBe(true));
        await waitFor(() => expect(container).toBeEmptyDOMElement());
        expect(standingReads()).toHaveLength(0);
    });

    it('every reason code has a sentence in BOTH catalogues', () => {
        for (const code of PULL_REASON_CODES) {
            expect({ code, en: typeof EN.pullReason[code], bg: typeof BG.pullReason[code] })
                .toEqual({ code, en: 'string', bg: 'string' });
        }
        for (const code of MATCH_REASON_CODES) {
            expect({ code, en: typeof EN.matchReason[code], bg: typeof BG.matchReason[code] })
                .toEqual({ code, en: 'string', bg: 'string' });
        }
    });

    it('no user-facing string names the transport', () => {
        const strings = (o: unknown): string[] =>
            typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : [];
        // Every offender at once, rather than the first.
        expect([...strings(EN), ...strings(BG)].filter((s) => /\bMCP\b/.test(s))).toEqual([]);
    });
});
