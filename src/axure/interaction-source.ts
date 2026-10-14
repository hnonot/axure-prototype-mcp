/**
 * The in-page interaction reader source.
 *
 * ## What the live deployment actually looks like
 *
 * Established by probing the reference Axure 10 deployment, not by assumption:
 *
 * | What | Where |
 * |---|---|
 * | The decoded page model | `window.__axureMcpPageModel`, captured by the adapter from `$axure.loadCurrentPage(data)` |
 * | The widget tree | `model.page.diagram.objects`, nested via `objs` |
 * | A widget | `{ id, label, friendlyType, type, interactionMap?, ... }` where `id` is a 32-char hash |
 * | Its DOM id | `model.objectPaths[widget.id].scriptId`, e.g. `u1363` — **1119/1119 widgets match** |
 * | Its interactions | `interactionMap[event].cases[].actions[]` |
 * | An event | `{ eventType: 'OnClick', description: 'Click or Tap', cases: [...] }` |
 * | A case | `{ description, conditionString, condition?, actions: [...] }` |
 * | An action | `{ action, displayName, description, targetIds?, expr? }` |
 *
 * ## Why the model and not the DOM
 *
 * The DOM only shows the *result* of an interaction, and a widget with `cursor: pointer` may or
 * may not have one — so appearance cannot establish a fact. The model states it outright.
 *
 * ## Why it stays defensive anyway
 *
 * A different Axure version, or a page built differently, may differ. Every field is read through
 * a candidate list, anything unrecognized is preserved verbatim in `rawType`/`rawTrigger`, and a
 * source that cannot be read produces a `gap` rather than an empty list that would read as "this
 * page has no interactions". Normalizing the payloads is `interaction.ts`'s job, which is pure
 * and testable.
 *
 * The declaration follows the adapter's single in-page convention and is named to satisfy
 * `INPAGE_FACTORY_NAME` (see `inpage.ts`).
 */
