/**
 * The canvas command palette's contents, as data.
 *
 * `CanvasCommandPalette` takes `groups: CanvasCommandGroup[]` and renders them;
 * it knows nothing about either renderer. The xyflow canvas builds its 25
 * commands inline, in a 216-line literal inside a 2500-line component. This is
 * the same set, built by a pure function, so the tldraw host gets the palette
 * without copying that literal — and so the part worth checking is checkable.
 *
 * ── What is worth checking is the DISABLED logic ─────────────────────
 *
 * Labels and ordering are visible the moment anyone opens the palette. The
 * enablement rules are not: a command offered when it cannot work produces an
 * action that silently does nothing, and a command disabled when it could work
 * is a feature nobody finds. They are also not uniform, and the thresholds come
 * from the live canvas rather than from taste:
 *
 *   align       needs >= 2 selected — aligning one shape to itself is a no-op
 *   distribute  needs >= 3 — two shapes are already evenly spaced
 *   arrange a selection
 *               needs >= 2 — laying out one node moves it to the origin of its
 *               own private graph, which looks like the node being flung away
 *   group       needs >= 2; ungroup needs >= 1
 *
 * ── Two commands are OPTIONAL, because one host cannot do them ───────
 *
 * `newAutomation` and `newFromTemplate` are optional actions, and a command is
 * emitted only when its action is supplied. The tldraw workspace supplies
 * neither: `useTldrawDocumentBar`'s `handleNew` takes no argument and hardcodes
 * `canvasMode: 'DOCUMENT'`, and `ProcessTemplateModal` is not mounted there.
 *
 * Optional rather than removed, and that distinction is the design. Removing
 * them would bake one host's current limitation into the shared builder, so the
 * xyflow canvas could not use it and a later fix to that handler would need
 * this file edited again. Omitting a command whose action is absent means the
 * palette offers exactly what the host can actually do — and a command that
 * opened nothing would be worse than a missing one, because the user would read
 * it as broken rather than unavailable.
 */
import type {
    CanvasCommand,
    CanvasCommandGroup,
} from '@/components/processes/CanvasCommandPalette';

/** Which way a hierarchical layout runs. Mirrors `AutoLayoutDirection`. */
export type CommandLayoutDirection = 'LR' | 'TB';
/** Whether a layout covers the whole map or just the selection. */
export type CommandLayoutScope = 'all' | 'selection';
/** The six edges `editor.alignShapes` understands. */
export type CommandAlignEdge =
    | 'left'
    | 'center-horizontal'
    | 'right'
    | 'top'
    | 'center-vertical'
    | 'bottom';

/**
 * What the palette can ask for.
 *
 * Callbacks rather than an `Editor`, so this module is pure and its enablement
 * rules are testable without mounting one. The host supplies them from the
 * document bar's handlers, the auto-layout host, and tldraw's own editor.
 */
export interface CanvasCommandActions {
    save: () => void;
    undo: () => void;
    redo: () => void;
    duplicate: () => void;
    newDocument: () => void;
    /** Omit on a host whose create path cannot choose a canvas mode. */
    newAutomation?: () => void;
    /** Omit on a host that does not mount `ProcessTemplateModal`. */
    newFromTemplate?: () => void;
    arrange: (direction: CommandLayoutDirection, scope: CommandLayoutScope) => void;
    arrangeForce: (scope: CommandLayoutScope) => void;
    group: () => void;
    ungroup: () => void;
    align: (edge: CommandAlignEdge) => void;
    distribute: (axis: 'horizontal' | 'vertical') => void;
    deleteSelection: () => void;
    toggleSnap: () => void;
}

/** Everything the enablement rules read. */
export interface CanvasCommandContext {
    /** False when no map is open — most document commands need one. */
    hasMap: boolean;
    /** Saving, creating or duplicating: a write is already in flight. */
    busy: boolean;
    canUndo: boolean;
    canRedo: boolean;
    /** Process nodes on the canvas. Zero means nothing to arrange. */
    nodeCount: number;
    /** Selected process nodes. */
    selectionCount: number;
    /** Drives the snap command's LABEL, not its enablement. */
    snapEnabled: boolean;
}

