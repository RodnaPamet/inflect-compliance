/**
 * A list page is not described to the model as one record (#5190).
 *
 * The client sends the route it is on, tenant prefix and all
 * (`/t/acme/controls`). The "single record" test compared the normalised base
 * with that RAW route, which always differed, so every page — every list,
 * every dashboard — reached the model as "a single record under that route".
 */
import { describePageContext } from '@/app-layer/ai/assistant/page-context';

it('a tenant-prefixed LIST route is not a single record', () => {
    const text = describePageContext({ route: '/t/acme/controls' } as never);
    expect(text).toContain('route: /controls');
    expect(text).not.toContain('a single record');
});

it('a list route with a query or trailing slash is still the list', () => {
    expect(describePageContext({ route: '/t/acme/controls/?status=open' } as never)).not.toContain('a single record');
});

it('a DETAIL route under the base is a single record — the control', () => {
    expect(describePageContext({ route: '/t/acme/controls/ctl_123' } as never)).toContain('a single record');
});
