# 2026-11-11 — The DocumentParser seam (Docling backend, stub default)

**Commit:** `feat(ai): DocumentParser seam with a Docling client and a paragraph stub`

## Design

`docs/ai-architecture/ragflow.md` Phase 1, adapted to the owner's D-L4-4
(2026-11-11): the default backend is a Docling-class parsing-only service, not
RAGFlow. Under the capacity rule no container is added, so this is the seam
only.

```
caller (a worker job, Phase 2)
  └─ parseDocument(input)                      src/lib/ai/parsing/index.ts
       ├─ resolveDocumentParser()              DOC_PARSER_BASE_URL set? docling : stub
       └─ parseWithFallback(primary, stub)     outage → stub + WARN + fallbackFrom
            ├─ docling-provider ─ wirePost ─ safeFetch   (https, deadline, aborting byte cap)
            └─ stub-provider                    text/plain, text/markdown; blank-line paragraphs
  └─ guardParsedDocument(ctx, doc)             src/app-layer/ai/parsing/  (G4)
       └─ GuardedParsedDocument                the only type a model-facing consumer takes
```

`parse()` never throws for a reason it can name. It resolves to a document or
a refusal carrying one `ParseRefusalReason`. A partial conversion, an oversized
or over-limit answer and an empty parse are all refusals, never a smaller
document that looks complete.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/parsing/types.ts` | The interface, the result union, the refusal vocabulary, `OUTAGE_REASONS`, the limits |
| `src/lib/ai/parsing/stub-provider.ts` | The deterministic paragraph chunker, Markdown headings as section bounds |
| `src/lib/ai/parsing/docling-provider.ts` | docling-serve `POST /v1/convert/source` client over `wirePost`; `DoclingDocument` → sections/tables/pages |
| `src/lib/ai/parsing/index.ts` | Backend choice (env only) and the fallback composition |
| `src/app-layer/ai/parsing/guard-parsed-document.ts` | `guardUntrustedInput` over text plus table cells; the nominal `GuardedParsedDocument` |
| `src/env.ts` | `DOC_PARSER_BASE_URL`, `DOC_PARSER_API_KEY`, both optional, empty = absent |
| `tests/guards/ssrf-egress-coverage.test.ts` | The Docling client joins the clients held to "no fetch of its own, imports the wire" |
| `tests/unit/document-parser-seam.test.ts` | The seam's invariants |

## Decisions

- **The Docling client rides `wirePost`, not its own `safeFetch` call.** The
  wire is already the registered SSRF sink with the deadline-over-the-body and
  aborting cap the roadmap asks for. A third capped reader is how the two
  copies before #3303 drifted. The guard holds the client to "no fetch call of
  its own" beside the MCP and A2A clients.
- **`EGRESS_REFUSED` does not fall back.** `safeFetch` refuses `http:` and
  private addresses, and an in-deployment container sits on a private address
  behind plain HTTP by default. That is a permanent misconfiguration. Falling
  back would hide it behind a stub that reads only text. Phase 1.3 has to put
  TLS in front of the service and the range in
  `EGRESS_PRIVATE_CIDR_ALLOWLIST`, which a hosted deployment does not honour.
  That is an open question for the operator when the container lands. The
  alternative is a separate operator-host rule for in-deployment services,
  which needs a security review and was not invented here.
- **Only an outage falls back.** `TIMEOUT`, `UNREACHABLE` and
  `UPSTREAM_UNAVAILABLE` fall back with a WARN and a `fallbackFrom` label, so
  Phase 2 can record that the index came from the stub. A partial parse, a
  contract mismatch, an auth failure and an oversized answer are the primary's
  verdict and stand. `UNSUPPORTED_MEDIA` routes to the stub without a warning,
  because plain text is the stub's format and not Docling's.
- **The tenant's file name is not sent.** The service sees `document.<ext>`,
  derived from the media type. The format is all it needs, and a file name is
  tenant text in a log it does not own.
- **The guard withholds on `flag`, not only `block`.** This follows the
  auto-draft rule (H2). No person reviews a document between the parse and the
  index, so a flagged document would reach every later prompt that retrieves
  it. A withheld document comes back as a refusal carrying rule ids for the
  caller to record. Table cells are scanned too, because a cell is where an
  instruction can sit unseen.
- **`GuardedParsedDocument` is nominal by construction, not by convention.**
  It has an ECMAScript private field, so an object literal cannot satisfy it.
  Its constructor is keyed on a module-private `unique symbol`, so calling it
  elsewhere fails `tsc` and throws at run time.
- **The guard step lives in `app-layer`, the parser in `lib`.** The guard reads
  tenant settings through Prisma, and G3 keeps parser modules free of Prisma
  and usecase calls.
- **The response schema declares only what the client reads.** Unknown
  members are stripped, so a newer docling-serve still parses, while a changed
  member is `CONTRACT_VIOLATION`. The shape was taken from docling-serve's
  usage documentation. It has not been checked against a running service; the
  Phase 1.6 integration test does that once 1.3 can run.
