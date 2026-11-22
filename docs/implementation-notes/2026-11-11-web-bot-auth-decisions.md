# 2026-11-11 — Web Bot Auth: wire format, decisions and library review

**Commit:** see the pull request for Web Bot Auth Phase 0, sub-phases 0.1 to 0.3
(`docs/ai-architecture/web-bot-auth.md`). Documentation only: no code ships here.

## Design

Phase 0.1 of the Web Bot Auth roadmap asked for the primary texts to be read
before anything is signed, because the 2026-10-30 reading came through search
and left one conflict open: whether `Signature-Agent` is a bare String or a
Dictionary. This note records what the texts say, what Inflect will send, the
three owner decisions as taken on 2026-11-11, and the library decision.

The answer to the conflict is that **both are true at once, and they disagree**.
The working-group draft says a signer MUST send the Dictionary form. Cloudflare's
verifier, as documented today, fails a request that does. Inflect sends the
form the deployed verifier accepts, because the reason to sign at all is to be
recognised by the verifiers vendors actually sit behind. The choice is held in
one place so it can be flipped when Cloudflare moves.

```
Inflect's vendor monitor                     Vendor site (maybe behind Cloudflare)
  GET https://vendor.example/                  verify: tag, window, keyid
  Signature-Agent: "https://<operator         key from Cloudflare's registered
    origin>/.well-known/http-message-          database (registered once by the
    signatures-directory"                      operator, Phase 2.4)
  Signature-Input: sig1=("@method"
    "@authority" "@path" "signature-agent")   Any other verifier:
    ;created;keyid;alg;expires;nonce;tag       fetch the Signature-Agent URL
  Signature: sig1=:<Ed25519, 64 bytes>:        (200 only, no redirects)
                                               └─ JWKS + one proof per key
```

### What was read, and what could not be

The session's network allowed `raw.githubusercontent.com` and
`registry.npmjs.org` and refused the IETF and Cloudflare hosts. Every primary
text below was read from its source repository instead, which is the text the
published pages are built from.

