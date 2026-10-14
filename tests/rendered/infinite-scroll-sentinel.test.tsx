/**
 * Behavioural test for <InfiniteScrollSentinel> — the load-on-scroll
 * engine behind the tenant list tables (replaces the "Load more" button).
 *
 * The sentinel's contract:
 *   • fire `onReachEnd` once when it scrolls into view (the visibility
 *     edge), so the windowing hook appends the next batch;
 *   • do NOT re-fire while it stays visible — one fire per crossing,
 *     so a single scroll-to-bottom loads exactly one batch.
 *
 * `useInViewport` (IntersectionObserver wrapper) is mocked so the test
 * drives the visibility edge deterministically without a real observer
 * (jsdom's IO is a no-op).
 */
import { render } from '@testing-library/react';
import { useInViewport } from '@inflect/ui/components/ui/hooks/use-in-viewport';
import { InfiniteScrollSentinel } from '@/components/ui/table/infinite-scroll-sentinel';

// The module the sentinel imports, not the hooks barrel: it imports the hook
// by its own module (projectZ #336), so a mock of the barrel never reaches it.
jest.mock('@inflect/ui/components/ui/hooks/use-in-viewport', () => ({
    useInViewport: jest.fn(),
}));

const mockUseInViewport = useInViewport as jest.Mock;

describe('InfiniteScrollSentinel', () => {
    beforeEach(() => mockUseInViewport.mockReset());

    it('fires onReachEnd when the sentinel scrolls into view', () => {
        const onReachEnd = jest.fn();
        mockUseInViewport.mockReturnValue(false);

        const { rerender } = render(
            <InfiniteScrollSentinel onReachEnd={onReachEnd} />,
        );
        expect(onReachEnd).not.toHaveBeenCalled();

        // Sentinel scrolls into view → load the next batch.
        mockUseInViewport.mockReturnValue(true);
        rerender(<InfiniteScrollSentinel onReachEnd={onReachEnd} />);
        expect(onReachEnd).toHaveBeenCalledTimes(1);
    });

    it('does not re-fire while staying visible (one fire per crossing)', () => {
        const onReachEnd = jest.fn();
        mockUseInViewport.mockReturnValue(true);

        const { rerender } = render(
            <InfiniteScrollSentinel onReachEnd={onReachEnd} />,
        );
        expect(onReachEnd).toHaveBeenCalledTimes(1);

        // A re-render with a fresh callback while STILL visible must not
        // re-fire — the effect deps are [visible] only and the latest
        // callback is stashed in a ref.
        rerender(<InfiniteScrollSentinel onReachEnd={() => onReachEnd()} />);
        expect(onReachEnd).toHaveBeenCalledTimes(1);
    });

    it('renders an aria-hidden sentinel node', () => {
        mockUseInViewport.mockReturnValue(false);
        const { container } = render(
            <InfiniteScrollSentinel onReachEnd={jest.fn()} testId="qa-sentinel" />,
        );
        const node = container.querySelector('[data-testid="qa-sentinel"]');
        expect(node).not.toBeNull();
        expect(node).toHaveAttribute('aria-hidden', 'true');
    });
});
