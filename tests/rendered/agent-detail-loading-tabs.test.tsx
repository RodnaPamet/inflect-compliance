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
import { AGENT_DETAIL_GROUP_KEYS } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/agent-detail-tabs';

// Since #5898 the page's tab bar holds the four groups its nine sections sit
// in, and every workspace sees all four.
it('draws one tab placeholder per tab every workspace sees', async () => {
    const { container } = render(await AgentDetailLoading());
    const tabBar = container.querySelector('.border-b');
    expect(tabBar).not.toBeNull();
    expect(AGENT_DETAIL_GROUP_KEYS).toHaveLength(4);
    expect(tabBar!.children).toHaveLength(AGENT_DETAIL_GROUP_KEYS.length);
});
