/**
 * Tools on an EXTERNAL MCP server, presented as `McpReadTool`s so they enter
 * the one funnel and nothing about them is special at call time.
 *
 * ## Why they are resolved at ASSEMBLY, not at call time
 *
 * `McpInvocation.offeredTools` is a snapshot, and `loadable-tools.ts` states the
 * property it buys: "resolution enumerates THIS, never the live registry, so a
 * tool that enters the registry after assembly is not loadable by an invocation
 * already in flight". An external catalogue is the case that property was
 * waiting for — it is not this build's, and the person who can change it is not
 * us. Resolving here means one `tools/list` per connection at the start of a
 * run, and a set that cannot grow underneath the run afterwards.
 *
 * ## The pin is checked HERE, against text fetched HERE
 *
 * `McpToolManifestPin` stores hashes and no text at all, so an adapter cannot be
 * built from a pin — the model needs the description and the schema, which only
 * the server has. That turns out to be the right shape: the definition is
 * fetched, hashed, and compared to what a human accepted, at the moment the run
 * starts. A description rewritten since approval is refused before the model
 * ever reads it, which is the whole reason the pin exists.
 *
 * A tool is offered only if all four are true: the agent is GRANTED it, a pin is
 * ON FILE, the live definition MATCHES that pin, and the connection is enabled.
 * Anything else and the tool is simply absent — the funnel's own deny-by-default
 * shape, and `resolveOfferedTool` writes the refusal row if the model tries it
 * anyway.
 *
 * ## An unreachable server loses its tools, not the run
 *
 * A connection that will not answer contributes nothing and does not throw. The
 * alternative — failing the whole invocation — would let any third party stop
 * an agent from doing its unrelated internal work by going down, which hands an
 * outsider a denial-of-service on our own runs. An agent left with no tools at
 * all is already handled: the engine records `flue_no_tools_granted` rather than
 * reporting a conclusion drawn from nothing.
 */
import { z } from 'zod';

import { callTool } from '@/app-layer/integrations/mcp/client';
import { resolveGrantedExternalTools } from '@/app-layer/usecases/external-mcp-tools';
import type { RequestContext } from '@/app-layer/types';

