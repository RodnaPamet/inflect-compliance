/**
 * `<ContentText>` shows catalogue text in the reader's language and leaves a
 * person's own text alone (#5996).
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

let locale = 'bg';
jest.mock('next-intl', () => ({ useLocale: () => locale }));

import { ContentText } from '@/components/ContentText';
import { _resetContentTextCache } from '@/lib/content-i18n/use-content-text';
import { CONTENT_TRANSLATION_BATCH } from '@/lib/content-i18n/limits';

const fetchMock = jest.fn();

beforeEach(() => {
    locale = 'bg';
    window.history.pushState({}, '', '/t/acme/controls');
    _resetContentTextCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const { texts } = JSON.parse(init.body) as { texts: string[] };
        const translations: Record<string, string> = {};
        if (texts.includes('Check the fire exits')) translations['Check the fire exits'] = 'Прегледайте ефективността';
        return { ok: true, json: async () => ({ translations }) };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

it('asks once for every text first seen together, and shows the translations that exist', async () => {
    render(
        <ul>
            <li data-testid="a"><ContentText text="Check the fire exits" /></li>
            <li data-testid="b"><ContentText text="Our own renamed task" /></li>
            <li data-testid="c"><ContentText text="Check the fire exits" /></li>
        </ul>,
    );
    // The stored text first, so nothing is blank while the answer is on its way.
    expect(screen.getByTestId('a').textContent).toBe('Check the fire exits');
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('Прегледайте ефективността'));
    expect(screen.getByTestId('c').textContent).toBe('Прегледайте ефективността');
    expect(screen.getByTestId('b').textContent).toBe('Our own renamed task');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/t/acme/content-translations');
    expect(JSON.parse(init.body)).toEqual({ locale: 'bg', texts: ['Check the fire exits', 'Our own renamed task'] });
});

it('sends each text once on a page longer than one batch, even as answers re-render it', async () => {
    // Each answer re-renders every reader, and the texts of the batches still
    // on their way are asked for again on that render. They must not be sent
    // again: a page of thousands of texts used to send each many times over.
    const texts = Array.from({ length: CONTENT_TRANSLATION_BATCH * 2 + 50 }, (_, i) => `Catalogue text ${i}`);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const asked = (JSON.parse(init.body) as { texts: string[] }).texts;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, json: async () => ({ translations: Object.fromEntries(asked.map((t) => [t, `БГ ${t}`])) }) };
    });
    render(
        <ul>
            {texts.map((t) => (
                <li key={t} data-testid={t}><ContentText text={t} /></li>
            ))}
        </ul>,
    );
    await waitFor(() => expect(screen.getByTestId(texts[texts.length - 1]).textContent).toBe(`БГ ${texts[texts.length - 1]}`));
    const sent = fetchMock.mock.calls.flatMap(([, init]) => (JSON.parse((init as { body: string }).body) as { texts: string[] }).texts);
    expect(sent).toHaveLength(texts.length);
    expect(new Set(sent).size).toBe(texts.length);
    expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('asks nothing for an English reader', async () => {
    locale = 'en';
    render(<span data-testid="a"><ContentText text="Check the fire exits" /></span>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('a').textContent).toBe('Check the fire exits');
    expect(fetchMock).not.toHaveBeenCalled();
});

it('asks nothing on a page outside a workspace', async () => {
    window.history.pushState({}, '', '/org/acme/settings');
    render(<span data-testid="a"><ContentText text="Check the fire exits" /></span>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('a').textContent).toBe('Check the fire exits');
    expect(fetchMock).not.toHaveBeenCalled();
});
