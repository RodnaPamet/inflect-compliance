# Date pickers & date display — contributor guide

Epic 58. One place for "how do I add a date field in Inflect?" — if
your question isn't answered here, the canonical code lives in
[`src/components/ui/date-picker/`](../src/components/ui/date-picker/)
and [`src/lib/format-date.ts`](../src/lib/format-date.ts).

---

## TL;DR

- **Single date** (one day, form field) → `<DatePicker>`
- **Date range** (from / to, reporting filter) → `<DateRangePicker>`
- **Display a date value** → `formatDate` / `formatDateTime` / `formatDateCompact` / `formatDateRange` from `@/lib/format-date`
- **YMD wire format** → `toYMD(date)` / `parseYMD(str)` from `@/components/ui/date-picker/date-utils`
- **Don't ship `<input type="date">`** — the guardrail at
  `tests/guardrails/date-input-rollout.test.ts` fails CI on new additions.

---

## Picking the right component

### `<DatePicker>` — a single date

Use for every "pick one day" form field: review dates, expiry dates,
due dates, renewal dates, effective-from dates, etc.

```tsx
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';

// Keep state as a YMD string — matches the wire format every API in
// the app already consumes, and survives `form.reset()` cleanly.
const [nextReview, setNextReview] = useState<string>('');

<DatePicker
    id="policy-next-review-input"      // preserve existing E2E ids
    className="w-full"
    placeholder="Select date"
    clearable                            // true for optional fields
    align="start"                        // anchor popover to trigger's left
    value={parseYMD(nextReview)}
    onChange={(next) => setNextReview(toYMD(next) ?? '')}
    disabledDays={{ before: startOfUtcDay(new Date()) }}   // forward-only
    aria-label="Next review date"
/>
```

Props you'll actually use:

| Prop | When |
|---|---|
| `value` / `defaultValue` / `onChange` | Controlled / uncontrolled — same contract as React's native inputs |
| `placeholder` | Shown when the trigger has no value |
| `clearable` | Default `false`. Set `true` for optional fields (most product uses) |
| `disabledDays` | react-day-picker matcher. `{ before: startOfUtcDay(new Date()) }` for forward-only, `{ after: … }` for past-only |
| `hasError` | Forwards `aria-invalid="true"` to the trigger. Pair with `<FormField>` error rendering |
| `trigger` | Escape hatch for custom trigger markup. 99% of call sites don't need this |

### `<DateRangePicker>` — a date range

Use for reporting windows, audit periods, date-range filters.

```tsx
import { DateRangePicker } from '@/components/ui/date-picker/date-range-picker';
import { selectDateRangePresets } from '@/components/ui/date-picker/presets-catalogue';
import type { DateRangeValue } from '@/components/ui/date-picker/types';

const AUDIT_PERIOD_PRESETS = selectDateRangePresets([
    'quarter-to-date',
    'year-to-date',
    'last-quarter',
    'last-year',
]);

const [period, setPeriod] = useState<DateRangeValue>({ from: null, to: null });

<DateRangePicker
    value={period}
    onChange={setPeriod}
    presets={AUDIT_PERIOD_PRESETS}
    showYearNavigation      // enable for reporting / audit contexts
    clearable               // default true for filter-style ranges
    placeholder="Select audit period"
/>
```

On submit, convert back to ISO strings at the wire boundary:

```tsx
const body: Record<string, unknown> = { ...form };
if (period.from) body.periodStartAt = period.from.toISOString();
if (period.to)   body.periodEndAt   = period.to.toISOString();
```

### `<Presets>` — preset panel only

