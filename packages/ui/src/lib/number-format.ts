/**
 * First-party number / currency formatting helpers.
 *
 * Replaces the `nFormatter` / `currencyFormatter` utilities formerly
 * pulled from the `Dub utils` shim. Same input→output contract so the
 * chart/tooltip call sites render identically.
 */

/** Currencies that have no minor (cents) unit — values are whole. */
const ZERO_DECIMAL_CURRENCIES = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
    'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

function isZeroDecimalCurrency(currency: string): boolean {
    return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
}

const SI_UNITS = [
    { value: 1e18, symbol: 'E' },
    { value: 1e15, symbol: 'P' },
    { value: 1e12, symbol: 'T' },
    { value: 1e9, symbol: 'G' },
    { value: 1e6, symbol: 'M' },
    { value: 1e3, symbol: 'K' },
    { value: 1, symbol: '' },
] as const;

// Strips a trailing `.0`, `.00`, … (and trailing zeros after a real
// decimal) from a fixed-precision string: "1.0" → "1", "1.50" → "1.5".
const TRAILING_ZEROS = /\.0+$|(\.[0-9]*[1-9])0+$/;

/**
 * Compact human number formatter: `1500 → "1.5K"`, `2_000_000 → "2M"`.
 * `opts.full` formats with grouping separators instead (`"2,000,000"`).
 * `opts.digits` controls fractional precision (default 1).
 */
export function nFormatter(
    value?: number | bigint,
    opts: { digits?: number; full?: boolean } = {},
): string {
    const num = value !== undefined ? Number(value) : undefined;
    const digits = opts.digits ?? 1;

    if (!num) return '0';
    if (opts.full) return new Intl.NumberFormat('en-US').format(num);

    if (num < 1) return num.toFixed(digits).replace(TRAILING_ZEROS, '$1');

    const unit = SI_UNITS.find((u) => num >= u.value);
    if (!unit) return '0';
    return (
        (num / unit.value).toFixed(digits).replace(TRAILING_ZEROS, '$1') +
        unit.symbol
    );
}

interface CurrencyFormatterOptions extends Intl.NumberFormatOptions {
    trailingZeroDisplay?: 'auto' | 'stripIfInteger';
}

/**
 * Format a value given in the currency's minor unit (cents) as a
 * localized currency string. Zero-decimal currencies (e.g. JPY) are
 * treated as whole units; everything else is divided by 100.
 */
export function currencyFormatter(
    valueInCents: number | bigint | null | undefined,
    options?: CurrencyFormatterOptions,
): string {
    const cents =
        valueInCents == null
            ? 0
            : typeof valueInCents === 'bigint'
              ? Number(valueInCents)
              : valueInCents;
    const currency = options?.currency ?? 'USD';
    const zeroDecimal = isZeroDecimalCurrency(currency);

    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        trailingZeroDisplay: zeroDecimal ? 'stripIfInteger' : 'auto',
        ...options,
    } as CurrencyFormatterOptions).format(zeroDecimal ? cents : cents / 100);
}
