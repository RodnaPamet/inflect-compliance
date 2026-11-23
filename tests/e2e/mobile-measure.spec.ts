/**
 * The mobile metrics, proved against the defects they name.
 *
 * Each case renders a small page that HAS the defect and the same page with
 * the defect fixed, and measures both with `measurePage` — the function the
 * audit and `mobile-layout*.spec.ts` use. A metric that stopped counting its
 * defect (or started counting the fix) fails here, with no server and no
 * seed involved: these pages are set with `page.setContent`.
 *
 * Runs in the `mobile` project: a touch phone, so `(pointer: coarse)` holds.
 */
import { test, expect, type Page } from '@playwright/test';
import { measurePage, type RawMeasurement } from '../../scripts/mobile-audit/measure';

test.use({ viewport: { width: 390, height: 844 } });

const shell = (body: string, css = '') => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px/1.5 sans-serif} button,a{font:inherit;min-height:44px;min-width:44px} ${css}</style></head>
<body><main style="overflow-x:clip;padding:16px">${body}</main></body></html>`;

async function measure(page: Page, html: string): Promise<RawMeasurement> {
    await page.setContent(html);
    return measurePage(page);
}

test.describe('the clipped metric', () => {
    const row = (wrap: string) =>
        `<div style="display:flex;gap:8px;${wrap}"><span style="white-space:nowrap">3 избрани</span>` +
        '<button style="flex:none;width:200px">Промени статус</button><button style="flex:none;width:160px">Приложи</button></div>';

    test('counts a control pushed past the screen edge by a row that never wraps', async ({ page }) => {
        expect((await measure(page, shell(row('')))).clippedControls.count).toBeGreaterThan(0);
    });
    test('does not count the row once it wraps', async ({ page }) => {
        expect((await measure(page, shell(row('flex-wrap:wrap')))).clippedControls.count).toBe(0);
    });
    test('does not count a control inside a container that scrolls sideways', async ({ page }) => {
        expect((await measure(page, shell(`<div style="overflow-x:auto">${row('')}</div>`))).clippedControls.count).toBe(0);
    });
    test('does not count text truncated inside a smaller box', async ({ page }) => {
        const m = await measure(page, shell('<p style="width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">' + 'Дълго име '.repeat(20) + '</p>'));
        expect(m.clippedText.count).toBe(0);
    });
    test('counts text cut at the screen edge', async ({ page }) => {
        const m = await measure(page, shell('<p style="white-space:nowrap">' + 'Дълго име '.repeat(20) + '</p>'));
        expect(m.clippedText.count).toBeGreaterThan(0);
    });
});

test.describe('the inputUnder16 metric', () => {
    test('counts a 14px field and not a 16px one, and ignores a checkbox', async ({ page }) => {
        const m = await measure(page, shell('<input style="font-size:14px"><input style="font-size:16px"><input type="checkbox" style="font-size:10px">'));
        expect(m.inputUnder16.count).toBe(1);
    });
    test('counts a select and a textarea', async ({ page }) => {
        const m = await measure(page, shell('<select style="font-size:14px"><option>a</option></select><textarea style="font-size:12px"></textarea>'));
        expect(m.inputUnder16.count).toBe(2);
    });
});

test.describe('the overlay metric', () => {
    const layout = (clearance: string) => shell(
        `<div style="height:1500px">Съдържание</div><div style="text-align:right;${clearance}"><button style="width:140px">Последно действие</button></div>`,
        '.fab{position:fixed;right:16px;bottom:16px;width:56px;height:56px;border-radius:28px;background:#888}',
    ).replace('</main>', '</main><button class="fab" aria-label="Асистент"></button>');

    test('counts the last control under a floating button at full scroll', async ({ page }) => {
        expect((await measure(page, layout(''))).overlayCoversControl.count).toBeGreaterThan(0);
    });
    test('does not count it once the page leaves room below it', async ({ page }) => {
        expect((await measure(page, layout('padding-bottom:96px'))).overlayCoversControl.count).toBe(0);
    });
});

test.describe('the tabsNoCue metric', () => {
    const tabs = Array.from({ length: 9 }, (_, i) => `<button role="tab" aria-selected="${i === 0}" style="flex:none;width:110px">Раздел ${i + 1}</button>`).join('');
    const list = (extra = '') => `<div role="tablist" style="display:flex;overflow-x:auto;scrollbar-width:none;${extra}">${tabs}</div>`;

    test('counts a tab strip that overflows with no cue', async ({ page }) => {
        expect((await measure(page, shell(list()))).tabsNoCue.count).toBe(1);
    });
    test('does not count a ScrollCueStrip that marks its overflow', async ({ page }) => {
        expect((await measure(page, shell(`<div data-scroll-cue-strip data-overflow-end>${list()}</div>`))).tabsNoCue.count).toBe(0);
    });
    test('does not count a strip with an edge-fade mask', async ({ page }) => {
        expect((await measure(page, shell(list('mask-image:linear-gradient(to right,black 80%,transparent)')))).tabsNoCue.count).toBe(0);
    });
    test('does not count tabs that fit', async ({ page }) => {
        const few = '<div role="tablist" style="display:flex"><button role="tab">Едно</button><button role="tab">Две</button></div>';
        expect((await measure(page, shell(few))).tabsNoCue.count).toBe(0);
    });
});

test.describe('the tap-target metric', () => {
    test('counts a 20px icon button and not one whose ::after grows its hit area to 44px', async ({ page }) => {
        const css = '.small{min-height:0;min-width:0;width:20px;height:20px;padding:0} .grown{position:relative} .grown::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:44px;min-height:44px}';
        const m = await measure(page, shell('<button class="small" aria-label="A"></button> <span style="display:inline-block;width:60px"></span><button class="small grown" aria-label="B"></button>', css));
        expect(m.tapUnder24.count).toBe(1);
    });
    test('does not count a link inside a sentence', async ({ page }) => {
        const css = 'a{min-height:0;min-width:0}';
        const m = await measure(page, shell('<p>Прочетете <a href="#x">условията</a> преди да продължите.</p>', css));
        expect(m.tapUnder24.count).toBe(0);
    });
});

test.describe('the tap-target metric measures what a tap lands on', () => {
    // The list card's selection circle: a 16px checkbox that ignores pointer
    // events inside the button-sized wrapper that takes the tap.
    const circle = (wrapper: string) => shell(
        `<div style="${wrapper};display:flex;align-items:center;justify-content:center" onclick="">` +
        '<button role="checkbox" aria-label="Избери ред" style="pointer-events:none;min-height:0;min-width:0;width:16px;height:16px;padding:0"></button></div>',
    );

    test('does not count a circle that ignores pointer events inside a 44px wrapper', async ({ page }) => {
        const m = await measure(page, circle('width:44px;height:44px'));
        expect(m.tapUnder24.count).toBe(0);
        expect(m.tapUnder44.count).toBe(0);
    });
    test('counts the same circle when its wrapper is as small as it is', async ({ page }) => {
        expect((await measure(page, circle('width:16px;height:16px'))).tapUnder24.count).toBe(1);
    });
    test('counts a small control that does receive pointer events', async ({ page }) => {
        const m = await measure(page, shell(
            '<div style="width:44px;height:44px"><button aria-label="Малък" style="min-height:0;min-width:0;width:16px;height:16px;padding:0"></button></div>',
        ));
        expect(m.tapUnder24.count).toBe(1);
    });

    test('does not count a focusable radio-group root, only its radios', async ({ page }) => {
        // Radix puts tabindex=0 on a RadioGroup's root so roving focus can
        // hand it to a radio; the root is not a control. Its 20px-high radios are.
        const radio = (label: string) =>
            `<button role="radio" aria-checked="false" style="min-height:0;min-width:0;height:20px;padding:0 4px">${label}</button>`;
        const m = await measure(page, shell(`<div role="radiogroup" tabindex="0" style="display:flex;gap:8px;height:20px">${radio('Приложимо')}${radio('Неприложимо')}</div>`));
        expect(m.tapUnder24.samples.map((s) => s.el.split('.')[0])).toEqual(['button[role=radio]', 'button[role=radio]']);
    });
    test('counts a focusable element with a control role of its own', async ({ page }) => {
        const m = await measure(page, shell('<div role="button" tabindex="0" style="height:20px;width:120px">Действие</div>'));
        expect(m.tapUnder24.count).toBe(1);
    });

    const link = (display: string, sentence: boolean) => shell(
        `<p>${sentence ? 'Прочетете ' : ''}<a href="#x" style="display:${display};min-height:0;min-width:0;line-height:20px">условията →</a>${sentence ? ' преди да продължите.' : ''}</p>`,
    );
    for (const display of ['inline-flex', 'inline-block']) {
        test(`does not count an ${display} link inside a sentence`, async ({ page }) => {
            expect((await measure(page, link(display, true))).tapUnder24.count).toBe(0);
        });
        test(`counts an ${display} link standing alone`, async ({ page }) => {
            expect((await measure(page, link(display, false))).tapUnder24.count).toBe(1);
        });
    }
    test('does not exempt an inline-block BUTTON inside a sentence: only links flow as text', async ({ page }) => {
        const m = await measure(page, shell(
            '<p>Ключът е TSK-1 <button style="display:inline-block;min-height:0;min-width:0;height:16px;padding:0">копирай</button> и го споделете.</p>',
        ));
        expect(m.tapUnder24.count).toBe(1);
    });
});

test.describe('the textUnder12 metric', () => {
    const topBar = (badge: string) => shell('').replace(
        '<body>',
        `<body><header role="banner" style="display:flex;gap:8px;height:56px;align-items:center">${badge}` +
        '<button aria-label="Известия" style="position:relative">🔔<span style="font-size:10px">3</span></button></header>',
    );
    test('skips the environment badge and still counts the bell\'s count badge beside it', async ({ page }) => {
        const m = await measure(page, topBar('<span data-testid="top-chrome-env-badge" style="font-size:10px">DEV</span>'));
        expect(m.textUnder12.samples.map((s) => s.text)).toEqual(['3']);
    });
    test('counts the same 10px text when it is not the environment badge', async ({ page }) => {
        const m = await measure(page, topBar('<span data-testid="top-chrome-status" style="font-size:10px">DEV</span>'));
        expect(m.textUnder12.count).toBe(2);
    });
});

test.describe('the buttonWraps metric counts button groups only', () => {
    const wrapRow = (children: string, extra = '') => shell(`<div style="display:flex;flex-wrap:wrap;gap:8px;${extra}">${children}</div>`);
    const buttons = (n: number) => Array.from({ length: n }, (_, i) => `<button style="width:200px">Действие ${i}</button>`).join('');

    test('counts a row of buttons wrapped in tooltip triggers no bigger than the buttons', async ({ page }) => {
        const wrapped = Array.from({ length: 4 }, (_, i) => `<span style="display:inline-flex"><button style="width:200px">Действие ${i}</button></span>`).join('');
        expect((await measure(page, wrapRow(wrapped))).buttonWraps.count).toBe(1);
    });
    test('does not count stacked form fields, each a label around one picker', async ({ page }) => {
        const field = (label: string) =>
            `<label style="display:block;width:300px"><span style="font-size:12px">${label}</span><button style="display:block;width:100%">Изберете…</button></label>`;
        expect((await measure(page, wrapRow(field('Посока') + field('Честота') + field('Собственик'), 'align-items:flex-end'))).buttonWraps.count).toBe(0);
    });
    test('does not count link-pill navigation that carries a caption', async ({ page }) => {
        const pill = (t: string) => `<a href="#${t}" style="width:200px">${t}</a>`;
        const nav = `<nav aria-label="Идентичност" style="display:flex;flex-wrap:wrap;gap:8px"><span style="width:150px">Идентичност:</span>` +
            `<span aria-current="page" style="width:150px">SSO</span>${pill('SCIM')}${pill('Entra')}${pill('Интеграции')}</nav>`;
        expect((await measure(page, shell(nav))).buttonWraps.count).toBe(0);
    });
    test('still counts the action row once it is a row of buttons', async ({ page }) => {
        expect((await measure(page, wrapRow(buttons(5)))).buttonWraps.count).toBe(1);
    });
});

test.describe('the remaining metrics', () => {
    test('textUnder12 counts 11px text', async ({ page }) => {
        expect((await measure(page, shell('<span style="font-size:11px">ОБЩО</span><span>Нормален</span>'))).textUnder12.count).toBe(1);
    });
    test('buttonWraps counts an action row on three lines', async ({ page }) => {
        const buttons = Array.from({ length: 5 }, (_, i) => `<button style="width:200px">Действие ${i}</button>`).join('');
        expect((await measure(page, shell(`<div style="display:flex;flex-wrap:wrap;gap:8px">${buttons}</div>`))).buttonWraps.count).toBe(1);
    });
    test('wideTables counts a table wider than the screen', async ({ page }) => {
        expect((await measure(page, shell('<div style="overflow-x:auto"><table style="width:800px"><tr><td>a</td></tr></table></div>'))).wideTables.count).toBe(1);
    });
    test('docScrollsSideways is false when the shell clips the overflow', async ({ page }) => {
        expect((await measure(page, shell('<div style="width:900px">широко</div>'))).docScrollsSideways).toBe(false);
    });
});
