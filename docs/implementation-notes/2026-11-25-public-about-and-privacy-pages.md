# 2026-11-25 — Public home page and privacy policy (/about, /privacy)

**Issue:** #5957 (Google OAuth verification for the calendar push)

## Design

Google's verification of the `calendar.events` scope needs a public home page
and a public privacy policy on a verified domain. The owner chose (2026-11-25)
to serve both from the app, to make the policy cover the whole product, and to
ship it in English and Bulgarian.

Two server components, `src/app/about/page.tsx` and `src/app/privacy/page.tsx`,
read no database row and name no tenant. They are opened in
`PUBLIC_PATH_EXACT` (exact paths, nothing beneath them) and listed among the
structural guard's root pages.

The policy's shape lives in `src/lib/public-site/legal-facts.ts`
(`PRIVACY_POLICY_SECTIONS`: each section's paragraph count and list items) and
its text in `messages/*.json` under `external.privacyPolicy`. The controller's
identity was read from the Bulgarian Commercial Register (UIC 208694564) on
2026-11-25; the contact mailbox is the owner's choice.

## Files

| File | Role |
| --- | --- |
| `src/app/about/page.tsx` | Public home page: what Inflect is, links to sign-in and the policy, the operator line |
| `src/app/privacy/page.tsx` | Public privacy policy, rendered from the section shape |
| `src/lib/public-site/legal-facts.ts` | UIC, contact mailbox, effective date, section shape, Google policy URL |
| `src/lib/auth/guard.ts` | `/about`, `/privacy` in `PUBLIC_PATH_EXACT` |
| `messages/en.json`, `messages/bg.json` | `external.legal`, `external.publicAbout`, `external.privacyPolicy` |
| `tests/rendered/public-legal-pages.test.tsx` | Renders both pages in both languages through a strict translator |
| `tests/unit/public-site/legal-pages-messages.test.ts` | Catalogue equals the shape; same placeholders and tags in both languages; Limited Use wording; exact public paths |
| `docs/runbooks/google-calendar-oauth-verification.md` | Points the verification at the two pages; the calendar draft became a pointer |

## Decisions

- **The text is in the message catalogues, the shape in code.** The pages build
  keys from the shape, which the static key guard cannot see, so a rendered
  test proves every built key resolves (it throws on a missing key, an unfilled
  placeholder or an unhandled tag), and a catalogue test proves the other
  direction: no paragraph in the catalogue goes unrendered.
- **The test translator is local and strict.** The repository's manual
  `next-intl` mock reads English only and strips tags, and the real package is
  ESM, which the Jest project cannot load.
- **Merged only after the owner reads the text.** It is a legal document, and
  several statements (the transfer safeguards, the one-month answer, the
  supervisory authority) are commitments the owner makes, not facts the code
  can prove.