export const INTERACTION_SOURCE = `function axureExtractOutline(options) {
  const gaps = [];
  const warnings = [];
  const maxWidgets = (options && options.maxWidgets) || 400;

  // ---- the captured model --------------------------------------------------
  const model = window.__axureMcpPageModel;

  if (!model) {
    gaps.push({
      source: 'axure-project-model',
      reason: 'the page model was not captured: $axure.loadCurrentPage did not run, or the capture hook was not installed before it did',
      impact: 'declared interactions cannot be read on this page',
    });
  }

  const page = model && model.page;
  if (model && !page) {
    gaps.push({
      source: 'axure-project-model.page',
      reason: 'the captured model has no page property',
      impact: 'declared interactions cannot be read on this page',
    });
  }

  // ---- helpers -------------------------------------------------------------

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function safeKeys(value) {
    try {
      return Object.getOwnPropertyNames(value);
    } catch (error) {
      return [];
    }
  }

  // ---- id bridge: model hash -> DOM id ------------------------------------
  // Two sources, both measured on the reference deployment:
  // - objectPaths[hash].scriptId covers page-level widgets (exact for all 1119 on 订单管理).
  // - a widget's own scriptIds[0] covers master widgets, which have no objectPaths entry at all
  //   (exact 18/18 inside the master on 版本更新记录).
  // Both are merged, because a single interaction can reference a widget recorded by either one —
  // for example a page-level button switching a panel that lives inside a master.
  const hashToScriptId = Object.create(null);
  let mappedFromObjectPaths = 0;
  let mappedFromWidgets = 0;

  try {
    const objectPaths = model && model.objectPaths;
    if (isPlainObject(objectPaths)) {
      const hashes = safeKeys(objectPaths);
      for (let index = 0; index < hashes.length; index += 1) {
        const hash = hashes[index];
        const entry = objectPaths[hash];
        const scriptId = entry && isPlainObject(entry) ? entry.scriptId : undefined;
        if (typeof scriptId === 'string' && scriptId && hashToScriptId[hash] === undefined) {
          hashToScriptId[hash] = scriptId;
          mappedFromObjectPaths += 1;
        }
      }
    }
  } catch (error) {
    gaps.push({
      source: 'axure-project-model.objectPaths',
      reason: 'reading the id bridge threw: ' + String(error),
      impact: 'some interactions may not be attributed to widgets',
    });
  }

  // Index every widget that carries its own DOM id, so master widgets are resolvable too.
  const indexWidgetScriptIds = (node, depth) => {
    if (!isPlainObject(node) || depth > 20) return;
    const scriptIds = node.scriptIds;
    const own = Array.isArray(scriptIds) ? scriptIds[0] : scriptIds;
    if (typeof node.id === 'string' && typeof own === 'string' && own && hashToScriptId[node.id] === undefined) {
      hashToScriptId[node.id] = own;
      mappedFromWidgets += 1;
    }
    const descend = (children) => {
      if (!Array.isArray(children)) return;
      for (let index = 0; index < children.length; index += 1) indexWidgetScriptIds(children[index], depth + 1);
    };
    descend(node.objs);
    descend(node.objects);
    if (Array.isArray(node.diagrams)) {
      for (let index = 0; index < node.diagrams.length; index += 1) {
        const diagram = node.diagrams[index];
        if (isPlainObject(diagram)) {
          descend(diagram.objects);
          descend(diagram.objs);
        }
      }
    }
  };

  try {
    const pageDiagram = page && page.diagram;
    if (pageDiagram && Array.isArray(pageDiagram.objects)) {
      for (let index = 0; index < pageDiagram.objects.length; index += 1) indexWidgetScriptIds(pageDiagram.objects[index], 0);
    }
    const masters = model && model.masters;
    if (isPlainObject(masters)) {
      const masterIds = safeKeys(masters);
      for (let index = 0; index < masterIds.length; index += 1) {
        const master = masters[masterIds[index]];
        const masterDiagram = master && isPlainObject(master) ? master.diagram : undefined;
        if (masterDiagram && Array.isArray(masterDiagram.objects)) {
          for (let inner = 0; inner < masterDiagram.objects.length; inner += 1) {
            indexWidgetScriptIds(masterDiagram.objects[inner], 0);
          }
        }
      }
    }
  } catch (error) {
    gaps.push({
      source: 'axure-project-model.widgets',
      reason: 'indexing widget DOM ids threw: ' + String(error),
      impact: 'some interactions may not be attributed to widgets',
    });
  }

  if (model && mappedFromObjectPaths === 0 && mappedFromWidgets === 0) {
    gaps.push({
      source: 'axure-project-model.idBridge',
      reason: 'no widget-to-DOM id mapping was present in objectPaths or in any widget scriptIds',
      impact: 'declared interactions cannot be attributed to widgets and are therefore not reported',
    });
  }

  // ---- widget tree walk ----------------------------------------------------

  const entries = [];
  let widgetsSeen = 0;
  let withoutScriptId = 0;
  let masterDiagrams = 0;
  let truncated = false;

  const remember = (widget, scriptId) => {
    const interaction = {};
    const map = widget.interactionMap;
    if (isPlainObject(map)) {
      const eventNames = safeKeys(map);
      for (let index = 0; index < eventNames.length; index += 1) {
        const eventName = eventNames[index];
        const event = map[eventName];
        if (event !== undefined) interaction[eventName] = event;
      }
    }
    const links = widget.link !== undefined ? widget.link : widget.links;
    if (links !== undefined) interaction.link = links;

    if (Object.keys(interaction).length === 0) return;

    if (entries.length >= maxWidgets) {
      truncated = true;
      return;
    }

    // setPanelState addresses its panel by model hash through panelsToStates[].panelPath, which
    // the page map cannot join on. The reader holds the hash-to-DOM-id bridge, so it annotates
    // those actions here rather than pushing the mapping into the pure decoder.
    const panelIds = [];
    for (const eventName of Object.keys(interaction)) {
      const event = interaction[eventName];
      const cases = event && isPlainObject(event) && Array.isArray(event.cases) ? event.cases : [];
      for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
        const caseEntry = cases[caseIndex];
        const actions = caseEntry && isPlainObject(caseEntry) && Array.isArray(caseEntry.actions) ? caseEntry.actions : [];
        for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
          const action = actions[actionIndex];
          if (!isPlainObject(action)) continue;
          const panels = Array.isArray(action.panelsToStates) ? action.panelsToStates : [];
          for (let panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
            const panel = panels[panelIndex];
            const path = panel && isPlainObject(panel) && Array.isArray(panel.panelPath) ? panel.panelPath : [];
            const hash = path.length ? path[path.length - 1] : undefined;
            const resolved = typeof hash === 'string' ? hashToScriptId[hash] : undefined;
            if (resolved) panelIds.push({ eventName: eventName, caseIndex: caseIndex, actionIndex: actionIndex, panelId: resolved });
          }
        }
      }
    }

    const entry = {
      widgetId: scriptId,
      modelId: typeof widget.id === 'string' ? widget.id : undefined,
      widgetName: typeof widget.label === 'string' && widget.label ? widget.label : undefined,
      widgetType: typeof widget.friendlyType === 'string' ? widget.friendlyType : undefined,
      interaction: interaction,
    };
    if (panelIds.length) entry.panelIds = panelIds;
    entries.push(entry);
  };

  // Resolve a modelled widget to the DOM id the page map addresses.
  //
  // Two bridges exist, and which one applies depends on where the widget lives:
  // - a *page-level* widget carries no scriptIds; objectPaths[hash].scriptId maps it (measured
  //   exact for all 1119 widgets on the reference page).
  // - a *master* widget carries its DOM id directly in scriptIds[0] (measured exact 18/18 where
  //   the master has no objectPaths at all).
  // Both are tried, so a widget is attributed however its owner records the mapping.
  const resolveScriptId = (node) => {
    const scriptIds = node.scriptIds;
    if (Array.isArray(scriptIds)) {
      for (let index = 0; index < scriptIds.length; index += 1) {
        const candidate = scriptIds[index];
        if (typeof candidate === 'string' && candidate) return candidate;
      }
    } else if (typeof scriptIds === 'string' && scriptIds) {
      return scriptIds;
    }
    return typeof node.id === 'string' ? hashToScriptId[node.id] : undefined;
  };

  const visit = (node, depth) => {
    if (!isPlainObject(node) || depth > 20) {
      if (depth > 20) truncated = true;
      return;
    }
    widgetsSeen += 1;

    if (node.interactionMap !== undefined || node.link !== undefined || node.links !== undefined) {
      const scriptId = resolveScriptId(node);
      if (scriptId) remember(node, scriptId);
      else withoutScriptId += 1;
    }

    // Children live under objs on page diagrams and under both objs and diagrams[].objects
    // inside masters, which is where the reference prototype keeps its richer interactions.
    const descend = (children) => {
      if (!Array.isArray(children)) return;
      for (let index = 0; index < children.length; index += 1) visit(children[index], depth + 1);
    };
    descend(node.objs);
    descend(node.objects);
    if (Array.isArray(node.diagrams)) {
      for (let index = 0; index < node.diagrams.length; index += 1) {
        const diagram = node.diagrams[index];
        if (isPlainObject(diagram)) {
          descend(diagram.objects);
          descend(diagram.objs);
        }
      }
    }
  };

  try {
    const diagram = page && page.diagram;
    const roots = diagram && Array.isArray(diagram.objects) ? diagram.objects : null;
    if (roots) {
      for (let index = 0; index < roots.length; index += 1) visit(roots[index], 0);
    } else if (page) {
      gaps.push({
        source: 'axure-project-model.page.diagram.objects',
        reason: 'the page model has no diagram.objects array',
        impact: 'declared interactions cannot be read on this page',
      });
    }

    // Masters are a separate top-level container. On the reference prototype the richer
    // interactions (panel-state switches and link navigation) live here, so skipping the container
    // silently lost them.
    const masters = model && model.masters;
    if (isPlainObject(masters)) {
      const masterIds = safeKeys(masters);
      for (let index = 0; index < masterIds.length; index += 1) {
        const master = masters[masterIds[index]];
        if (!isPlainObject(master)) continue;
        masterDiagrams += 1;
        const masterDiagram = master.diagram;
        const masterObjects = masterDiagram && Array.isArray(masterDiagram.objects) ? masterDiagram.objects : null;
        if (masterObjects) {
          for (let inner = 0; inner < masterObjects.length; inner += 1) visit(masterObjects[inner], 0);
        }
      }
    }
  } catch (error) {
    gaps.push({
      source: 'axure-project-model.page.diagram',
      reason: 'the widget tree walk threw: ' + String(error),
      impact: 'some declared interactions may be missing',
    });
  }

  if (withoutScriptId > 0) {
    warnings.push(
      withoutScriptId + ' widget(s) declared an interaction but had no DOM id mapping, so they were omitted'
    );
  }

  // Page-level interactionMap sits on the page object rather than on a widget.
  try {
    if (page && page.interactionMap && isPlainObject(page.interactionMap) && Object.keys(page.interactionMap).length) {
      warnings.push('the page itself declares an interactionMap, which is not attributed to a widget and was skipped');
    }
  } catch (error) {
    /* best-effort */
  }

  // ---- DOM observations (inferred, never declared) -------------------------
  // Kept in a separate channel so the analyzer can label them 'inferred'. They exist so a page
  // whose model could not be read still yields something, clearly marked as a guess.

  const domCandidates = [];
  try {
    const base = document.getElementById('base') || document.body;
    const widgetIdPattern = /^u[0-9]+$/;
    const elements = base ? base.querySelectorAll('[id]') : [];
    for (let index = 0; index < elements.length; index += 1) {
      const el = elements[index];
      const id = el.id;
      if (!widgetIdPattern.test(id)) continue;
      const reasons = [];
      let computed = null;
      try {
        computed = getComputedStyle(el);
      } catch (error) {
        computed = null;
      }
      if (computed && computed.cursor === 'pointer') reasons.push('css-cursor-pointer');
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'select' || tag === 'textarea') reasons.push('form-element:' + tag);
      try {
        if (el.hasAttribute && el.hasAttribute('tabindex')) reasons.push('focusable:tabindex');
        const role = el.getAttribute ? el.getAttribute('role') : null;
        if (role) reasons.push('role:' + role);
        if (el.querySelector && el.querySelector('input, select, textarea')) reasons.push('contains-form-element');
      } catch (error) {
        /* attribute reads are best-effort */
      }
      if (reasons.length) domCandidates.push({ widgetId: id, reasons: reasons });
    }
  } catch (error) {
    warnings.push('DOM observation pass failed: ' + String(error));
  }

  return {
    ok: true,
    modelCaptured: !!model,
    widgetsWithInteractionsFound: entries.length,
    idBridgeSize: mappedFromObjectPaths + mappedFromWidgets,
    idBridgeFromObjectPaths: mappedFromObjectPaths,
    idBridgeFromWidgets: mappedFromWidgets,
    masterDiagrams: masterDiagrams,
    entries: entries,
    domCandidates: domCandidates,
    gaps: gaps,
    warnings: warnings,
    truncated: truncated,
    visitedObjects: widgetsSeen,
  };
}`;
