/**
 * SHORTCUTS MUST FIRE ON A NON-LATIN LAYOUT (T01, #3014).
 *
 * `event.key` carries what the layout PRODUCES. On a Bulgarian layout the key
 * labelled K produces 'к' (Cyrillic ka), so the old matcher compared 'к' to 'k',
 * found them unequal, and every letter shortcut in the app silently did nothing
 * for that user. Nothing errored and nothing logged — the command palette simply
 * never opened.
 *
 * `event.code` carries WHICH KEY was pressed, which is what "Ctrl+K" means.
 *
 * The negative cases matter as much as the positive one. Matching everything on
 * `event.code` would fire '/' and '?' from wherever the US layout happens to put
 * them, which is the same class of bug pointing the other way.
 */
import { parseShortcut, matchShortcut, physicalCodeFor } from '@/lib/hooks/keyboard-shortcut-internals';

/** A KeyboardEvent-shaped object; `code` omitted when a test needs it absent. */
const ev = (over: Partial<KeyboardEvent> & { key: string }): KeyboardEvent =>
    ({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...over,
    }) as KeyboardEvent;

describe('letters and digits match the physical key', () => {
    it('fires mod+k from a Bulgarian layout, where event.key is "к"', () => {
        // THE REGRESSION. Before this, `'к'.toLowerCase() === 'k'` was false and
        // the palette never opened for a Cyrillic user.
        const parsed = parseShortcut('mod+k');
        expect(matchShortcut(ev({ key: 'к', code: 'KeyK', ctrlKey: true }), parsed)).toBe(true);
    });

    it('still fires from a US layout, where key and code agree', () => {
        // The positive control: if the change had simply swapped which layouts
        // work, this would now be false.
        const parsed = parseShortcut('mod+k');
        expect(matchShortcut(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), parsed)).toBe(true);
    });

    it('does NOT fire when a different physical key produces the right glyph', () => {
        // The other half of "physical": a layout that prints 'k' on the J key
        // must not trigger a shortcut bound to K.
        const parsed = parseShortcut('mod+k');
        expect(matchShortcut(ev({ key: 'k', code: 'KeyJ', ctrlKey: true }), parsed)).toBe(false);
    });

    it('matches a digit preset by position, and not from the numpad', () => {
        const parsed = parseShortcut('7');
        expect(matchShortcut(ev({ key: '7', code: 'Digit7' }), parsed)).toBe(true);
        // Numpad excluded deliberately, so typing figures does not fire presets.
        expect(matchShortcut(ev({ key: '7', code: 'Numpad7' }), parsed)).toBe(false);
    });

    it('falls back to event.key when code is absent', () => {
        // Synthetic events and older fixtures carry no `code`. A shortcut that
        // stops firing is the failure this change exists to fix, so absence
        // degrades to the old behaviour rather than matching nothing.
        const parsed = parseShortcut('mod+k');
        expect(matchShortcut(ev({ key: 'k', ctrlKey: true }), parsed)).toBe(true);
    });
});

describe('punctuation and named keys still match what the layout produced', () => {
    it.each(['/', '?', ','])('%s is not given a physical code', (ch) => {
        // Matching these by position would fire them from wherever the US layout
        // puts them — the same bug, pointing the other way.
        expect(physicalCodeFor(ch)).toBeNull();
    });

    it('escape and enter are unaffected', () => {
        expect(physicalCodeFor('escape')).toBeNull();
        expect(matchShortcut(ev({ key: 'Escape', code: 'Escape' }), parseShortcut('escape'))).toBe(true);
    });
});
