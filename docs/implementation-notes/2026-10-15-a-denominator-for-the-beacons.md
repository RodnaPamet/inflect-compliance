# 2026-10-15 — twelve beacons and nothing to divide them by (#3547)

**PR:** #3563 · **Issue:** #3547 · **Owner decision 2026-10-15:** build the
denominator before any percentile or collector work.

## The state that prompted it

Production Core Web Vitals are shipping and queryable. The whole dataset, 30
days:

```
vital  n   worst     ratings
CLS    2   0.209     needs-improvement 1, good 1
FCP    2   4236 ms   poor 1, needs-improvement 1
INP    3   464 ms    needs-improvement 2, good 1
LCP    2   7372 ms   poor 2
TTFB   3   3388 ms   poor 2, needs-improvement 1
```

Twelve samples. Every LCP `poor`. And **nothing in the logs to divide them by**:
measured 2026-10-15, every `route` value in a 500-line/30-day sample belongs to
a background job. The app logs no HTTP requests at all.

So "12 beacons in 30 days" supports two incompatible readings — *almost nobody
is using it* and *beacons are being dropped* — with completely different
responses, and no way to choose. That is the gap this closes.

## The probe that proved nothing, and how it was caught

First attempt: count production lines matching `"route":"/t/`.

```
web_vital beacons per day  :  2026-10-07: 2   10-08: 8   10-11: 2   (total 12)
"route":"/t/ per day       :  2026-10-07: 2   10-08: 8   10-11: 2   (total 12)
```

**The identity is the tell.** `web_vital` lines carry a `route` field of their
own, so the probe had re-counted the numerator. The discriminating version —
the same filter with `AND NOT "web_vital"` — returns **0**.

A probe that answers the same in both worlds is zero evidence. The only reason
it was caught is that the two numbers matched *too* well; had the app logged
anything at all about requests, the figure would have looked plausible and been
wrong.

## What the denominator counts, and why each exclusion

Browser web-vitals fire **once per document load** — `useReportWebVitals`
subscribes to six per-document callbacks — so document loads are the matching
quantity, and `Sec-Fetch-Dest: document` is the discriminator.

| request | excluded because |
| --- | --- |
| RSC payload / prefetch (`empty`) | fires no new vitals. Including them would add the sidebar's **fourteen prefetches per load** and make the ratio read as mass beacon loss |
| subresource (`image`/`style`/`script`) | not a page |
| document redirected to `/login` | renders no app, emits no vitals — including it adds exactly the requests that *cannot* contribute to the numerator, at whatever rate a crawler likes |
| `/api/...` | defensive: a non-page label divided into vitals that can never be reported for it |
| no `Sec-Fetch-Dest` at all | see the floor below |

The redirect term is `isPassThrough`, which the middleware already computes for
its own reasons — **passed rather than assumed**, with a test that fails if it
is hardcoded to `true`.

## One normaliser, not two

`normalizeVitalRoute` moved to `lib/observability/vital-route` and is
re-exported from `web-vitals.ts`, so no importer changed.

The reason is the entire point of the exercise: a denominator is divisible by a
numerator only if it carries the **same label**, and two copies of a regex are
two things that drift. The middleware runs on the Edge runtime and can import
neither `@opentelemetry/api` nor the Node logger `web-vitals.ts` uses, so one
shared module was the only way to have one copy.

The agreement is asserted by mapping **both** functions over the same paths.
That test is about *agreement*, not correctness, and the mutation table proves
it: breaking the normaliser failed six tests and **not** that one. Correct
semantics — divergence is what it guards.

## The known floor, stated rather than hidden

A client sending no `Sec-Fetch-Dest` is not counted, and a test asserts that is
deliberate. Every browser able to run the web-vitals library sends it
(Chrome 80+, Firefox 90+, Safari 16.4+), so the populations very nearly agree.
**The shape that would reveal a gap is a ratio above one beacon-set per counted
load** — roughly 8 beacons per document, per `web-vitals.ts`'s own note.

Counting header-less requests instead would put every curl, probe and crawler
in the denominator, which is the worse trade: it inflates the thing being
divided by.

## Pure logic, because the middleware cannot be tested

`src/middleware.ts` cannot be imported in a unit test — `csp-middleware.test.ts`
says so explicitly and greps the source instead. **A spelling assertion against
something that cannot fail is how #3554 stayed green through seven days of
production failure**, so as little as possible lives there: every decision that
can be made without a request object is in `documentLoadRoute`, asserted on
behaviour, and the structural half is four needles over a `codeOf`-masked read
with a test proving the mask works.

Masking was earned, not precautionary: the middleware comment block written for
this change **names** `documentLoadRoute` and `normalizeVitalRoute` in prose,
one character from the needles. That was the second time in one session
`raw-source-assertion-ratchet` caught the same shape in work of mine.

## What to do with it

Within a day or two of deploy, `document_load` count per route beside
`web_vital` count per route answers the question #3547 could not:

- **≈8 beacons per counted load** → the instrumentation is healthy and the app
  genuinely has almost no traffic. The LCP numbers stand as a flag on a
  near-empty app, and percentile work is premature.
- **far fewer** → beacons are being lost, and the sink is the thing to fix
  before any performance conclusion is drawn from them.
- **more than one set per load** → the `Sec-Fetch-Dest` floor above is biting
  harder than expected.

What this does NOT do is produce percentiles. The OTel histogram half of
`web-vitals.ts` remains a documented no-op with no collector — the next
decision in #3547, which now has a number to be decided on.
