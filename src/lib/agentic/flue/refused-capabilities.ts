/**
 * The agent-runtime capabilities this product REFUSES, as data.
 *
 * Point 10 of the integration plan asks for one thing in particular —
 * *"Sandboxes stay off, asserted in code and test"* — and this is the code
 * half. `tests/guards/flue-refused-capabilities.test.ts` is the test half, and
 * it reads this list rather than restating it, so the two cannot drift.
 *
 * ## Why a static import ban is the real control
 *
 * Every entry below is a named export of `@flue/runtime`. They are hooks and
 * factories: `useSandbox` is not something a configuration flag turns on, it is
 * something an agent function *calls*, and it cannot be called without being
 * imported. So a guard that refuses the import refuses the capability outright
 * — there is no runtime path around it, and nothing to get wrong at deploy time.
 *
 * That is stronger than a runtime assertion would be, which is why this module
 * deliberately exports no `assertNoSandbox(config)` for a call site that does
 * not exist yet. A never-called checker is the scaffolding this repo keeps
 * finding: it would read as defence while defending nothing, and the day
 * somebody forgot to call it, nothing would notice. When the driver gains a
 * real agent-construction seam, a runtime check there is worth adding — as a
 * second layer, not as this one's replacement.
 *
 * ## The distinction that matters: refused vs not-yet
 *
 * `useSubagent`, `defineSubagent` and `GeneralSubagent` are **deliberately
 * absent**. They are Phase 3 of the plan — *adopt*, once the subset invariant
 * has been proven — and banning them here would make a later adoption look like
 * a policy reversal rather than the plan proceeding. This list is for things we
 * have decided NOT to have, not for things we have not built yet.
 */

/** One refused capability, and why. Every entry carries its reason. */
export interface RefusedCapability {
    /** The exact named export of `@flue/runtime`. */
    readonly name: string;
    readonly reason: string;
}

/**
 * SANDBOX / CODE EXECUTION.
 *
 * The plan's verdict is *refuse*, and its risk section is blunter: arbitrary
 * code execution inside a multi-tenant GRC platform is "the largest new attack
 * surface available and contradicts the isolation story the product sells".
 *
 * The whole family is listed, not just `useSandbox`. A sandbox reached through
 * `sandboxFromDriver` or a `SandboxFactory` is the same capability arriving by
 * a different door, and a ban on the obvious name is one import away from
 * meaningless.
 */
const SANDBOX: readonly RefusedCapability[] = [
    { name: 'useSandbox', reason: 'arbitrary code execution in a multi-tenant GRC platform' },
    { name: 'UseSandboxOptions', reason: 'configures the refused sandbox hook' },
    { name: 'Sandbox', reason: 'the sandbox surface itself' },
    { name: 'SandboxApi', reason: 'the sandbox surface itself' },
    { name: 'SandboxDriver', reason: 'constructs a sandbox by another door' },
    { name: 'SandboxFactory', reason: 'constructs a sandbox by another door' },
    { name: 'sandboxFromDriver', reason: 'constructs a sandbox by another door' },
    { name: 'createSandboxSessionEnv', reason: 'stands up a sandbox session' },
    { name: 'SandboxToolFactory', reason: 'exposes sandbox operations as tools' },
    { name: 'SandboxToolFactoryOptions', reason: 'exposes sandbox operations as tools' },
    { name: 'SandboxDiedError', reason: 'only reachable if a sandbox exists' },
    { name: 'SandboxOperationUnsupportedError', reason: 'only reachable if a sandbox exists' },
    { name: 'bash', reason: 'shell execution' },
    { name: 'createBashTool', reason: 'shell execution offered to a model as a tool' },
    { name: 'BashFactory', reason: 'shell execution' },
    { name: 'BashLike', reason: 'shell execution' },
];

/**
 * FILESYSTEM TOOLS.
 *
 * Not named as a refusal in the plan, and included because they are the same
 * decision one step along: all of them operate on the sandbox filesystem, so
 * they are inert without a sandbox and a live danger with one. Listing them
 * costs nothing today and closes the door that a future `useSandbox`
 * reinstatement would otherwise open by default.
 *
 * READS ARE HERE TOO, and they were not. This list held the two writers on
 * exactly the argument above, while `createReadTool`, `createGrepTool` and
 * `createGlobTool` — same package, same `(env: Sandbox)` signature, same
 * inert-or-dangerous property — were absent. A read tool over a sandbox
 * filesystem is an exfiltration surface, not a lesser write: `SandboxToolFactory`
 * is already refused for "exposes sandbox operations as tools", and these are
 * sandbox operations exposed as tools.
 *
 * Note this is about the SANDBOX filesystem, not about database reads or
 * writes — those are governed by a different and stronger mechanism:
 * propose-not-commit plus the deny-by-default tool allowlist, where the
 * adapter offers audited MCP read tools only and every write becomes an
 * `AgentProposal` a human approves.
 */
const FILESYSTEM: readonly RefusedCapability[] = [
    { name: 'createWriteTool', reason: 'writes to the sandbox filesystem; inert without one, dangerous with one' },
    { name: 'createEditTool', reason: 'edits the sandbox filesystem; inert without one, dangerous with one' },
    { name: 'createReadTool', reason: 'reads the sandbox filesystem; an exfiltration surface with one' },
    { name: 'createGrepTool', reason: 'searches the sandbox filesystem; an exfiltration surface with one' },
    { name: 'createGlobTool', reason: 'enumerates the sandbox filesystem; an exfiltration surface with one' },
];

/**
 * CHANNELS.
 *
 * The plan's verdict is *skip*, on the grounds that they duplicate
 * `IntegrationConnection` plus notification dispatch. A skip and a refusal are
 * different in intent and identical in enforcement, so they share this list —
 * with the reason saying which it is, because "we already have one" and "this
 * is dangerous" call for different conversations when somebody wants it.
 */
const CHANNELS: readonly RefusedCapability[] = [
    { name: 'createChannelRouter', reason: 'SKIP — duplicates IntegrationConnection + notification dispatch' },
    { name: 'ChannelRouteDefinition', reason: 'SKIP — duplicates IntegrationConnection + notification dispatch' },
];

/** Every refused export name, with its reason. */
export const REFUSED_FLUE_EXPORTS: readonly RefusedCapability[] = [
    ...SANDBOX,
    ...FILESYSTEM,
    ...CHANNELS,
];

/** Fast membership test for the guard. */
export const REFUSED_FLUE_EXPORT_NAMES: ReadonlySet<string> = new Set(
    REFUSED_FLUE_EXPORTS.map((c) => c.name),
);

/**
 * The `@flue/*` packages this product may depend on. An ALLOWLIST, not a
 * denylist: the registry carries eighteen of them and will carry more, so
 * naming the ones we refuse would be a list that rots the moment somebody
 * publishes a nineteenth.
 *
 * `@flue/postgres` is the one the plan refuses by name — a second write path
 * around RLS, the encrypted-field manifest and the hash-chained audit trail,
 * which in a platform whose core claim is tenant isolation is an architectural
 * non-starter regardless of convenience. It is not listed here because nothing
 * is listed here except what is permitted.
 */
export const PERMITTED_FLUE_PACKAGES: readonly string[] = ['@flue/runtime'];
