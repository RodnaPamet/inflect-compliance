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
