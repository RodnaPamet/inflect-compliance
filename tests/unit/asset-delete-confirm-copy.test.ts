/**
 * The asset page's delete confirmation says what the delete does (#4276).
 *
 * `deleteAsset` soft-deletes: the asset leaves the register, appears in the
 * Deleted assets view, and can be restored there until the 90-day purge. The
 * bg copy said the asset is ARCHIVED ("архивира"), which is a different
 * thing in this product — evidence has a real archive state, assets do not.
 * Both locales must name the place the asset goes (the Deleted assets view,
 * by its own label) and neither may call it archiving.
 */
const en = require('../../messages/en.json');
const bg = require('../../messages/bg.json');

describe.each([
    ['en', en],
    ['bg', bg],
] as const)('the %s delete confirmation', (_locale, messages) => {
    it('names the Deleted assets view, where the asset can be restored', () => {
        expect(messages.assets.detail.deleteConfirmDesc).toContain(messages.assets.deleted.toggle);
    });
});

describe('the delete confirmation does not call a soft delete archiving', () => {
    it('en', () => {
        expect(en.assets.detail.deleteConfirmDesc).not.toMatch(/archiv/i);
    });

    it('bg', () => {
        expect(bg.assets.detail.deleteConfirmDesc).not.toMatch(/архив/i);
        // …and does say it is deleted.
        expect(bg.assets.detail.deleteConfirmDesc).toMatch(/изтрива/);
    });
});
