# 2026-11-11 — The PiiDetector seam (Presidio Phase 1, without the container)

**Commit:** `feat(ai/pii): the PiiDetector seam, mount gate and fail-closed egress use`

## Design

Phase 1 of `docs/ai-architecture/presidio.md`, minus 1.1 (the Compose
service), which waits on the capacity budget's C1. Seams only: nothing in the
product calls this yet, and no deployment mounts a detector, because no
evaluation record exists.

```
egress.ts  redactForEgress(input, resolution)
  │  route local? ─────────────► PASS LOCAL_ROUTE      (D-L1-1: LOCAL_ONLY off)
  │  mode OFF? ────────────────► PASS REDACTION_OFF
  │  resolution ABSENT? ───────► PASS DETECTOR_ABSENT  (no AI_PII_BASE_URL: key 2 missing)
  │  analyze in EN and BG, union spans, redact()
  │     failure / UNMOUNTED ──► REDACT: BLOCKED PII_DETECTOR_UNAVAILABLE
  │                             FLAG:   FLAG_UNAVAILABLE (text unchanged)
  └──────────────────────────► REDACTED / FLAGGED with counts by type

mount.ts  resolvePiiDetector()   — the only importer of presidio-provider
  ABSENT     no AI_PII_BASE_URL
  UNMOUNTED  NO_CONFIG_HASH | BASE_URL_NOT_HTTPS | RECORDS_UNREADABLE | NO_RECORD
             | MALFORMED | DETECTOR_MISMATCH | NO_FIXTURE_SET
             | SET_* (the committed set itself) | SET_MISMATCH
             | PREDICTED_OUT_OF_RANGE | BELOW_FLOOR
  MOUNTED    createPresidioDetector({ baseUrl, scoreThreshold: record's })
```

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/pii/entities.ts` | D-L1-1 written once: types, locales, the external-route rule, Presidio wire names |
| `src/lib/ai/pii/types.ts` | `PiiDetector`, spans in UTF-16 offsets, `PiiDetectorError` reasons |
| `src/lib/ai/pii/policy.ts` | per-type action; REPLACE for every type |
| `src/lib/ai/pii/redact.ts` | the pure redaction function, span merging, code-point → UTF-16 conversion |
| `src/lib/ai/pii/presidio-provider.ts` | HTTP client: `safeFetch` in an explicit branch, https-only, text cap, abort-at-cap body read, one deadline |
| `src/lib/ai/pii/stub-provider.ts` | deterministic detector answering only the texts it was given |
| `src/lib/ai/pii/fixture-set.ts` | the committed ground truth (`inflect-pii-fixtures/1`): texts, spans, case kinds, minimum support, digest |
| `src/lib/ai/pii/evaluation-record.ts` | record schema (`inflect-pii-record/1`), checked against the set; rates recomputed from raw answers, floors |
| `src/lib/ai/pii/measure.ts` | produce a record by asking a detector about every set case |
| `src/lib/ai/pii/mount.ts` | the mount gate |
| `src/lib/ai/pii/egress.ts` | the egress use and its outage policy |
| `src/env.ts` | `AI_PII_BASE_URL`, `AI_PII_CONFIG_HASH` |
| `tests/guards/pii-detector-single-seam.test.ts` | only `mount.ts` imports the provider; the provider fetches only via `safeFetch` or the seam; no `src/` caller passes `resolvePiiDetector` an option |
| `tests/guards/ssrf-egress-coverage.test.ts` | the provider joins `SINKS` (G6) |
| `tests/guardrails/sub-processor-coverage.test.ts` | the two vars triaged as in-deployment, not sub-processors |

## Decisions

- **The egress use analyses every locale and unions the spans.** Choosing a
  locale from the tenant would be a guess, and a Bulgarian workspace's prompt
  carries Latin names and the reverse; a span missed because of the wrong
  locale is a leak. The cost is two calls per text.
- **UNMOUNTED blocks like an outage.** The operator configured a detector and
  the one they have cannot vouch for itself; for a tenant asking for
  redaction, sending unredacted is the outcome redaction exists to prevent.
  ABSENT, by contrast, is the deployment's half of the two keys being off, as
  Phase 2.1 specifies.
- **FLAG never blocks.** FLAG sends the text unchanged by definition, so an
  outage under FLAG records itself and sends, rather than being stricter than
  the mode.
- **Presidio offsets are converted.** Presidio counts code points; a JS string
  counts UTF-16 units. Unconverted, each astral character before a span moves
  its end one unit early, leaving the last character of the value unredacted.
- **Spans widen, never trim; malformed spans throw.** Overlaps redact their
  union; a span splitting a surrogate pair is widened; a span past the text is
  a detector failure, never clamped into range.
- **No HASH action.** The roadmap's 0.1 lists one. An unkeyed digest of a
  10-digit ЕГН or a phone number is reversed by enumeration, so it is not a
  redaction; a keyed digest needs its own key decision.
- **Recall is strict, precision lenient.** An expected span counts only when
  same-type predictions cover every character of it; a prediction is precise
  when it overlaps a same-type expected span. Every type needs support in
  every locale, and all four case kinds (positive, negative, near-miss,
  mixed-script) must appear, so no rate is vacuous. The floors (recall 0.95,
  precision 0.80) are a proposal awaiting the owner's initials.
- **The config hash is operator configuration.** `AI_PII_CONFIG_HASH` names
  the recogniser configuration the deployed image was built from, set beside
  the image digest when 1.1 adds the service. It selects which record must
  pass; it cannot make a record pass. A drift check (the service reporting
  its own configuration) is not built.
- **The newest record for the configuration decides.** An older passing record
  never stands in for a newer failing one, and an unreadable record file
  refuses the mount instead of being skipped. "Newest" is `Date.parse` of
  `producedAt`, never string order, and every record naming the config (or
  naming none) is schema-checked before ordering: a malformed one cannot be
  placed in time, so it refuses rather than sorting to the bottom.
- **The ground truth is the committed set, not the record.** Review found the
  first cut checked a record only against itself: it carried its own expected
  spans and a `fixtureDigest` nothing compared. Now `checkPiiEvaluationRecord`
  cannot be called without the set; the digest and every case's locale, kind
  and spans must equal the set's (`SET_MISMATCH`, the skills gate's rule), and
  scoring reads the set's spans. Support moved to the set, with a proposed
  minimum of 20 per type per locale, so a 0.95 floor is not "1 of 1".
- **A record names the detector it measured, and only Presidio's mounts
  Presidio.** A stub replay of the fixtures answers perfectly by construction;
  `measurePiiDetector` stamps `detector.id`, so that record says `stub` and is
  `DETECTOR_MISMATCH`. The name is the record's claim, so this catches a
  mislabelled or replayed record, not a forged one; forging is a reviewed PR.
- **The mount gate's options are test seams, held by a guard.** `root`
  (where records and the set are read) and `fetchImpl` would, from a product
  caller, re-point "only a committed record mounts" or post prompts past
  `safeFetch`. The single-seam guard reads every `resolvePiiDetector`
  reference under `src/` off the syntax tree and allows only a zero-argument
  call, so an alias or the function passed along counts too.
- **`safeFetch` makes an in-deployment `http://` service unreachable.** The
  task and G6 call for `safeFetch`, and it is https-only and refuses private
  addresses. The seam follows the rule and reports `BASE_URL_NOT_HTTPS`
  rather than dialling around it. Phase 1.1 decides between TLS plus the
  deployment egress allowlist (`egress-allowlist.ts`, self-hosted only) and an
  operator-only internal dial in the `local-gateway.ts` style. Until then a
  configured detector blocks egress for tenants with redaction on, which is
  the safe direction.
- **Records are not in the runtime image.** The Dockerfile copies no `evals/`
  directory and no `tests/fixtures/`, so a deployed app finds no record and
  stays UNMOUNTED. The container phase adds both copies beside the service.
