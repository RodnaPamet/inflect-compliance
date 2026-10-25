# 2026-10-24 — SAML: the assertion's issuer, SHA-1, and email addresses in logs

**Commit:** `fix(sso): a SAML assertion must come from the configured IdP, signed with SHA-256 or stronger`

## Design

Three gaps from the SAML hardening review, each in what node-saml 5 leaves to
its caller. All three are closed in `validateSamlResponse`
(`src/lib/security/saml-client.ts`) or the callback routes, and none needs a
schema or configuration change.

- **Issuer.** `buildSamlInstance` passed `idpIssuer: config.entityId`, which
  read as a pin, and a test comment said it made an assertion from another IdP
  fail. node-saml 5 reads `idpIssuer` only in `verifyLogoutRequest` /
  `verifyLogoutResponse`. For a login response, any `<Issuer>` passed as long
  as the configured certificate signed it. The client now compares
  `profile.issuer`, which node-saml reads from the verified assertion, with
  `saml.options.idpIssuer`, and refuses when they differ or either is missing.
- **SHA-1.** `signatureAlgorithm: 'sha256'` / `digestAlgorithm: 'sha256'`
  govern what the SP signs. Verification takes whatever the response declares,
  and xml-crypto 6 accepts RSA-SHA1 and a SHA-1 digest. node-saml builds its
  `SignedXml` internally, so its algorithm tables cannot be narrowed from
  outside. The client reads the response's own `SignatureMethod` /
  `DigestMethod` declarations before validation, and refuses any that are not
  SHA-256 or SHA-512.
- **Email addresses in logs.** Both SSO callbacks logged the full address on a
  rejected identity link. They now log `emailDomain` through
  `emailDomainForLog` (`src/lib/security/sso-logging.ts`). The domain is what
  diagnosing a `domain_mismatch` needs.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/saml-client.ts` | The algorithm allowlist, run before validation, and the issuer comparison after it |
| `src/lib/security/sso-logging.ts` | `emailDomainForLog` |
| `src/app/api/auth/sso/{saml,oidc}/callback/route.ts` | Log the domain, not the address |
| `tests/helpers/saml-test-idp.ts` | A signed-Response builder over the existing throwaway key, with the issuer and algorithms as options |
| `tests/unit/security/saml-issuer-and-algorithms.test.ts` | The refusals, against real signatures |
| `tests/unit/security/saml-client-refusals.test.ts` | Stubs now name an issuer and declare algorithms. The unsigned-response test still reaches node-saml's document-level refusal. The false `idpIssuer` comment is corrected |

## Decisions

- **The algorithm check reads text, so it is an allowlist that fails closed.**
  Every declaration must name an allowed algorithm literally, there must be at
  least one of each kind, and a document type declaration is refused. A
  character reference in an `Algorithm` value, or any spelling the pattern does
  not read, is a refusal rather than a pass. The DOCTYPE refusal closes the one
  way markup could reach the parser without appearing in the text: entity
  expansion.
- **No XML parser dependency.** `@xmldom/xmldom` is in the tree only through
  node-saml, as an `overrides` pin. Importing it directly would make it a
  direct untrusted-input dependency, with its own risk review, for a check the
  text can make conservatively.
- **The whole document is checked, not only the signature node-saml verifies.**
  A response that carries a SHA-1 declaration anywhere is refused. That is
  stricter than necessary, and a legitimate IdP never sends one.
- **Before validation, not after.** The algorithm check is cheap and needs no
  parse, so a refused response is turned away before node-saml parses it at all.
- **The domain, not a keyed hash.** A hash would let an operator correlate
  attempts by one person. The domain answers the question these log lines exist
  for, and carries nothing that identifies a person.
