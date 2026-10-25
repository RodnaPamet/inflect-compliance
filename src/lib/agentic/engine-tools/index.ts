/**
 * THE ENGINE-NEUTRAL TOOL CORE (Step 0a, `docs/claude-agent-sdk-design.md`).
 *
 * Everything an engine needs to offer Inflect's tools to a model and run them
 * through the funnel, with no import of any engine. An engine supplies one
 * `ToolBuilder` (its tool shape) and one guard source prefix (its name), and
 * gets the narrowing, the latch and the guarded call that every other engine
 * gets. Global rule 2: the engine decides what to try; the funnel decides what
 * is permitted.
 */
export {
    asToolArgs,
    offerToolSet,
    type OfferableTool,
    type OfferedTool,
    type OfferedToolSet,
    type OriginResolver,
    type ToolBuilder,
    type ToolOmissionReason,
} from './offer-tools';
export {
    ReviewLatch,
    stepVerdictOf,
    type GuardObserver,
    type ReviewFlag,
    type StepGuardObservation,
} from './review-latch';
export { runGuardedTool } from './run-guarded-tool';