import { declaresWrite } from '@/lib/mcp/tool-write-classification';
import { getPriorStateRead } from '@/app-layer/usecases/external-prior-state-read';
import { recordIntent } from '@/app-layer/usecases/external-write-journal';
import { createAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import type { ExternalWriteMode } from '@/lib/integrations/external-write-ladder';

import type { McpReadTool } from './types';

/**
 * The permission a CALLING credential must hold. Not `admin.manage`, which owns
 * the connection: that is the authority to rewire what an agent calls, and
 * requiring it here would hand every calling agent CRUD over every integration
 * the tenant has. See the key's own docstring.
 */
export const EXTERNAL_TOOL_PERMISSION = 'admin.agent_external_tools';

/** Upper bound on tools considered per connection, mirroring the catalogue's. */
const MAX_TOOLS_PER_CONNECTION = 250;

/**
 * Arguments are accepted as a plain object and validated BY THE FAR END.
 *
 * The server publishes JSON Schema; this file does not translate it into Zod.
 * A translation would be a second, weaker copy of somebody else's contract, and
 * the failure mode is ugly in both directions — too strict and we refuse calls
 * the server would have accepted, too loose and we have validated nothing while
 * appearing to. What IS pinned is the schema's HASH, so the declared contract
 * cannot change under an approval without the tool being refused.
 *
 * Nothing rides on this being permissive: the arguments go out through
 * `findInternalSecret`, which refuses to send our ciphertext or an API key
 * whatever shape they arrive in.
 */
const EXTERNAL_ARGS_SCHEMA = z.record(z.string(), z.unknown());

/**
 * Build the external read tools this invocation may load.
 *
 * The resolving — connections, pins, the live `tools/list`, the drift verdict —
 * is the usecase's, and deliberately so: `mcp-server-coverage` holds every tool
 * file to going through a usecase and never touching Prisma, which is the
 * cross-tenant-leak lock rather than a matter of taste. What is left here is
 * the only thing this layer should own: the shape the funnel expects.
 *
 * Returns `[]` — with no query and no network — when the agent holds no
 * external grants, which is every invocation today and most of them after.
 */
export async function resolveExternalReadTools(
    ctx: RequestContext,
    grantedTools: ReadonlySet<string> | null,
    /**
     * The policy-card version that AUTHORIZED this invocation, pinned onto any
     * proposal the `PROPOSE_ONLY` rung queues (#2861).
     *
     * Taken here, at invocation-build time, and never re-read at dispatch. The
     * propose tools state the reason and it holds identically: re-reading answers
     * "what is in force NOW", which is a different claim from "what allowed this
     * call", and between the two an operator can have edited the card. Only the
     * first is evidence.
     */
    policyCardVersion: number,
): Promise<McpReadTool<Record<string, unknown>>[]> {
    const granted = await resolveGrantedExternalTools(ctx, grantedTools);
    return granted.map((g) =>
        adapterFor(g.qualified, g.def, g.transport, g.parameterSets, g.connection, policyCardVersion),
    );
}

/** One approved external tool, in the shape the funnel already knows. */
function adapterFor(
    qualified: string,
    def: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations?: Record<string, unknown>;
    },
    transport: { url: string; authorization?: string },
    parameterSets: ReadonlyArray<{ label: string; parameters: Record<string, unknown> }> = [],
    connection: { id: string; name: string; url: string; mode: ExternalWriteMode },
    policyCardVersion: number,
): McpReadTool<Record<string, unknown>> {
    // ── WHO CHOOSES THE ARGUMENTS ───────────────────────────────────────────
    //
    // With no saved set the model chooses them, as it does for any tool. Once a
    // tenant HAS saved one, the model chooses only WHICH approved set to run —
    // and the values come from the row a human accepted.
    //
    // The narrowing is the point, and it has to be total: if the model could
    // still pass free-form arguments alongside, the approved set would be a
    // suggestion and the re-approval requirement would protect nothing. So a
    // tool with saved sets advertises exactly one argument and accepts exactly
    // one, and an unknown label is refused rather than falling back.
    //
    // This cannot WIDEN anything. The set is chosen from rows this tenant
    // approved, the call still goes out under the server's pinned schema, and
    // every other term — grant, rung, `EXTERNAL_EGRESS`, the egress scan on the
    // way out — is unchanged.
    const hasSets = parameterSets.length > 0;
    const labels = parameterSets.map((p) => p.label);

    return {
        name: qualified,
        description: hasSets
            ? `${def.description}\n\nArguments are supplied by an approved parameter ` +
              `set configured for this workspace. Choose one of: ${labels.join(', ')}.`
            : def.description,
        inputSchema: hasSets
            ? {
                  type: 'object',
                  properties: {
                      parameterSet: {
                          type: 'string',
                          enum: labels,
                          description: 'Which approved parameter set to run.',
                      },
                  },
                  required: ['parameterSet'],
                  additionalProperties: false,
              }
            : def.inputSchema,
        // The far end's own declaration, forwarded UNCHANGED even when saved
        // parameter sets have replaced the advertised `inputSchema` above.
        //
        // That asymmetry is deliberate. `inputSchema` is rewritten because it is
        // what the MODEL reads, and with sets in force the model's only choice
        // is a label. `annotations` is what the manifest pin hashes, and the pin
        // was taken over what the SERVER said — so narrowing it here would
        // reintroduce, for exactly the tools a tenant has constrained most, the
        // mismatch this field exists to remove.
        annotations: def.annotations,
        argsSchema: hasSets
            ? (z
                  .object({ parameterSet: z.enum(labels as [string, ...string[]]) })
                  .strict() as unknown as typeof EXTERNAL_ARGS_SCHEMA)
            : EXTERNAL_ARGS_SCHEMA,
        resourceScope: { resource: 'external_tools', action: 'read' },
        authorize: {
            keys: [EXTERNAL_TOOL_PERMISSION],
            basis: 'effective',
            /**
             * Rung 2, DECLARED rather than inherited, and this is not a detail.
             *
             * `runReadTool` passes `capabilityClass: 'read'` as a literal for
             * every tool it runs, so without this an external call would need
             * rung 1 at CALL time — while the grant surface advertises rung 2
             * for it, because `mcpToolCapabilityClass` answers `propose` for a
             * name this build does not know. A screen promising one rung and a
             * funnel enforcing a lower one is the kind of disagreement nobody
             * finds until it matters.
             *
             * Rung 2 is also the honest number on its own terms: leaving the
             * platform boundary is more autonomous than reading a row of our
             * own, whatever the call is shaped like.
             */
            autonomy: 2,
            // Stated explicitly because the field requires it of a tool with no
            // human equivalent — and this one has none by construction: it
            // belongs to somebody else's deployment, which is the whole reason
            // it carries its own permission key.
            mirrors: 'no human route — the tool is served by an external MCP server',
        },
        run: async (ctx, args) => {
            // The arguments that actually go out. With saved sets this is the
            // APPROVED row, looked up by the label the model chose — never the
            // model's own object, which by then carries only the label.
            const outbound = hasSets
                ? parameterSets.find((p) => p.label === (args as { parameterSet?: string })?.parameterSet)
                      ?.parameters
                : (args ?? {});

            if (hasSets && !outbound) {
                // Unreachable through `argsSchema`, which is an enum over these
                // same labels — and checked anyway, because the alternative to
                // a refusal here is dispatching `undefined` as the arguments,
                // i.e. running the tool with no parameters at all.
                throw new Error(
                    `external_parameter_set_unknown: no approved parameter set for ` +
                        `"${qualified}" matches the requested label.`,
                );
            }

            // ── IS THIS A WRITE? (#2861) ────────────────────────────────
            //
            // `declaresWrite` is the one definition; the catalogue an operator
            // reads and the prior-state setter use the same one, so the three
            // cannot disagree about whether a given tool is a write.
            //
            // Unknown counts as a write — see that module for why the
            // inconvenient direction is the right one.
            if (!declaresWrite(def.annotations)) {
                // `callTool` is the one outbound seam and it scans these
                // arguments before a socket is opened. Nothing is added here: a
                // second check in a per-tool wrapper would be the copy that
                // drifts.
                return callTool(transport, def.name, outbound ?? {});
            }

            return dispatchWrite(ctx, {
                qualified,
                advertisedName: def.name,
                transport,
                connection,
                outbound: outbound ?? {},
                policyCardVersion,
            });
        },
    };
}

