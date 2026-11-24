/**
 * Global manual mock for `next-intl` (client entrypoint).
 *
 * `next-intl` ships ESM-only; Jest's node_modules transform does not parse it,
 * so ANY test that renders a component importing `next-intl` fails to run with
 * `SyntaxError: Unexpected token 'export'`. This CJS mock replaces the module
 * across every Jest project, so components that call `useTranslations()` render
 * cleanly in jsdom.
 *
 * Keys resolve against the REAL English catalog (`messages/en.json`) with
 * `{param}` interpolation, so assertions on visible English text keep holding
 * without per-test message wiring. A test that needs bespoke translation
 * behaviour can still declare its own `jest.mock('next-intl', …)` — a local
 * factory overrides this manual mock.
 *
 * Auto-applied because it sits in `<rootDir>/__mocks__/` adjacent to
 * `node_modules` (Jest auto-mocks node_modules packages from that folder with
 * no `jest.mock()` call required).
 */
const React = require('react');
const en = require('../messages/en.json');

function lookup(namespace, key) {
    const path = namespace ? `${namespace}.${key}` : key;
    return path
        .split('.')
        .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), en);
}

function interpolate(str, params) {
    if (typeof str !== 'string' || !params) return str;
    return str.replace(/\{(\w+)\}/g, (m, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
    );
}

/** Strip HTML tags to a fixed point (safe against crafted nesting like `<<b>x>`). */
function stripTags(value) {
    let s = String(value);
    let prev;
    do {
        prev = s;
        s = s.replace(/<[^<>]*>/g, '');
    } while (s !== prev);
    return s;
}

function makeT(namespace) {
    const t = (key, params) => {
        const val = lookup(namespace, key);
        return interpolate(typeof val === 'string' ? val : key, params);
    };
    // `.rich` resolves the string and strips tag placeholders — structural
    // tests only need the text content, not the wrapped elements.
    t.rich = (key) => {
        const val = lookup(namespace, key);
        return stripTags(typeof val === 'string' ? val : key);
    };
    t.markup = (key, params) => interpolate(
        typeof lookup(namespace, key) === 'string' ? lookup(namespace, key) : key,
        params,
    );
    t.raw = (key) => lookup(namespace, key);
    t.has = (key) => lookup(namespace, key) !== undefined;
    return t;
}

const useTranslations = (namespace) => makeT(namespace);
const useLocale = () => 'en';
const useMessages = () => en;
const useNow = () => new Date(0);
const useTimeZone = () => 'UTC';
const useFormatter = () => ({
    dateTime: (d) => String(d),
    number: (n) => String(n),
    relativeTime: (d) => String(d),
    list: (l) => Array.from(l).join(', '),
});
const NextIntlClientProvider = ({ children }) =>
    React.createElement(React.Fragment, null, children);
const IntlProvider = NextIntlClientProvider;

/**
 * `createTranslator` over the catalogue the CALLER passes (a server module
 * wording a record in a workspace's language loads `messages/<locale>.json`
 * itself), so a test of such a module sees the real language it chose, not
 * this mock's English. `{param}` interpolation only, like the rest of this
 * mock: no ICU plural or select syntax.
 */
function createTranslator({ messages, namespace }) {
    return (key, params) => {
        const path = namespace ? `${namespace}.${key}` : key;
        const val = path
            .split('.')
            .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), messages);
        return interpolate(typeof val === 'string' ? val : path, params);
    };
}

module.exports = {
    useTranslations,
    useLocale,
    useMessages,
    useNow,
    useTimeZone,
    useFormatter,
    NextIntlClientProvider,
    IntlProvider,
    createTranslator,
};
