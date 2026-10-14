/**
 * In-page interaction reader: syntax, safety and behaviour, verified **without a browser**.
 *
 * The reader is a plain JavaScript string that runs inside Chromium, which makes it the easiest
 * part of the codebase to get wrong invisibly. This file therefore:
 *
 * 1. extracts the source from `src/axure/interaction-source.ts` and compiles it with
 *    `new Function`, so a syntax error or a leaked identifier fails here; and
 * 2. runs it against a **synthetic replica of the confirmed live structure** with a stubbed
 *    `window`/`document`.
 *
 * The fixture mirrors what was measured on the reference Axure 10 deployment (see
 * `.update/0.2.0/audit.md`):
 *
 * - the decoded model is `window.__axureMcpPageModel`
 * - the widget tree is `model.page.diagram.objects`, nested via `objs`
 * - a widget has `{ id: <32-char hash>, label, friendlyType, interactionMap? }`
 * - `model.objectPaths[hash].scriptId` is the DOM id (`u<N>`)
 *
 * The extraction is textual, so this runs without a build step.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
};

/** Pull the template body out of the source module. */
function loadSource() {
  const text = readFileSync(new URL('../src/axure/interaction-source.ts', import.meta.url), 'utf8');
  const start = text.indexOf('export const INTERACTION_SOURCE = `');
  assert.ok(start >= 0, 'INTERACTION_SOURCE must be declared as a template literal');
  const bodyStart = text.indexOf('`', start) + 1;
  const bodyEnd = text.lastIndexOf('`;');
  assert.ok(bodyEnd > bodyStart, 'the template literal must be terminated');
  return text.slice(bodyStart, bodyEnd);
}

const SOURCE = loadSource();

function buildReader() {
  // eslint-disable-next-line no-new-func
  return new Function(`${SOURCE}; return axureExtractOutline;`)();
}

/** Build a widget node the way the live model does. */
const widget = (hash, extra = {}) => ({ id: hash, label: '', friendlyType: 'Rectangle', type: 'vectorShape', ...extra });

/** Build a page model with the measured shape. */
function model({ objects = [], objectPaths = {} } = {}) {
  return { page: { packageId: 'p', name: 'Page', diagram: { objects } }, objectPaths };
}