/**
 * A write to somebody else's system, governed by the connection's rung (#2861).
 *
 * ## The order is the design
 *
 *   1. Is there a prior-state read? No → REFUSE. Nothing is sent, nothing is
 *      journalled, and the message names what an operator can fix.
 *   2. Run that read, with the WRITE's own arguments.
 *   3. Apply the rung.
 *
 * Refusing before the read matters: a pairing is what makes the write
 * accountable, so a call that cannot be accounted for should not reach the far
 * end at all — not even the read half.
 *
 * ## Why the read gets the write's arguments verbatim
 *
 * Because the pairing's whole claim is "this read describes the object that
 * write is about to change". Transforming the arguments between them would make
 * that claim depend on a mapping nobody declared, and a prior state captured from
 * a DIFFERENT object is worse than none: the journal presents it as authoritative.
 * A read whose parameters genuinely differ is a read that cannot honestly be
 * paired, and the setter refusing it is the correct outcome.
 */
async function dispatchWrite(
    ctx: RequestContext,
    call: {
        qualified: string;
        advertisedName: string;
        transport: { url: string; authorization?: string };
        connection: { id: string; name: string; url: string; mode: ExternalWriteMode };
        policyCardVersion: number;
        outbound: Record<string, unknown>;
    },
): Promise<unknown> {
    const pairing = await getPriorStateRead(ctx, call.qualified);
    if (!pairing) {
        throw new Error(
            `external_write_unpaired: "${call.advertisedName}" is declared as a tool that may ` +
                'write, and no prior-state read has been nominated for it. Nominate one of this ' +
                "server's read-only tools on the external-tools page, so what the write replaces " +
                'is recorded before it is changed.',
        );
    }

    const readRef = parseExternalToolName(pairing.readToolName);
    if (!readRef) {
        // Unreachable through `setPriorStateRead`, which parses both names before
        // storing. Checked anyway, because the alternative to a refusal here is
        // calling `callTool` with `undefined` as the tool name.
        throw new Error(
            `external_write_unpaired: the prior-state read stored for "${call.advertisedName}" ` +
                'is not a valid external tool name.',
        );
    }

    // The read goes out through the SAME seam every other call uses, so the egress
    // scan applies to it too. It carries the write's arguments unchanged — see
    // the header.
    const priorState = await callTool(call.transport, readRef.toolName, call.outbound);

    if (call.connection.mode === 'DRY_RUN') {
        const handle = await recordIntent(ctx, {
            connectionId: call.connection.id,
            connectionName: call.connection.name,
            endpointUrl: call.connection.url,
            toolName: call.qualified,
            advertisedToolName: call.advertisedName,
            mode: call.connection.mode,
            argumentsJson: JSON.stringify(call.outbound),
            priorStateJson: JSON.stringify(priorState),
            agentId: ctx.agentId ?? null,
        });

        // Returned to the MODEL, so it says plainly that nothing happened. A dry
        // run that answered like a successful write would have the agent report a
        // change it did not make — and the run's own conclusion is what a reader
        // takes away, not the rung buried in a connection's settings.
        return {
            content: [
                {
                    type: 'text',
                    text:
                        `DRY RUN — nothing was sent. This connection is at DRY_RUN, so the change ` +
                        `was recorded and not applied. Journal reference ${handle.journalId}. ` +
                        `Do not report this as a completed change.`,
                },
            ],
            isError: false,
        };
    }

    if (call.connection.mode === 'PROPOSE_ONLY') {
        // The write becomes a row in the queue a human already reviews, carrying
        // everything that review needs: where it goes, what is called, what would
        // change, and what it replaces. `createAgentProposal` applies the shared
        // composition from here on — sanitiser, both guards, the card pin, the
        // approval tiering, the expiry window, the audit.
        //
        // NOTHING IS SENT, and nothing will be until the dispatch that runs on
        // approval exists. Approving one of these is still refused; that job is
        // the next slice.
        const proposal = await createAgentProposal(ctx, {
            kind: 'EXTERNAL_WRITE',
            payload: {
                connectionId: call.connection.id,
                connectionName: call.connection.name,
                endpointUrl: call.connection.url,
                toolName: call.qualified,
                advertisedToolName: call.advertisedName,
                arguments: call.outbound,
                priorState,
            },
            policyCardVersion: call.policyCardVersion,
        });

        // Told to the MODEL, and it has to distinguish the two outcomes: a
        // quarantined proposal never enters the review queue, so reporting it as
        // "awaiting approval" would describe a wait that nobody is going to end.
        const queued = proposal.status === 'QUARANTINED'
            ? `QUARANTINED — nothing was sent, and this will NOT be reviewed. The agentic `
              + `output guard refused the content (${proposal.guardVerdict}). Proposal `
              + `reference ${proposal.id}.`
            : `QUEUED FOR APPROVAL — nothing was sent. This connection is at PROPOSE_ONLY, so `
              + `the change was recorded and a human must approve it before it can be applied. `
              + `Proposal reference ${proposal.id}.`;
        return {
            content: [{ type: 'text', text: `${queued} Do not report this as a completed change.` }],
            isError: false,
        };
    }

    // AUTOMATIC is unreachable today: `EXTERNAL_MAX_MODE` is
    // `DRY_RUN`, so no tenant can store a wider rung, and the admin route refuses
    // one. The refusal is here anyway rather than as a comment — a rung that
    // arrives later must be refused until somebody decides what it means, which
    // is the identity ladder's lesson about inheriting permission by falling
    // through.
    throw new Error(
        `external_write_rung_unimplemented: this build dispatches no external write at ` +
            `${call.connection.mode}. Nothing was sent.`,
    );
}
