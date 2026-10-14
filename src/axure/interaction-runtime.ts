/**
 * The raw shape the in-page interaction reader returns.
 *
 * The reader's source lives in `interaction-source.ts` so it can be syntax-checked without a
 * build step; this module holds only the TypeScript type of its result and re-exports the source
 * so callers have one import.
 */

export { INTERACTION_SOURCE } from './interaction-source.js';

/**
 * Raw shape returned by `INTERACTION_SOURCE`.
 *
 * Everything here is **verbatim page data**: `interaction` holds the interaction-bearing
 * sub-objects exactly as the model stores them, under their original keys. Interpreting those
 * keys is the pure decoder's job (`interaction.ts`), which is what keeps a wrong guess about a
 * field name fixable without touching browser code.
 */
export interface RawInteractionCapture {
  ok: boolean;
  /** Whether the decoded page model was captured at all, so a caller can tell "none" from "not read". */
  modelCaptured: boolean;
  /** Size of the hash→DOM-id bridge that was available. */
  idBridgeSize: number;
  /** How much of the bridge came from `model.objectPaths` (page-level widgets). */
  idBridgeFromObjectPaths: number;
  /** How much came from widgets' own `scriptIds` (master widgets). */
  idBridgeFromWidgets: number;
  /** How many master diagrams were walked; masters hold a separate widget tree. */
  masterDiagrams: number;
  /** How many entries carried interaction data. */
  widgetsWithInteractionsFound: number;
  entries: Array<{
    /** DOM id (`u<N>`) once the bridge resolved it; empty entries are dropped in-page. */
    widgetId: string;
    /** The model's own 32-char widget hash, preserved for debugging. */
    modelId?: string;
    widgetName?: string;
    widgetType?: string;
    /** Interaction sub-objects exactly as the model stores them, keyed by their original names. */
    interaction: Record<string, unknown>;
    /**
     * Panel hashes resolved to DOM ids, keyed by the event/case/action position they belong to.
     *
     * `setPanelState` names its panel by model hash inside `panelsToStates[].panelPath`, which the
     * page map cannot join on. The reader holds the hash→DOM-id bridge, so it resolves them here.
     */
    panelIds?: Array<{ eventName: string; caseIndex: number; actionIndex: number; panelId: string }>;
  }>;
  /** DOM-only candidates, which the analyzer labels `inferred`. */
  domCandidates: Array<{ widgetId: string; reasons: string[] }>;
  /** Sources that were looked for and could not be read. */
  gaps: Array<{ source: string; reason: string; impact: string }>;
  warnings: string[];
  /** Set when the traversal hit its widget or depth limit. */
  truncated: boolean;
  visitedObjects: number;
}