| Source | Read from | Version read |
| --- | --- | --- |
| `draft-ietf-webbotauth-httpsig-protocol-01` (WG draft, submitted 2026-10-29, expires 2027-05-02) | the WG repository `webbotauth/draft-ietf-webbotauth-httpsig-protocol`, at its tag `draft-ietf-webbotauth-httpsig-protocol-01` | -01 |
| The same draft, editor's copy | the same repository, `main`, built 2026-11-10 (its `gh-pages` text carries that date) | post -01 |
| `draft-ietf-webbotauth-httpsig-protocol-00` | the same repository, tag `-00` | -00 |
| `draft-meunier-http-message-signatures-directory-03` and `draft-meunier-web-bot-auth-architecture-02` (the two drafts Cloudflare's documentation still cites) | the same repository, at their tags | -03, -02 |
| The WG's issue list | the repository's `gh-pages/archive.json`, snapshot 2026-11-10 | — |
| Cloudflare: Web Bot Auth, Verified bots, Bot verification methods | `cloudflare/cloudflare-docs`, branch `production`, `src/content/docs/bots/…` (the source of `developers.cloudflare.com/bots/…`) | as of 2026-11-12 |
| Cloudflare's reference code | `cloudflare/web-bot-auth`, `main`: the TypeScript `web-bot-auth` package and the Rust `http-signature-directory` validator | npm 0.2.0 tarball; crate 0.8.0 (version from the crates.io sparse index) |
| npm metadata for the candidate libraries | `registry.npmjs.org` | see the review below |

**Not read**, and why:

- `datatracker.ietf.org`, `www.ietf.org/archive/id/` and `www.rfc-editor.org`:
  refused by the session's network. The draft text came from its repository
  instead; the -01 submission date and expiry came from a search result
  quoting the datatracker page. RFC 9421, RFC 7638 and RFC 8037 were not
  re-read; what this note relies on from them (the signature base, the JWK
  thumbprint input, the Ed25519 thumbprint example) is checked by reproducing
  the draft's vectors below, not by quotation.
- `developers.cloudflare.com` and `blog.cloudflare.com`: refused. The
  documentation was read from its source repository. The two blog posts the
  roadmap cites ("signed agents", "message signatures in the Verified Bots
  programme") were not read; nothing below depends on them.
- `crates.io`'s API (403) and the GitHub API (outside this session's
  repository binding): the crate's version came from `index.crates.io`, and
  repository contents through raw file URLs.
- `crawltest.com/cdn-cgi/web-bot-auth`, Cloudflare's live format checker, was
  not tried: nothing is signed yet. Phase 1.4 uses it (below).

### The vectors reproduce on `node:crypto` alone

A scratch script (not committed) built the RFC 9421 Appendix B.1.4 Ed25519 test
key from its JWK with `node:crypto`, and reproduced, byte for byte, the four
Ed25519 vectors of the editor's copy: the `keyid`
(`poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U`), the Dictionary-form request
signature, the legacy-String request signature, and the signed directory
response (its `Content-Digest` and its signature). Ed25519 is deterministic, so
a match is exact. That is the evidence behind the library decision: the signer
needs nothing the repository does not already have.

The -01 tag's vectors differ from the editor's copy only in the
`Signature-Agent` value (a bare origin in -01, the full well-known URL after
it; open issue #152) and therefore in the signature bytes. The normative text
of -01 and of the editor's copy is the same. Phase 1.4 reproduces whichever
revision is current when it lands, and names it in the record.

## The wire format Inflect sends (sub-phase 0.1)

### What the texts require, side by side

| Point | WG draft (-01 and editor's copy) | Cloudflare's verifier (documentation, 2026-11-12) | Cloudflare's validator `http-signature-directory` 0.8.0 |
| --- | --- | --- | --- |
| `Signature-Agent` form | Dictionary; member value an `https` URI string; no member parameters. Signers MUST send it. A verifier MAY accept the legacy String form as one member. | **String only** (`"https://…"`, from directory-03). The Dictionary form fails verification, and so does the `key` component parameter that covering a Dictionary member needs. | — |
| What the URL is | The JWK Set itself: fetched directly, 200 only, redirects never followed; the query is dropped from the identifier. | A URI "that points to your key directory". Keys are looked up in Cloudflare's registered database, not fetched per request. | Fetches the URL; for a bare origin it tries the well-known path first. |
| Required components | at least one of `@authority`, `@target-uri`; plus the `Signature-Agent` member; SHOULD add `@method`, `@path`, `@target-uri` or `@query-param` to narrow it | `@authority` at least; ASCII values only; `signature-agent` must be covered. Refuses `@query-param`, `@status`, and the parameters `sf`, `bs`, `key`, `req`, `name`. | — |
| Signature parameters | `created`, `expires`, `keyid`, `tag="web-bot-auth"` | the same four | — |
| Window | `expires` RECOMMENDED at most 24 hours after `created` | short; "a minute is often sufficient" | — |
| `nonce` | not required; replay protection is deferred to RFC 9421 §7.2.2 | recommended, **not validated** (no nonce store) | — |
| `keyid` | base64url JWK SHA-256 thumbprint (RFC 7638 §3.2; RFC 8037 App. A.3 for Ed25519) | the same | `kid`, when present, must equal it |
| Algorithms | any registered HTTP signature algorithm | **Ed25519 only** | — |
| Directory location and type | `/.well-known/http-message-signatures-directory`, HTTPS, `application/http-message-signatures-directory+json` | the same, required | media type required at the well-known path; body ≤ 64,000 bytes; ≤ 100 keys; no redirects; 5 s timeout |
| Directory response signature | RECOMMENDED, one per key; if sent, MUST cover `("@authority";req "content-digest")`, carry `created`, `expires`, `keyid`, `tag="http-message-signatures-directory"`; a future `created` is refused | **required**, one per key, `@authority` with `req`, `created`, `expires`, `keyid`, that tag; other components "of your choice" | **requires** `"@authority";req` AND `content-digest`, a matching SHA-256 `Content-Digest`, and a current window |

### What Inflect sends

**Request signature** (outbound, Phase 1's `sign.ts`, Phase 2's `botFetch`):

```
Signature-Agent: "https://<operator origin>/.well-known/http-message-signatures-directory"
Signature-Input: sig1=("@method" "@authority" "@path" "signature-agent");created=<now>;keyid="<thumbprint>";alg="ed25519";expires=<now+60>;nonce="<64 random bytes, base64>";tag="web-bot-auth"
Signature: sig1=:<base64 Ed25519 signature>:
```

- **`Signature-Agent` is the legacy String form, carrying the full well-known
  URL.** It is the only form Cloudflare verifies; the draft lets a verifier
  accept it; and the reference library both signs and verifies it. The full
  URL rather than a bare origin, because under -01 the value IS the JWK Set
  (a bare origin would be fetched as one and fail), under directory-03 it is
  "a URI allowing retrieval of" the directory (the full URL is exactly that),
  and it is the URL registered with Cloudflare. The well-known URL also puts
  Inflect on the draft's domain-bound path, which is the one its use-case table
  says robots.txt alignment needs. This knowingly departs from the draft's
  "signers MUST send the dictionary form": a signature that the verifier in
  front of most vendors refuses would sign for nobody. **The switch** is one
  named choice in `sign.ts`: when Cloudflare's documentation accepts the
  Dictionary form, Inflect sends `sig1="…"` and covers
  `"signature-agent";key="sig1"`, and the conformance record carries a case
  for each form so the flip is tested before it ships.
- **Covered components: `@method`, `@authority`, `@path`, `signature-agent`.**
  The draft's minimum is `@authority` plus the agent; covering `@method` and
  `@path` narrows a captured signature from "any request to this authority for
  60 seconds" to "this GET of this path". Neither is on Cloudflare's refused
  list. `@target-uri` is not used (an intermediary that reorders the query
  invalidates it), and neither is `@query-param` (refused by Cloudflare). No
  body component: the monitor sends GET only. If Cloudflare's format checker
  answers 400 to this set in Phase 1.4, the set falls back to
  `("@authority" "signature-agent")` and the record says so.
- **Every request is signed on its own**: each redirect hop (a new
  `@authority`), the single retry, and the robots.txt fetch. A signature is
  never cached or reused (the draft's "static signatures" anti-pattern).
- **Window: `expires = created + 60` seconds**, `created` the current time in
  whole seconds. Cloudflare's advice, well inside the draft's 24-hour ceiling,
  and longer than the 20-second deadline `safeFetch` gives a whole grade.
- **`nonce`: 64 random bytes, standard base64**, fresh per request. Neither
  verifier requires it and Cloudflare does not check it; it is sent so an
  origin that does enforce nonces accepts the monitor, at the cost of about 90
  bytes. 64 bytes is the length the reference library generates and accepts.
- **`alg="ed25519"`** is sent, as in the draft's and Cloudflare's examples.
- **Parameter order** follows the draft's Ed25519 vector (`created`, `keyid`,
  `alg`, `expires`, `nonce`, `tag`), so the shape of a produced header can be
  compared with the vector directly.
- **`keyid` = base64url, unpadded, of SHA-256 over
  `{"crv":"Ed25519","kty":"OKP","x":"<x>"}`** (the RFC 7638 required members
  in lexicographic order, no whitespace). Reproduced against the draft's key.
- **The deployment's identity, never a tenant's (D-L1-5)**: no value in any
  header, component or parameter comes from a tenant. The nonce is random and
  the path is the vendor's.

**The directory** (Phase 1's `directory.ts` and route):

- `GET /.well-known/http-message-signatures-directory` on the operator's public
  origin, status 200, never a redirect, with no bot protection in front of it
  (a verifier fetches it unsigned). `HEAD` is optional.
- `Content-Type: application/http-message-signatures-directory+json`.
- Body: `{"keys":[…]}`, the current key, then the previous key during the
  rotation grace. Each key carries `kty`, `crv`, `x`, `kid` (= its thumbprint,
  which the validator enforces) and `use: "sig"`, nothing else: no `d`, no
  `nbf`/`exp` claims to keep true, no metadata. Two keys at most, far under the
  validator's 64,000-byte and 100-key limits.
- **Response signing, one signature per published key**, labelled per key in
  one `Signature` dictionary, each covering `("@authority";req
  "content-digest")` with `created`, `expires`, `keyid` and
  `tag="http-message-signatures-directory"`, plus the `Content-Digest:
  sha-256=:…:` header over the exact body bytes. This satisfies all three
  texts at once: Cloudflare's required `@authority;req` with an added component
  it permits, the validator's required `content-digest`, and the draft's
  MUST-cover pair. No `alg` parameter, matching the draft's vector so Phase 1.4
  can reproduce it byte for byte.
- **The proof is made only for the operator's own authority.** `@authority;req`
  is the authority the request named. Signing whatever `Host` a caller sends
  would hand anyone a valid proof binding Inflect's keys to their own
  authority, which is exactly the re-serving the proof exists to prevent. A
  request whose authority is not the configured public origin's gets a 404.
- **Proof window 24 hours, cache one hour**: `expires = created + 86400`,
  `Cache-Control: max-age=3600`. Any cached copy is still inside its proof's
  window, and a removed key stops verifying at a cache-respecting verifier
  within the hour. The draft advises a long proof window (a short one makes
  every consumer drop the keys at once at expiry); revocation speed comes from
  publishing, not from short proofs.
- **Rotation**: the new key joins the directory at least one cache lifetime
  before it signs anything, and the previous key stays for the grace. Whether
  Cloudflare re-reads a registered directory on its own, or needs the operator
  to tell it about a new key ("Cloudflare will work with you to supply a new
  key, or rotate your existing key"), is not stated; the Phase 2.4 runbook asks
  at registration.

### Cloudflare's programme, as documented

- Registration is a dashboard act: the BotBase submission form (Manage Account,
  Configurations, Bot Submission Form), verification method **Request
  Signature**, the directory URL as the validation instructions, optionally the
  User-Agent patterns. Status is tracked under BotBase, Submission history.
- Since 2026-07-01 a signed agent is a Verified bot, distinguished by a BotBase
  label, **Direct** (one operator) or **Intermediary** (operated by many end
  users). The vendor monitor is Direct, with the behaviour **Monitoring &
  Operations**.
- Verified status requires honest self-identification and non-abusive conduct:
  obeying robots.txt and crawl directives, reasonable rates, and traffic that
  matches the disclosed purpose. Repeated violation by one bot can cost an
  organisation the status of all its bots.
- `https://crawltest.com/cdn-cgi/web-bot-auth` answers 401 to a well-formed
  request with an unknown key, 200 to a verified one and 400 to a malformed
  one, so the format can be checked **before** registration. Phase 1.4 adds it
  to the conformance record when the CI runner can reach it, and says so when
  it cannot.

### Open items in the working group to watch

From the WG's issue list (snapshot 2026-11-10), the open ones that could move
something above: #67 (make `keyid` match `kid` rather than require RFC 7638;
Inflect's `kid` already is the thumbprint, so either outcome is compatible),
#126 (`Unencoded-Digest` instead of `Content-Digest` on the directory proof:
would change the directory signature's components), #144 (the `web-bot-auth`
tag's namespace), #19 (robots.txt and `Signature-Agent`), #150 and #151 (single
JWK directories, and the example `kid` that is not its thumbprint) and #152
(examples still sending a bare origin). Each pull request in Phases 1 to 3
re-reads the current revision and says which one it implements.

## Owner decisions, 2026-11-11 (sub-phase 0.2)

**What the owner adopted, and where.** The owner's decision list of 2026-11-11,
relayed to this workflow with its task, reads "D-L1-5/6/7 Web Bot Auth defaults
adopted". That is the whole of the act: each decision as the master roadmap's
decision table states it, at its "Default if undecided" value, and nothing more.
Neither the master table's rows nor this note record any owner act beyond that
line. The master table is the roadmap coordinator's to update, so this change
does not touch it; until the coordinator initials the three rows there, the
master shows the defaults, which are exactly what was adopted.

- **D-L1-5 — adopted 2026-11-11 (owner), at the default "adopt".** The signing
  identity is one Ed25519 key per deployment, never per tenant, so no signature
  discloses which customer monitors a vendor.
- **D-L1-6 — adopted 2026-11-11 (owner), at the default "adopt; register after
  Phase 2".** Outbound conduct: a User-Agent naming the bot, a public bot page,
  robots.txt honoured, and registration with Cloudflare Verified Bots by the
  operator after Phase 2.
- **D-L1-7 — adopted 2026-11-11 (owner), at the default "label only; open
  fetch, cached and capped".** Inbound verification is a label on public
  surfaces, never authorization, with an open directory fetch under a cache and
  caps rather than an allowlist of operators.

**Proposed for the owner, NOT adopted.** Reading the draft and Cloudflare's
policy turned up details the defaults do not state. They are this roadmap's
proposals, carried to the phases that need them, and none of them carries the
owner's authority until the owner adopts it by name:

- *Under D-L1-5:* the previous key is published beside the current one during a
  rotation, and the key is env-held. No tenant id, slug or name appears in the
  signature base, the headers, the User-Agent or the directory (the reading of
  "no signature discloses which customer" that the Phase 1 tenant-free test
  checks). The A2A rule "no deployment key" stays where it is, for the opposite
  reason.
- *Under D-L1-6 (for Phase 2):* Cloudflare's Verified Bots policy asks that
  crawl directives (a crawl-delay) are honoured along with disallow, and that
  the bot page's stated purpose matches what the monitor actually fetches. The
  registration is the operator's act, and the policy makes both conditions of
  it, so Phase 2 should put both to the owner before registering.
- *Under D-L1-7 (for Phase 3), what the draft asks of a verifier:* the label is
  keyed on the (URL, key) pair, never the key alone; only a `verified` outcome
  is labelled, and `invalid` and `unverified` stay distinct and unlabelled; a
  directory fetch is `safeFetch`, 200 only, no redirects, byte- and
  key-count-capped and deadline-bound; a failed fetch never evicts a cached
  directory, and a negative cache entry lives at most five minutes. Inbound
  accepts both the Dictionary and the legacy String form, because both are on
  the wire. The five-minute ceiling and accepting both forms are choices, not
  requirements of the draft, and Phase 3 should put them to the owner.

## Library decision, by risk review (sub-phase 0.3)

| Package | Version (latest) | Licence | Maintainers (npm) | Releases | Runtime deps | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `web-bot-auth` | 0.2.0, 2026-08-31 | Apache-2.0 (no LICENSE file in the tarball) | 1 (`thibmeu`) | 14 since 2025-04; 0.1.3 to 0.2.0 changed the API | `http-message-sig ^0.3.0`, `jsonwebkey-thumbprint ^0.1.0`, `structured-headers 2.0.3` | npm provenance attestation; no install scripts; no `fetch`, `eval` or `child_process`; README: "has not been audited". The 0.2.0 tarball's README names `draft-meunier-webbotauth-httpsig-protocol-00`. Signs and verifies both `Signature-Agent` forms. |
| `http-message-sig` | 0.3.0, 2026-08-31 | Apache-2.0 | 1 (`thibmeu`) | 7 since 2025-04 | `structured-headers 2.0.3` | provenance attestation; general RFC 9421 |
| `jsonwebkey-thumbprint` | 0.1.0, 2025-06-17 | Apache-2.0 (no LICENSE file in the tarball) | 1 (`thibmeu`) | 3; none since 2025-06 | none | no provenance attestation; 6 KB |
| `structured-headers` | 2.1.1, 2026-10-10 (`web-bot-auth` pins 2.0.3) | MIT | 1 (`evrt`) | 16 since 2018 | none | RFC 9651 parser and serialiser; `prepare` script only (does not run on a registry install) |
| `http-message-signatures` (alternative) | 1.0.6, 2026-06-04 | ISC | 1 (`dhensby`) | 10 since 2021 | `structured-headers ^2.0.2` | general RFC 9421, not Web Bot Auth aware |

**Decision: sign in-house on `node:crypto`; the reference library is a
devDependency test oracle, never a runtime dependency.**

- The signer is small and fully determined: a fixed component list, fixed
  parameters, values Inflect produces (an ASCII method, the vendor's host and
  path, our own URL constant), so it needs a few lines of serialisation, not a
  general structured-field serialiser. The scratch reproduction of all four
  Ed25519 vectors with `node:crypto` alone is the evidence. The A2A signing key
  already builds Ed25519 keys from seeds the same way.
- A runtime dependency on `web-bot-auth` would bring a 0.x API that broke at
  its last minor, the same single npm maintainer on three of its four packages, an
  explicit "not audited" notice, and a pinned transitive parser one minor
  behind its own latest, onto the path that handles a credential. The draft
  is still moving under it (the 0.2.0 tarball still cites a pre-WG revision).
- As a **test oracle** those same properties cost little: it is pinned exactly
  (`web-bot-auth@0.2.0`, transitives held by the lockfile), it runs only in the
  conformance cases, and it is the independent implementation that makes the
  Phase 1.4 record mean something (G11). It verifies both `Signature-Agent`
  forms, so the record can hold a case for the form sent today and the form
  Cloudflare may accept later. It is outside `license:check`'s production
  scope, and Apache-2.0 would pass it anyway.
- The directory check uses Cloudflare's own validator,
  `http-signature-directory` 0.8.0 (Rust, Apache-2.0), in CI. It is a CI tool,
  not an app dependency; Phase 1.4 decides between a pinned `cargo install
  --locked --version 0.8.0` and an image by digest (G5), and records the
  validator's version beside its verdict.
- **The inbound parser is decided with Phase 3**, as the roadmap says, on this
  review. The default carried there: `structured-headers` as an exact-pinned
  runtime dependency for parsing `Signature-Input`, `Signature` and
  `Signature-Agent`, behind Inflect's own strict checks of the parsed shape.
  It is an attacker-facing RFC 9651 parser with eight years of releases and no
  dependencies, and it is the parser the reference library itself relies on.
  The alternative, a hand-written strict subset parser, is weighed there
  against the negative vectors, not here.

## Decisions

- **The deployed verifier beats the draft's MUST, and the departure is
  recorded rather than hidden.** Sending the Dictionary form would be
  conformant and unrecognised by Cloudflare. The flip is one named choice
  with a conformance case on each side.
- **The full well-known URL, not a bare origin, in `Signature-Agent`.** It is
  the one value correct under every text read: the WG's direct JWK Set URL,
  directory-03's retrieval URI, and the URL registered with Cloudflare.
- **Narrower coverage than the minimum.** `@method` and `@path` cost nothing
  on a GET and turn a 60-second authority-wide credential into a single-request
  one. The fallback to the minimum is pre-decided, tied to a measured 400.
- **A nonce nobody checks is still sent**: it is cheap and it lets a stricter
  origin accept the monitor without a code change.
- **The directory proof covers `content-digest` as well as `@authority;req`**,
  because the validator requires it and the draft requires it of any proof; the
  Cloudflare example's single component predates both.
- **The proof is refused for a foreign authority.** A 404 instead of a proof
  over someone else's `Host` keeps the binding meaningful.
- **A finding outside this sub-phase's scope**: the draft says a crawler and a
  user-directed agent SHOULD use distinct `Signature-Agent` URLs, keys and
  directories ("Key reuse considered harmful"). The roadmap's "agents that
  browse" bullet has a future agent web tool sign "as the deployment" through
  the Phase 2 seam. If that tool is ever built, it gets a second deployment
  identity (its own key and directory URL, still tenant-free), not the
  monitor's.
