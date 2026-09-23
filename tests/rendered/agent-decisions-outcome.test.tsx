/**
 * THE ART 14 ANSWER RENDERS, FOR EVERY VALUE THE COLUMN CAN HOLD.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `AiHumanOutcome` is `PENDING | ACCEPTED | EDITED | REJECTED`.
 * `DecisionsClient` carried a four-entry variant map spelling the third one
 * `MODIFIED` — a value the column cannot hold — and `messages/en.json` spelled
 * it the same way. So an EDITED row, which `approveAgentProposal` has always
 * been able to write (it passes its own `'ACCEPTED' | 'EDITED'` status
 * straight through), rendered with the neutral fallback variant and a label
 * that resolved to nothing: the dotted key path, on the one surface an
 * assessor reads to ask "did a person look at this".
 *
 * ── WHY NO EXISTING CHECK SAW IT ────────────────────────────────────────────
 *
 * `i18n-keys-resolve` only follows LITERAL `t('…')` keys and says so in its
 * own docstring — "template-literal lookups … are the ones a rendered test has
 * to cover instead". The lookup here is `t(`decisions.outcome.${outcome}`)`.
 * This is that rendered test.
 *
 * ── THE DENOMINATOR IS READ FROM THE SCHEMA ─────────────────────────────────
 *
 * The population is parsed out of `enums.prisma` rather than typed out here,
 * because a hand-written list of four is exactly what went wrong: it agreed
 * with itself and with nothing else. Adding a fifth member to `AiHumanOutcome`
 * now fails this test until the page and both locales learn it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as React from 'react';
import { render, screen } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values, and return the KEY when a lookup misses — which is what next-intl
// leaves on the screen, and what this suite is here to catch.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
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

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/agents/decisions',
    useSearchParams: () => new URLSearchParams(),
}));

import {
    DecisionsClient,
    type DecisionRow,
} from '@/app/t/[tenantSlug]/(app)/agents/decisions/DecisionsClient';

const ROOT = path.resolve(__dirname, '../..');

/** Every member of the `AiHumanOutcome` enum, from the schema that defines it. */
function outcomeValues(): string[] {
    const src = fs.readFileSync(path.join(ROOT, 'prisma/schema/enums.prisma'), 'utf8');
    const block = /enum AiHumanOutcome \{([^}]*)\}/.exec(src);
    if (!block) throw new Error('enum AiHumanOutcome not found in prisma/schema/enums.prisma');
    return block[1]
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter((l) => /^[A-Z_]+$/.test(l));
}

const MESSAGES = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')) as {
    agents: { decisions: { outcome: Record<string, string> } };
};
const BG = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/bg.json'), 'utf8')) as {
    agents: { decisions: { outcome: Record<string, string> } };
};

function rowWith(humanOutcome: string): DecisionRow {
    return {
        id: `d-${humanOutcome}`,
        feature: 'agentic-run:diagnostic',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        inputDigest: 'sha256:0123456789abcdef',
        outputSummary: null,
        guardVerdict: null,
        humanOutcome,
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 42,
        createdAt: '2026-09-23T10:00:00.000Z',
    };
}

function renderOne(humanOutcome: string) {
    return render(
        <DecisionsClient
            tenantSlug="acme"
            decisions={[rowWith(humanOutcome)]}
            digest={null}
            canReviewProposals
            canInvestigate
        />,
    );
}

describe('the decisions page renders every humanOutcome the column can hold', () => {
    const VALUES = outcomeValues();

    it('parsed a real population, not an empty one', () => {
        // The positive control: every assertion below loops over VALUES, and a
        // loop over nothing passes. The exact set is named so a member being
        // silently dropped from the parse is a failure rather than a smaller
        // denominator.
        expect(VALUES).toEqual(['PENDING', 'ACCEPTED', 'EDITED', 'REJECTED']);
    });

    it.each(VALUES)('%s renders its label, never the raw key path', (outcome) => {
        const label = MESSAGES.agents.decisions.outcome[outcome];
        expect(typeof label).toBe('string');
        const { unmount } = renderOne(outcome);
        expect(screen.getByText(label)).toBeInTheDocument();
        // The failure mode this replaces, stated as its own assertion: an
        // unresolved key leaves the dotted path on screen.
        expect(screen.queryByText(`decisions.outcome.${outcome}`)).toBeNull();
        unmount();
    });

    it.each(VALUES)('%s is a label in bg.json too', (outcome) => {
        expect(typeof BG.agents.decisions.outcome[outcome]).toBe('string');
    });

    it('EDITED is a warning tone, not the neutral fallback an unknown value gets', () => {
        // The variant map's miss was INVISIBLE in the label assertion above
        // once the message key was fixed: `OUTCOME_VARIANT[x] ?? 'neutral'`
        // renders happily for a key it does not know. So the tone is asserted
        // directly, against a value the map DOES know for contrast.
        const { unmount } = renderOne('EDITED');
        const edited = screen.getByText(MESSAGES.agents.decisions.outcome.EDITED);
        expect(edited.className).toContain('text-content-warning');
        unmount();

        const pendingRender = renderOne('PENDING');
        const pending = screen.getByText(MESSAGES.agents.decisions.outcome.PENDING);
        expect(pending.className).toContain('text-content-muted');
        pendingRender.unmount();
    });

    it('ACCEPTED and REJECTED keep their own tones', () => {
        const a = renderOne('ACCEPTED');
        expect(
            screen.getByText(MESSAGES.agents.decisions.outcome.ACCEPTED).className,
        ).toContain('text-content-success');
        a.unmount();

        const r = renderOne('REJECTED');
        expect(
            screen.getByText(MESSAGES.agents.decisions.outcome.REJECTED).className,
        ).toContain('text-content-error');
        r.unmount();
    });
});