export function buildCanvasCommandGroups(
    t: (key: string) => string,
    ctx: CanvasCommandContext,
    actions: CanvasCommandActions,
): CanvasCommandGroup[] {
    const document: CanvasCommand[] = [
        {
            id: 'save',
            label: t('cmdSaveLabel'),
            description: t('cmdSaveDesc'),
            shortcut: '⌘S',
            disabled: !ctx.hasMap || ctx.busy,
            onSelect: actions.save,
        },
        {
            id: 'undo',
            label: t('cmdUndoLabel'),
            description: t('cmdUndoDesc'),
            shortcut: '⌘Z',
            disabled: !ctx.canUndo || ctx.busy,
            onSelect: actions.undo,
        },
        {
            id: 'redo',
            label: t('cmdRedoLabel'),
            description: t('cmdRedoDesc'),
            shortcut: '⌘⇧Z',
            disabled: !ctx.canRedo || ctx.busy,
            onSelect: actions.redo,
        },
        {
            id: 'duplicate',
            label: t('cmdDuplicateLabel'),
            description: t('cmdDuplicateDesc'),
            disabled: !ctx.hasMap || ctx.busy,
            onSelect: actions.duplicate,
        },
        {
            id: 'new',
            label: t('cmdNewLabel'),
            description: t('cmdNewDesc'),
            disabled: ctx.busy,
            onSelect: actions.newDocument,
        },
    ];

    // Appended only when the host can perform them — see the header.
    if (actions.newAutomation) {
        document.push({
            id: 'new-automation',
            label: t('cmdNewAutomationLabel'),
            description: t('cmdNewAutomationDesc'),
            disabled: ctx.busy,
            onSelect: actions.newAutomation,
        });
    }
    if (actions.newFromTemplate) {
        document.push({
            id: 'new-from-template',
            label: t('cmdNewFromTemplateLabel'),
            description: t('cmdNewFromTemplateDesc'),
            disabled: ctx.busy,
            onSelect: actions.newFromTemplate,
        });
    }

    // Nothing to arrange on an empty canvas, and a selection layout needs two
    // nodes to be relative to — see the header.
    const noNodes = ctx.nodeCount === 0 || ctx.busy;
    const noPair = ctx.selectionCount < 2 || ctx.busy;
    const layout: CanvasCommand[] = [
        {
            id: 'arrange-lr',
            label: t('cmdArrangeLrLabel'),
            description: t('cmdArrangeLrDesc'),
            disabled: noNodes,
            onSelect: () => actions.arrange('LR', 'all'),
        },
        {
            id: 'arrange-tb',
            label: t('cmdArrangeTbLabel'),
            description: t('cmdArrangeTbDesc'),
            disabled: noNodes,
            onSelect: () => actions.arrange('TB', 'all'),
        },
        {
            id: 'arrange-selection-lr',
            label: t('cmdArrangeSelLrLabel'),
            description: t('cmdArrangeSelLrDesc'),
            disabled: noPair,
            onSelect: () => actions.arrange('LR', 'selection'),
        },
        {
            id: 'arrange-selection-tb',
            label: t('cmdArrangeSelTbLabel'),
            description: t('cmdArrangeSelTbDesc'),
            disabled: noPair,
            onSelect: () => actions.arrange('TB', 'selection'),
        },
        {
            id: 'arrange-force',
            label: t('cmdArrangeForceLabel'),
            description: t('cmdArrangeForceDesc'),
            disabled: noNodes,
            onSelect: () => actions.arrangeForce('all'),
        },
        {
            id: 'arrange-force-selection',
            label: t('cmdArrangeForceSelLabel'),
            description: t('cmdArrangeForceSelDesc'),
            disabled: noPair,
            onSelect: () => actions.arrangeForce('selection'),
        },
    ];

    const align = (id: string, key: string, edge: CommandAlignEdge): CanvasCommand => ({
        id,
        label: t(key),
        // No `description`: the live canvas gives these none, and inventing six
        // would mean six new strings in every locale to say what the label
        // already says.
        disabled: ctx.selectionCount < 2 || ctx.busy,
        onSelect: () => actions.align(edge),
    });

    const selection: CanvasCommand[] = [
        {
            id: 'group',
            label: t('cmdGroupLabel'),
            description: t('cmdGroupDesc'),
            disabled: ctx.selectionCount < 2 || ctx.busy,
            onSelect: actions.group,
        },
        {
            id: 'ungroup',
            label: t('cmdUngroupLabel'),
            description: t('cmdUngroupDesc'),
            disabled: ctx.selectionCount < 1 || ctx.busy,
            onSelect: actions.ungroup,
        },
        align('align-left', 'cmdAlignLeftLabel', 'left'),
        align('align-center-x', 'cmdAlignCenterXLabel', 'center-horizontal'),
        align('align-right', 'cmdAlignRightLabel', 'right'),
        align('align-top', 'cmdAlignTopLabel', 'top'),
        align('align-center-y', 'cmdAlignCenterYLabel', 'center-vertical'),
        align('align-bottom', 'cmdAlignBottomLabel', 'bottom'),
        {
            id: 'distribute-h',
            label: t('cmdDistributeHLabel'),
            // THREE, not two: two shapes are already evenly spaced, so the
            // command would appear to do nothing.
            disabled: ctx.selectionCount < 3 || ctx.busy,
            onSelect: () => actions.distribute('horizontal'),
        },
        {
            id: 'distribute-v',
            label: t('cmdDistributeVLabel'),
            disabled: ctx.selectionCount < 3 || ctx.busy,
            onSelect: () => actions.distribute('vertical'),
        },
        {
            id: 'delete',
            label: t('cmdDeleteLabel'),
            description: t('cmdDeleteDesc'),
            shortcut: '⌫',
            disabled: ctx.selectionCount < 1 || ctx.busy,
            onSelect: actions.deleteSelection,
        },
    ];

    const modes: CanvasCommand[] = [
        {
            id: 'snap-toggle',
            // The LABEL carries the state, as it does on the live canvas: a
            // toggle whose label does not change leaves the user guessing which
            // way it is currently set.
            label: ctx.snapEnabled ? t('cmdSnapOnLabel') : t('cmdSnapOffLabel'),
            description: t('cmdSnapDesc'),
            // Never disabled by `busy`: it changes a view preference, writes
            // nothing, and is the one command that is still useful mid-save.
            onSelect: actions.toggleSnap,
        },
    ];

    return [
        { heading: t('groupDocument'), commands: document },
        { heading: t('groupLayout'), commands: layout },
        { heading: t('groupSelection'), commands: selection },
        { heading: t('groupModes'), commands: modes },
    ];
}