You almost never render this directly; `<DateRangePicker>` already
hosts it. Use `<Presets>` only when you're building a custom picker
surface (e.g. a sidebar filter drawer that isn't a popover).

---

## Choosing presets

The canonical catalogue is
[`DEFAULT_DATE_RANGE_PRESETS`](../src/components/ui/date-picker/presets-catalogue.ts).
Each entry is a **resolvable** preset (`resolve(now) ⇒ DateRangeValue`)
so the range stays accurate regardless of when the picker opens.

| Context | Recommended subset |
|---|---|
| Audit cycles / compliance reporting | `quarter-to-date`, `year-to-date`, `last-quarter`, `last-year`, `last-90-days` |
| Evidence / activity filters | `last-7-days`, `last-30-days`, `month-to-date`, `year-to-date` |
| Daily ops | `today`, `yesterday`, `last-7-days`, `last-30-days` |

Use `selectDateRangePresets([ids])` to build a curated subset — it
preserves canonical order and silently drops unknown ids so your list
survives catalogue additions without defensive filtering.

**When *not* to add a preset:**
- Single-date fields — presets on a "pick one day" field are almost
  always noise.
- Locale-specific windows ("this work week") — the app is UTC-first.
- Tenant-specific fiscal periods — those belong in a per-tenant
  catalogue, not the shared default.

---

## Display formatters

Always route through `src/lib/format-date.ts`. These helpers are
UTC-anchored and SSR-safe; routing around them re-introduces the
hydration / locale bugs the module was built to fix.

```tsx
import {
    formatDate,          // "16 Apr 2026"
    formatDateTime,      // "16 Apr 2026, 08:00"
    formatDateShort,     // "16/04/2026"
    formatDateLong,      // "16 April 2026"
    formatDateCompact,   // "16 Apr"
    formatDateRange,     // "16 – 30 Apr 2026" (adaptive)
} from '@/lib/format-date';
```

**Empty state:** every helper returns `'—'` (U+2014 em-dash) by default
on nullish input. Don't hand-code `value ? formatDate(value) : '—'`
checks at call sites — just pass the value.

**Range separator:** `formatDateRange` emits the en-dash (U+2013). Don't
hand-concatenate `${fromStr} - ${toStr}` — it bypasses the
same-month / same-year / half-open adaptive logic.

---

## Form-field integration

Use the Epic-55 `<FormField>` wrapper so dates read identically to
every other labelled field:

```tsx
<FormField label="Audit period" hint="Optional — can be set later.">
    <DatePicker … />
</FormField>
```

`<FormField>` carries the label, helper text, and error slot. Pair
`hasError` + a `<FormError>` sibling when validating at submit time.

---

## Filter-state integration

`<DateRangePicker>`'s trigger exposes `data-value="<from>|<to>"` using
the same pipe-delimited range token grammar the Epic 53 filter system
already speaks (`filter-range-utils.ts`). Hooking the picker into a
URL-synced filter is a direct wire-up — no format translation layer.

Pattern (sketch):

```tsx
const { filters, setFilter } = useUrlFilters(['period']);
const period = parseRangeToken(filters.period ?? '|');

<DateRangePicker
    value={period}
    onChange={(next) => setFilter('period', toRangeToken(next))}
    presets={[…]}
/>
```

`toRangeToken` / `parseRangeToken` live in
`@/components/ui/date-picker/date-utils`.

---

## When *not* to add a date field

- **Destructive / irreversible actions** — confirmation UX, not a
  raw field.
- **Per-tenant "custom date" shapes** — use an existing Combobox +
  DatePicker combo, not a new primitive.
- **Time-of-day precision** — the platform is day-level. Needing a
  time picker is a signal to re-examine the workflow (most GRC
  date fields are day-level by design). The one field that genuinely
  needs the time is an incident's "Detected at": the NIS2 Article 23
  deadlines run in hours from it. It pairs `<DatePicker>` with a
  native `<Input type="time">` (a time input is not a date input, so
  the date-input ban does not apply), and
  `src/lib/incidents/detected-at.ts` combines the two into one local
  instant. Reuse that pairing before building a time-aware picker.

---

## Audit + enforcement

- `tests/guardrails/date-input-rollout.test.ts` blocks new
  `<input type="date">` additions in app code. The allowlist is
  empty — if you think you need a native date input, check this guide
  first and talk to the platform team if the DatePicker genuinely
  doesn't fit.
- `tests/guardrails/date-display-consistency.test.ts` blocks ad-hoc
  `toLocaleDateString` calls and hand-rolled YMD casts.
- `tests/unit/format-date-range.test.ts`, `date-picker-foundation.test.ts`,
  and the `tests/rendered/date-*.test.tsx` suites cover the picker's
  own behaviour across foundation, UI, picker, and field integration.

If you find yourself about to bypass any of these, stop and read the
guide section above — nine times out of ten the existing API already
expresses what you need.
