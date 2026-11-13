/**
 * THE AGENT HARNESS SCANNER REPORT CONTRACT: the strict
 * `inflect-agent-harness/2`, `/3` and `/4` schemas, the limits, and
 * `verifyAndParseHarnessReport` (size, JSON, a signature by a TRUSTED key,
 * then the strict schema of the id the report names). Server only: it hashes
 * and verifies with Node's `crypto`.
 *
 * THIS MODULE LIVES IN `@rodnapamet/scanent-contract`. The scanner report
 * contract (the strict report schemas, the ladder, the findings planner and the
 * signature, canonical-JSON, CIDR, receipt and redaction rules a report is
 * verified by) is the standalone scanent product's, published from
 * https://github.com/RodnaPamet/scanent (packages/contract) and installed here
 * from its release file at one exact version (package.json). This file
 * re-exports it unchanged so every importer keeps its `@/` path; it holds no
 * code of its own. A change to the contract is a change in scanent and a
 * version bump here, never an edit to this file. See
 * docs/implementation-notes/2026-11-13-scanent-contract-dependency.md.
 *
 * The package is compiled CommonJS. Only the modules that import no Node
 * built-in (`harness-ladder`, `harness-contract-rules`, `harness-findings`,
 * `harness-matrix-model`, `canonical-json`, `cidr`) may be reached from a
 * `'use client'` file; tests/guards/client-reachable-modules-import-no-node-builtins.test.ts
 * walks into the package to hold that.
 */
export * from '@rodnapamet/scanent-contract/harness-contract';
