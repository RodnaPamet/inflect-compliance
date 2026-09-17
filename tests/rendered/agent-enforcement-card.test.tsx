/**
 * THE ENFORCEMENT CARD NAMES THE CREDENTIALS IN BOTH DIRECTIONS (#2565).
 *
 * The card has always held the names. `previewAgentEnforcement` returns
 * `breaking` as NAMED rows — `{ id, name, keyPrefix, lastUsedAt }` — and the
 * card destructures them once for the whole render. Only the OFF branch
 * listed them; the ON branch fell back to "…{count} credential(s) are not
 * bound…" two lines away from the array it was counting.
 *
 * That is the same defect as the register banner's, on the other branch of the
 * same condition: an operator told "3 credentials are being refused" learns
 * that something stopped and not WHICH integration, so the next move is to open
 * `/admin/api-keys` and compare rows by hand.
 *
 * Three claims, and the third is the one that keeps the fix honest:
 *
 *   1. ENFORCING with unbound credentials — the names render, under a
 *      PRESENT-tense header. `wouldBreak` is future tense and is a false
 *      sentence about credentials already being refused.
 *   2. ENFORCING with nothing unbound — no list at all. A list that always
 *      rendered would satisfy claim 1 while telling a clean tenant it has work.
 *   3. NOT ENFORCING — the pre-flight list is UNCHANGED. Extracting the shared
 *      `<ul>` into one component is the kind of tidy that quietly drops a
 *      branch, and this is the assertion that says the old branch survived.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

// Mounting the card pulls in the modal/form stack behind the confirm dialog.
jest.setTimeout(180_000);

// Resolved against the real en.json, so every assertion reads the copy the
// operator reads rather than a dotted key path — next-intl renders a MISSING
// key as its own path, so a path assertion passes only while the catalogue is
// incomplete. `{param}` substitution only; no ICU expansion is needed here
// because the two headers this file reads use a bare `{count}`.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            ns.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en,
            ) as Record<string, unknown>,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// The confirm modal's root calls `useRouter` on every render — it is mounted
// (closed) alongside the card, not lazily — and `next/navigation` throws
// outside an app-router tree.
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/admin/security',
    useSearchParams: () => new URLSearchParams(),
}));

// `useTenantApiUrl` throws outside a `<TenantProvider>`; the card uses it only
// to build the two request URLs, both of which the fetch stub below answers.
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { AgentEnforcementCard } from '@/app/t/[tenantSlug]/(app)/admin/security/AgentEnforcementCard';

const EN = (
    require('../../messages/en.json') as {
        admin: { security: { agentEnforcement: Record<string, string> } };
    }
).admin.security.agentEnforcement;

interface Breaking {
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt: string | null;
}

const NIGHTLY: Breaking = {
    id: 'k1',
    name: 'Nightly sync',
    keyPrefix: 'ik_live_ab12',
    lastUsedAt: null,
};
const ZAPIER: Breaking = {
    id: 'k2',
    name: 'Zapier relay',
    keyPrefix: 'ik_live_cd34',
    lastUsedAt: null,
};

/** The card fetches its own pre-flight on mount; this is the only request. */
function stubPreflight(payload: { enforcing: boolean; breaking: Breaking[] }): void {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => payload,
    })) as unknown as typeof fetch;
}

async function mountCard(payload: {
    enforcing: boolean;
    breaking: Breaking[];
}): Promise<HTMLElement> {
    stubPreflight(payload);
    render(<AgentEnforcementCard tenantSlug="acme" />);
    // The state paragraph only appears once the pre-flight has resolved, so
    // awaiting it is what makes every assertion below one about a LOADED card
    // rather than about a card that had not answered yet.
    await screen.findByTestId('agent-enforcement-state');
    return screen.getByTestId('agent-enforcement-card');
}

/** The named rows of one list, as `name keyPrefix…` strings. */
function rowsOf(card: HTMLElement, testId: string): string[] {
    const list = card.querySelector(`[data-testid="${testId}"]`);
    if (list === null) return [];
    return Array.from(list.querySelectorAll('li')).map((li) => li.textContent ?? '');
}

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('ENFORCING, with credentials still unbound', () => {
    it('NAMES them, by name and key prefix, in a present-tense block', async () => {
        const card = await mountCard({ enforcing: true, breaking: [NIGHTLY, ZAPIER] });
        // EXACT rows. `not.toBeNull()` on the list would pass for an empty one,
        // and an empty list is the defect wearing the fix's markup.
        expect(rowsOf(card, 'agent-enforcement-refused-now')).toEqual([
            'Nightly sync ik_live_ab12…',
            'Zapier relay ik_live_cd34…',
        ]);
        // The header is the PRESENT tense one. The pre-flight's `wouldBreak`
        // says "would stop working the moment enforcement is switched on",
        // which is false about credentials already being refused.
        expect(within(card).getByText(EN.breakingNow.replace('{count}', '2'))).toBeTruthy();
        // …and the future-tense list is not also here. Both rendering at once
        // would satisfy the row assertion above while contradicting itself.
        expect(rowsOf(card, 'agent-enforcement-breaking')).toEqual([]);
    });

    it('still says HOW MANY as well as which', async () => {
        // The names are an addition to the count sentence, not a replacement:
        // the count is what tells an operator the list is the whole list.
        const card = await mountCard({ enforcing: true, breaking: [NIGHTLY, ZAPIER] });
        expect(within(card).getByTestId('agent-enforcement-state').textContent).toBe(
            EN.enforcingWithUnbound.replace('{count}', '2'),
        );
    });
});

describe('ENFORCING, with nothing unbound', () => {
    it('renders no credential list at all', async () => {
        const card = await mountCard({ enforcing: true, breaking: [] });
        // The paired negative for the block above. Without it, a list that
        // rendered unconditionally would pass every assertion in this file and
        // tell a clean tenant it has credentials to bind.
        expect(card.querySelector('[data-testid="agent-enforcement-refused-now"]')).toBeNull();
        expect(within(card).getByTestId('agent-enforcement-state').textContent).toBe(
            EN.enforcingClean,
        );
    });
});

describe('NOT ENFORCING — the pre-flight list is unchanged', () => {
    it('still lists the credentials that WOULD break, by name', async () => {
        // The positive control for the shared-component extraction: the branch
        // that already worked has to keep working, and it is the one a tidy-up
        // is most likely to drop on the way past.
        const card = await mountCard({ enforcing: false, breaking: [NIGHTLY, ZAPIER] });
        expect(rowsOf(card, 'agent-enforcement-breaking')).toEqual([
            'Nightly sync ik_live_ab12…',
            'Zapier relay ik_live_cd34…',
        ]);
        // And the present-tense block is absent: with the gate off, nothing is
        // being refused, so saying so would be a false sentence.
        expect(rowsOf(card, 'agent-enforcement-refused-now')).toEqual([]);
    });
});
