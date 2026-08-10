/**
 * The three honest states of an analytics list.
 *
 * The risk-analytics pages used `fetch(...).catch(() => {})`, so a failed
 * load rendered an empty register — indistinguishable from a genuinely empty
 * tenant. An operator looking at "no correlations" could not tell "you have
 * none" from "we could not ask". This primitive exists to make those
 * different.
 *
 * B3-5 — the guard asserted it by checking the FILE EXISTS and contained the
 * string `data-testid="analytics-error"`. That proves a testid is present in
 * a source file. It cannot tell you the error branch is reachable, that it
 * beats loading, or — the actual bug this replaced — that a failure never
 * renders as emptiness.
 *
 * PRECEDENCE IS THE CONTRACT. `error` must win over `isLoading` and over
 * `isEmpty`, because a failed load usually arrives with `isEmpty === true`
 * (there is no data), and whichever branch is checked first decides whether
 * the operator sees a problem or a blank card.
 */
import { render, screen } from '@testing-library/react';
import { AnalyticsState } from '@/app/t/[tenantSlug]/(app)/risks/_shared/AnalyticsState';

const base = {
    isLoading: false,
    error: null as unknown,
    isEmpty: false,
    emptyText: 'No correlations recorded yet.',
    errorText: "Couldn't load correlations.",
};

describe('AnalyticsState', () => {
    it('renders the children when the load succeeded and there is data', () => {
        render(<AnalyticsState {...base}><p>the register</p></AnalyticsState>);
        expect(screen.getByText('the register')).toBeInTheDocument();
        expect(screen.queryByTestId('analytics-error')).toBeNull();
    });

    it('shows a VISIBLE error — never a blank card — on failure', () => {
        render(
            <AnalyticsState {...base} error={new Error('boom')} isEmpty>
                <p>the register</p>
            </AnalyticsState>,
        );
        const notice = screen.getByTestId('analytics-error');
        expect(notice).toHaveTextContent("Couldn't load correlations.");
        expect(screen.queryByText('the register')).toBeNull();
    });

    it('error BEATS empty — the exact bug this primitive replaced', () => {
        // A failed load almost always arrives with isEmpty true, because no
        // rows came back. If `isEmpty` were checked first, every failure
        // would render as "you have none" — which is what the raw
        // `.catch(() => {})` pages did.
        render(<AnalyticsState {...base} error={new Error('x')} isEmpty><p>rows</p></AnalyticsState>);
        expect(screen.getByTestId('analytics-error')).toBeInTheDocument();
        expect(screen.queryByText(base.emptyText)).toBeNull();
    });

    it('error BEATS loading', () => {
        // SWR can hold isLoading true while an error is already present on a
        // revalidate; the operator needs the error, not a spinner that never
        // resolves.
        render(<AnalyticsState {...base} error={new Error('x')} isLoading><p>rows</p></AnalyticsState>);
        expect(screen.getByTestId('analytics-error')).toBeInTheDocument();
    });

    it('shows the typed empty text when the load succeeded with no rows', () => {
        render(<AnalyticsState {...base} isEmpty><p>the register</p></AnalyticsState>);
        expect(screen.getByText('No correlations recorded yet.')).toBeInTheDocument();
        expect(screen.queryByText('the register')).toBeNull();
        // Crucially NOT the error affordance — an empty tenant is not a fault.
        expect(screen.queryByTestId('analytics-error')).toBeNull();
    });

    it('shows a skeleton while loading, not the empty text', () => {
        const { container } = render(
            <AnalyticsState {...base} isLoading isEmpty><p>rows</p></AnalyticsState>,
        );
        expect(screen.queryByText(base.emptyText)).toBeNull();
        expect(screen.queryByText('rows')).toBeNull();
        expect(container).not.toBeEmptyDOMElement();
    });

    it('treats a falsy-but-present error correctly — only truthy errors fault', () => {
        // `error: null` from SWR is the success case; rendering the error
        // notice for it would make every healthy page look broken.
        render(<AnalyticsState {...base} error={null}><p>rows</p></AnalyticsState>);
        expect(screen.getByText('rows')).toBeInTheDocument();
        expect(screen.queryByTestId('analytics-error')).toBeNull();
    });
});
