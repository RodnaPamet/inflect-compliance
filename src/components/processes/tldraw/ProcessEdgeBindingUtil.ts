/**
 * The binding util for process edges.
 *
 * Deliberately thin. A `BindingUtil` declares one abstract member —
 * `getDefaultProps` — and everything else it can do is a lifecycle hook. The
 * edge's meaning lives in two places that are NOT here:
 *
 *   - `process-edge-binding.ts`  the props and their validators;
 *   - `edge-validation.ts`       whether an endpoint may be connected at all.
 *
 * Keeping the rules out of the util is what lets them be tested without an
 * editor, and what stops "may this edge exist" from having two answers.
 *
 * ═══ NO onBeforeCreate REFUSAL, ON PURPOSE ═══
 *
 * tldraw's binding hooks can veto a create, and it is tempting to enforce
 * `validateEdge` there. That would make the refusal invisible: the binding
 * simply would not appear, with nowhere to say why, and the user would learn
 * that some drags produce an edge and others silently do not.
 *
 * The validator returns refusals rather than throwing precisely so the surface
 * can show one. The hook is the wrong place for a decision that has to be
 * EXPLAINED — see `describeRefusal`.
 */
import { BindingUtil } from 'tldraw';
import {
    DEFAULT_EDGE_KIND,
    PROCESS_EDGE_BINDING_TYPE,
    processEdgeBindingProps,
    type ProcessEdgeBinding,
} from './process-edge-binding';

export class ProcessEdgeBindingUtil extends BindingUtil<ProcessEdgeBinding> {
    static override type = PROCESS_EDGE_BINDING_TYPE;
    static override props = processEdgeBindingProps;

    override getDefaultProps(): Partial<ProcessEdgeBinding['props']> {
        return {
            // An edge drawn in the editor has no key until one is minted for
            // it, exactly as a drawn node has no `nodeKey`. Empty rather than
            // generated: minting belongs to whatever knows the rest of the
            // map's keys, and a plausible key invented here would eventually
            // collide with a real one.
            edgeKey: '',
            sourceKey: '',
            targetKey: '',
            edgeKind: DEFAULT_EDGE_KIND,
            labelOverride: null,
            dataJson: null,
            controls: [],
        };
    }
}
