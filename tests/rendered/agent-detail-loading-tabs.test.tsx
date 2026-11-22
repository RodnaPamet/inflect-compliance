/**
 * THE AGENT PAGE'S SKELETON DRAWS THE TABS THE PAGE DRAWS (#5313).
 *
 * It drew six while the page rendered eight (nine with agent profiles on), so
 * every load of an agent page grew its tab bar on hydration — the layout
 * shift a skeleton exists to prevent.
 */
import * as React from 'react';
import { render } from '@testing-library/react';

jest.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));

import AgentDetailLoading from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/loading';
import {
    AGENT_DETAIL_OPTIONAL_TAB_KEYS,
    AGENT_DETAIL_TAB_KEYS,
} from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/agent-detail-tabs';

it('draws one tab placeholder per tab every workspace sees', async () => {
    const { container } = render(await AgentDetailLoading());
    const tabBar = container.querySelector('.border-b');
    expect(tabBar).not.toBeNull();
    const expected = AGENT_DETAIL_TAB_KEYS.length - AGENT_DETAIL_OPTIONAL_TAB_KEYS.length;
    expect(expected).toBe(8);
    expect(tabBar!.children).toHaveLength(expected);
});