/** A realistic interactionMap entry: click toggles selected state. */
const toggleSelected = {
  onClick: {
    eventType: 'OnClick',
    description: 'Click or Tap',
    cases: [
      {
        description: 'Case 1',
        conditionString: 'if is selected of This equals false',
        condition: {
          exprType: 'binaryOp',
          op: '==',
          leftExpr: { exprType: 'fcall', functionName: 'GetCheckState', arguments: [{ exprType: 'pathLiteral', isThis: true }] },
          rightExpr: { exprType: 'booleanLiteral', value: false },
        },
        actions: [
          {
            action: 'setFunction',
            displayName: 'Set Selected/Checked',
            description: 'Set is selected of This equal to &quot;true&quot;',
            expr: {
              exprType: 'block',
              subExprs: [
                {
                  exprType: 'fcall',
                  functionName: 'SetCheckState',
                  arguments: [
                    { exprType: 'pathLiteral', isThis: true },
                    { exprType: 'stringLiteral', value: 'true' },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

function runReader({ captured = undefined, elements = [], options = {} } = {}) {
  const fakeDocument = {
    getElementById: () => null,
    body: { querySelectorAll: () => elements },
  };
  const win = { __axureMcpPageModel: captured };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'window',
    'document',
    'getComputedStyle',
    `${SOURCE}; return axureExtractOutline;`,
  )(win, fakeDocument, (el) => ({ cursor: el && el.cursor ? el.cursor : 'auto' }));
  return factory({ maxWidgets: 400, ...options });
}

/* -------------------------------------------------------------------------- */
/* Syntax and isolation                                                       */
/* -------------------------------------------------------------------------- */

test('the reader source is valid plain JavaScript', () => {
  assert.equal(typeof buildReader(), 'function');
});

test('the reader defines the factory name the adapter looks for', () => {
  assert.match(SOURCE, /function axureExtractOutline\(options\)/);
});

test('the reader is self-contained: no imports, no module scope', () => {
  assert.doesNotMatch(SOURCE, /^\s*import\s/m);
  assert.doesNotMatch(SOURCE, /\brequire\(/);
  assert.doesNotMatch(SOURCE, /\bprocess\./);
  assert.doesNotMatch(SOURCE, /\b__dirname\b/);
});

test('the reader contains no TypeScript annotation', () => {
  assert.doesNotMatch(SOURCE, /\bconst\s+\w+\s*:\s*[A-Z]\w*/);
  assert.doesNotMatch(SOURCE, /\bfunction\s+\w+\([^)]*:\s*[A-Z]/);
});

/* -------------------------------------------------------------------------- */
/* Honest gap reporting                                                       */
/* -------------------------------------------------------------------------- */

test('an uncaptured model is reported as a gap, not as "no interactions"', () => {
  // The distinction matters: an empty list would read as "this page has no interactions".
  const result = runReader({ captured: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.modelCaptured, false);
  assert.deepEqual(result.entries, []);
  assert.ok(
    result.gaps.some((gap) => /page model was not captured/.test(gap.reason)),
    `expected a capture gap, saw: ${JSON.stringify(result.gaps)}`,
  );
});

test('a missing id bridge is reported, because attribution would be impossible', () => {
  const captured = model({ objects: [widget('aaaa', { interactionMap: toggleSelected })], objectPaths: {} });
  const result = runReader({ captured });
  assert.equal(result.modelCaptured, true);
  assert.equal(result.idBridgeSize, 0);
  assert.deepEqual(result.entries, []);
  assert.ok(
    result.gaps.some((gap) => /no widget-to-DOM id mapping/.test(gap.reason)),
    `expected an id-bridge gap, saw: ${JSON.stringify(result.gaps)}`,
  );
});

test('a throwing model does not crash the reader', () => {
  const captured = { page: {} };
  Object.defineProperty(captured, 'objectPaths', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  const result = runReader({ captured });
  assert.equal(result.ok, true, 'the reader must survive a hostile or broken model');
  assert.ok(result.gaps.some((gap) => /id bridge threw/.test(gap.reason)), 'the failure must be reported');
});

/* -------------------------------------------------------------------------- */
/* The id bridge and the widget walk                                          */
/* -------------------------------------------------------------------------- */

test('the reader resolves a widget to its DOM id through objectPaths', () => {
  const captured = model({
    objects: [widget('aaaa', { label: '库存管理', interactionMap: toggleSelected })],
    objectPaths: { aaaa: { scriptId: 'u5' } },
  });
  const result = runReader({ captured });
  assert.equal(result.idBridgeSize, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].widgetId, 'u5', 'the DOM id must be what the page map addresses');
  assert.equal(result.entries[0].modelId, 'aaaa', 'the model hash is preserved for debugging');
  assert.equal(result.entries[0].widgetName, '库存管理');
});

test('nested widgets are reached through objs', () => {
  const captured = model({
    objects: [
      { id: 'outer', friendlyType: 'Group', objs: [{ id: 'inner', friendlyType: 'Rectangle', interactionMap: toggleSelected }] },
    ],
    objectPaths: { inner: { scriptId: 'u42' } },
  });
  const result = runReader({ captured });
  assert.deepEqual(result.entries.map((entry) => entry.widgetId), ['u42']);
});

test('the interaction payload is preserved verbatim for the pure decoder', () => {
  const captured = model({
    objects: [widget('aaaa', { interactionMap: toggleSelected })],
    objectPaths: { aaaa: { scriptId: 'u5' } },
  });
  const result = runReader({ captured });
  // The reader keys payloads by event name (the form the pure decoder consumes), so the event
  // object reaches the decoder exactly as the model wrote it.
  assert.deepEqual(result.entries[0].interaction.onClick, toggleSelected.onClick);
});

test('a widget with no interaction data is not reported', () => {
  const captured = model({
    objects: [widget('aaaa', { interactionMap: toggleSelected }), widget('bbbb', { label: 'plain' })],
    objectPaths: { aaaa: { scriptId: 'u5' }, bbbb: { scriptId: 'u6' } },
  });
  const result = runReader({ captured });
  assert.deepEqual(result.entries.map((entry) => entry.widgetId), ['u5']);
});

test('a widget with an interaction but no id mapping is omitted and reported', () => {
  const captured = model({
    objects: [widget('aaaa', { interactionMap: toggleSelected })],
    objectPaths: {},
  });
  const result = runReader({ captured, options: { maxWidgets: 400 } });
  assert.deepEqual(result.entries, []);
  assert.ok(
    result.warnings.some((warning) => /no DOM id mapping/.test(warning)) ||
      result.gaps.some((gap) => /no widget-to-DOM id mapping/.test(gap.reason)),
    `expected the omission to be reported, saw gaps=${JSON.stringify(result.gaps)} warnings=${JSON.stringify(result.warnings)}`,
  );
});

test('the widget cap is enforced and reported', () => {
  const objects = [];
  const objectPaths = {};
  for (let index = 0; index < 20; index += 1) {
    objects.push(widget(`w${index}`, { interactionMap: toggleSelected }));
    objectPaths[`w${index}`] = { scriptId: `u${index}` };
  }
  const result = runReader({ captured: model({ objects, objectPaths }), options: { maxWidgets: 5 } });
  assert.equal(result.entries.length, 5, 'entries must be capped');
  assert.equal(result.truncated, true, 'truncation must be reported rather than silent');
});

test('a link-only widget is reported even without an interactionMap', () => {
  const captured = model({
    objects: [widget('aaaa', { link: { type: 'navigate', pageId: 'other' } })],
    objectPaths: { aaaa: { scriptId: 'u7' } },
  });
  const result = runReader({ captured });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].interaction.link, { type: 'navigate', pageId: 'other' });
});

/* -------------------------------------------------------------------------- */
/* Masters: a separate container with a different id bridge                   */
/* -------------------------------------------------------------------------- */

test('master interactions are found through model.masters', () => {
  // Regression: the reader only walked `page.diagram.objects`, so an entire page of real
  // interactions — those inside a master — was silently reported as none.
  const captured = {
    page: { diagram: { objects: [] } },
    objectPaths: {},
    masters: {
      masterhash: {
        packageId: 'm',
        diagram: {
          objects: [
            {
              id: 'group1',
              friendlyType: 'Group',
              objs: [
                {
                  id: 'aaa',
                  friendlyType: 'Rectangle',
                  interactionMap: toggleSelected,
                  scriptIds: ['u5'],
                },
              ],
            },
          ],
        },
      },
    },
  };
  const result = runReader({ captured });
  assert.equal(result.entries.length, 1, `expected the master interaction, saw ${JSON.stringify(result.entries)}`);
  assert.equal(result.entries[0].widgetId, 'u5');
  assert.equal(result.masterDiagrams, 1);
});

test('a master widget resolves its DOM id from scriptIds when objectPaths is empty', () => {
  // Measured on the reference prototype: master widgets carry the DOM id in `scriptIds[0]` while
  // the master has no `objectPaths` at all (18/18 exact).
  const captured = {
    page: { diagram: { objects: [] } },
    objectPaths: {},
    masters: {
      m: { diagram: { objects: [{ id: 'h1', interactionMap: toggleSelected, scriptIds: ['u23'] }] } },
    },
  };
  const result = runReader({ captured });
  assert.equal(result.idBridgeFromObjectPaths, 0, 'no page-level bridge exists on this shape');
  assert.equal(result.idBridgeFromWidgets, 1, 'the widget scriptId supplies the bridge');
  assert.deepEqual(result.entries.map((entry) => entry.widgetId), ['u23']);
  assert.equal(result.entries[0].modelId, 'h1');
});

test('both bridges are merged, so a page button can target a master panel', () => {
  // Measured: a page-level button switches a panel that lives inside a master. The button is
  // resolved from objectPaths and the panel from scriptIds, so a single bridge is not enough.
  const captured = {
    page: {
      diagram: {
        objects: [
          {
            id: 'button',
            friendlyType: 'Rectangle',
            interactionMap: {
              onClick: {
                cases: [
                  {
                    actions: [
                      {
                        action: 'setPanelState',
                        displayName: 'Set Panel State',
                        panelsToStates: [{ panelPath: ['panelhash'], stateInfo: { stateValue: { value: '1' } } }],
                      },
                    ],
                  },
                ],
              },
            },
            scriptIds: ['u5'],
          },
        ],
      },
    },
    objectPaths: {},
    masters: {
      m: { diagram: { objects: [{ id: 'panelhash', friendlyType: 'Dynamic Panel', scriptIds: ['u4'] }] } },
    },
  };
  const result = runReader({ captured });
  const entry = result.entries.find((candidate) => candidate.widgetId === 'u5');
  assert.ok(entry, `expected u5 in ${JSON.stringify(result.entries)}`);
  assert.deepEqual(entry.panelIds, [{ eventName: 'onClick', caseIndex: 0, actionIndex: 0, panelId: 'u4' }]);
});

test('nested master panel states are reached through diagrams[].objects', () => {
  const captured = {
    page: { diagram: { objects: [] } },
    objectPaths: {},
    masters: {
      m: {
        diagram: {
          objects: [
            {
              id: 'panel',
              friendlyType: 'Dynamic Panel',
              diagrams: [
                { objects: [] },
                { objects: [{ id: 'h2', interactionMap: toggleSelected, scriptIds: ['u10'] }] },
              ],
            },
          ],
        },
      },
    },
  };
  const result = runReader({ captured });
  assert.deepEqual(result.entries.map((entry) => entry.widgetId), ['u10']);
});

test('objectPaths still wins for page-level widgets that carry no scriptIds', () => {
  const captured = model({
    objects: [widget('aaaa', { interactionMap: toggleSelected })],
    objectPaths: { aaaa: { scriptId: 'u575' } },
  });
  const result = runReader({ captured });
  assert.deepEqual(result.entries.map((entry) => entry.widgetId), ['u575']);
});

/* -------------------------------------------------------------------------- */
/* DOM observations are guesses, and are collected separately                 */
/* -------------------------------------------------------------------------- */

function fakeElement(id, { cursor = 'auto', tag = 'div', tabindex = null, role = null, hasForm = false } = {}) {
  return {
    id,
    tagName: tag.toUpperCase(),
    cursor,
    hasAttribute: (name) => name === 'tabindex' && tabindex !== null,
    getAttribute: (name) => (name === 'role' ? role : null),
    querySelector: () => (hasForm ? {} : null),
  };
}

test('DOM candidates carry reasons and never become model entries', () => {
  const result = runReader({
    captured: undefined,
    elements: [
      fakeElement('u5', { cursor: 'pointer' }),
      fakeElement('u9', { tag: 'input' }),
      fakeElement('u11', { tabindex: '0' }),
      fakeElement('u12', { role: 'button' }),
      fakeElement('u13'),
      fakeElement('not-a-widget', { cursor: 'pointer' }),
    ],
  });

  const byId = new Map(result.domCandidates.map((candidate) => [candidate.widgetId, candidate.reasons]));
  assert.deepEqual(byId.get('u5'), ['css-cursor-pointer']);
  assert.deepEqual(byId.get('u9'), ['form-element:input']);
  assert.deepEqual(byId.get('u11'), ['focusable:tabindex']);
  assert.deepEqual(byId.get('u12'), ['role:button']);
  assert.equal(byId.has('u13'), false, 'a plain div is not a candidate');
  assert.equal(byId.has('not-a-widget'), false, 'only u<number> ids are widgets');
  assert.deepEqual(result.entries, [], 'DOM observations must never become model entries');
});

console.log(`\n${failures === 0 ? 'all in-page interaction reader checks passed' : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
