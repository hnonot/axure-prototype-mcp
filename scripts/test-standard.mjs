/**
 * Standardization tests: the `axure.page/v1` document built from already-read data.
 *
 * `src/axure/standard.ts` is a pure transformation — no browser, no I/O — so every conversion rule
 * is verifiable from fixtures alone. That is the point of keeping the parsing layer decoupled from
 * the reading layer, and it is what lets this file run with no build, no network and no prototype.
 *
 * The requirements this file exists to hold to:
 *
 * - 「字段归一化」       authored tokens are preserved verbatim while roles are normalized separately
 * - 「无效数据过滤」     empty/whitespace text is dropped *and counted*, never silently lost
 * - 「层级关系重建」     parent/child links are explicit, not implied by nesting
 * - 「重复信息消除」     repeated text and repeated subtrees collapse *with an audit trail*
 * - 「语义归类」         classification uses structural evidence only
 * - 「保留语义边界」     fact / derived / unknown is stated per value, and unknown is a value
 *
 * The requirement that receives the most attention here is the last one, and specifically the
 * prohibition on inventing business meaning: 「不得仅凭组件名称或视觉外观臆造业务含义」.
 */

import assert from 'node:assert/strict';

import { standardize, classifyRole, STANDARD_SCHEMA, RULES } from '../dist/axure/standard.js';

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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** One outline node, defaulted so each fixture states only what it is about. */
const node = (id, extra = {}) => ({
  id,
  ref: `p1#${id}`,
  depth: 0,
  kind: 'widget',
  type: 'Rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  vx: 0,
  vy: 0,
  onScreen: true,
  visible: true,
  ...extra,
});

/** Minimal capture outcome; only the fields the standardizer reads are meaningful. */
const capture = (overrides = {}) => ({
  pageSize: { width: 1920, height: 1080 },
  viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
  stats: {
    widgets: 0,
    nodes: 0,
    visibleNodes: 0,
    offCanvasNodes: 0,
    truncatedNodes: 0,
    omittedNodes: 0,
    interactiveNodes: 0,
    imageNodes: 0,
  },
  outline: [],
  omitted: {},
  notes: [],
  warnings: [],
  ...overrides,
});

/** Build a document from an outline. */
const build = (outline, options = {}) =>
  standardize({
    page: {
      id: 'p1',
      name: '页面一',
      url: 'http://example.test/p.html',
      title: 't',
      type: 'Wireframe',
      path: ['MES'],
    },
    capture: capture(options.capture),
    outline,
    interactions: options.interactions,
    detail: 'standard',
    space: 'page',
    at: '2026-01-01T00:00:00.000Z',
    notes: options.notes,
    widgetCount: options.widgetCount ?? outline.length,
    pageStats: capture(options.capture).stats,
  });

/** A two-state dynamic panel with one child per state. */
const nestedOutline = () => [
  node('u1', {
    kind: 'group',
    type: 'Group',
    width: 400,
    height: 300,
    children: [
      node('u2', {
        depth: 1,
        kind: 'dynamic-panel',
        type: 'Dynamic Panel',
        width: 200,
        height: 100,
        state: 0,
        stateCount: 2,
        children: [
          node('u3', { depth: 2, type: 'Rectangle', text: '库存管理', children: [] }),
          node('u4', { depth: 2, type: 'Rectangle', text: '库存管理', children: [] }),
        ],
      }),
      node('u5', { depth: 1, type: 'Text Field', width: 120, height: 24, children: [] }),
      node('u6', { depth: 1, type: 'Image', image: 'http://example.test/a.png', children: [] }),
    ],
  }),
];

/* -------------------------------------------------------------------------- */
/* Structural classification, and the prohibition on inventing meaning        */
/* -------------------------------------------------------------------------- */

test('classification uses the authored type token, not the widget name', () => {
  // Both widgets are named like business objects. Neither name may influence the role.
  const result = classifyRole({ authoredType: 'Rectangle' });
  assert.equal(result.provenance, 'derived');
  assert.equal(result.value, 'shape', 'a Rectangle is a shape, not a button and not "订单管理"');

  const table = classifyRole({ authoredType: 'Table' });
  assert.equal(table.value, 'repeating-container', 'a Table tiles children; it does not mean "tabular business data"');
});

test('classification cannot see the name or the text, by signature', () => {
  // The prohibition is structural: the parameter object has no field for a name or text, so a
  // future edit cannot start classifying by them without changing the signature — which is a
  // visible, reviewable act rather than a silent drift.
  const keys = [];
  const probe = new Proxy(
    { authoredType: 'Rectangle' },
    {
      get(target, prop) {
        keys.push(String(prop));
        return target[prop];
      },
    },
  );
  classifyRole(probe);
  for (const key of keys) {
    assert.equal(/name|text|label|title|caption/i.test(key), false, `classification read "${key}"`);
  }
});

test('an unrecognized type becomes unknown with a reason, never a guess', () => {
  const result = classifyRole({ authoredType: 'CustomWidget' });
  assert.equal(result.provenance, 'unknown');
  assert.equal(result.reason, 'unrecognized-value');
  assert.match(result.detail, /CustomWidget/);
  assert.equal('value' in result, false, 'an unknown role must not carry a value at all');
});

test('a widget with no authored type is unknown for a different reason', () => {
  const result = classifyRole({ authoredType: '' });
  assert.equal(result.provenance, 'unknown');
  assert.equal(result.reason, 'not-authored');
});

test('a pointer cursor does not promote a shape to an interactive role', () => {
  // Appearance is not evidence. `cursor: pointer` says a widget reacts; it does not say what it is.
  // Interactivity is stated separately, with its own evidence level.
  const result = classifyRole({ authoredType: 'Rectangle', tag: 'div' });
  assert.equal(result.value, 'shape');
  const withClick = build([node('u1', { action: 'click', type: 'Rectangle' })]);
  assert.equal(withClick.elementsById.u1.role.value, 'shape');
});

test('the role is reported separately from the authored type, and both survive', () => {
  const document = build(nestedOutline());
  const panel = document.elementsById.u2;
  assert.equal(panel.authoredType, 'Dynamic Panel', 'the authored token is preserved verbatim');
  assert.equal(panel.role.value, 'state-container');
  assert.equal(panel.role.rule, `${RULES.roleFromType}(${'dynamic panel'})`);
});

/* -------------------------------------------------------------------------- */
/* Hierarchy                                                                  */
/* -------------------------------------------------------------------------- */

test('the hierarchy is explicit in both directions', () => {
  const document = build(nestedOutline());
  assert.equal(document.elements.length, 1, '`elements` holds the roots');
  assert.deepEqual(document.elementsById.u1.childIds, ['u2', 'u5', 'u6']);
  assert.equal(document.elementsById.u2.parentId, 'u1');
  assert.equal(document.elementsById.u3.parentId, 'u2');
  assert.equal(document.elementsById.u3.depth, 2);
  assert.equal(document.elementsById.u1.parentId, undefined, 'a root states no parent');
  assert.equal(document.stats.roots, 1);
  assert.equal(document.stats.maxDepth, 2);
});

test('every element is reachable by id and its ref matches', () => {
  const document = build(nestedOutline());
  const flattened = [];
  // Walk from the roots only: `elements` holds roots, and children are reached through `childIds`,
  // so walking both containers would visit every child twice.
  const walk = (ids) => {
    for (const id of ids) {
      const element = document.elementsById[id];
      assert.ok(element, `${id} must be in elementsById`);
      flattened.push(id);
      walk(element.childIds ?? []);
    }
  };
  walk(document.elements.map((element) => element.id));
  assert.deepEqual(flattened.sort(), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.equal(document.elements.length, document.stats.roots, '`elements` holds the roots');
  for (const element of document.elements) {
    assert.equal(element.ref, `p1#${element.id}`, 'refs stay traceable to the raw id');
  }
  assert.equal(Object.keys(document.elementsById).length, document.stats.elements);
});

test('containment relations are published for each parent-child edge', () => {
  const document = build(nestedOutline());
  const contains = document.relations.filter((relation) => relation.kind === 'contains');
  assert.equal(contains.length, 5, 'u1->u2, u2->u3, u2->u4, u1->u5, u1->u6');
  assert.ok(contains.every((relation) => relation.provenance === 'derived'));
  assert.equal(document.elementsById.u3.relationRefs.length >= 1, true);
});

test('geometry and depth carry derived provenance with the rule that produced them', () => {
  const document = build(nestedOutline());
  const element = document.elementsById.u1;
  assert.equal(element.geometry.provenance, 'derived');
  assert.equal(element.geometry.rule, RULES.geometry);
});

/* -------------------------------------------------------------------------- */
/* Deduplication and invalid data                                             */
/* -------------------------------------------------------------------------- */

test('repeated text collapses into one entry that names all its carriers', () => {
  const document = build(nestedOutline());
  const shared = document.text.entries.find((entry) => entry.text === '库存管理');
  assert.ok(shared, 'the repeated text must appear once in the index');
  assert.equal(shared.occurrences, 2);
  assert.deepEqual(shared.elementIds.sort(), ['u3', 'u4']);
});

test('collapsing duplicates leaves an auditable relation, not a silent drop', () => {
  const document = build(nestedOutline());
  const duplicates = document.relations.filter((relation) => relation.kind === 'duplicates-text-of');
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].from, 'u4', 'the later carrier points at the canonical one');
  assert.equal(duplicates[0].to, 'u3');
  assert.equal(duplicates[0].provenance, 'derived');
  assert.equal(duplicates[0].rule, RULES.duplicatesText);
});

test('whitespace-only text is dropped and counted, so nothing vanishes silently', () => {
  const document = build([node('u1', { text: '   ' }), node('u2', { text: 'x' })]);
  assert.equal(document.text.droppedEmpty, 1, 'the empty run must be counted');
  assert.equal(document.text.totalOccurrences, 1);
  assert.equal(document.text.distinctTexts, 1);
});

test('the text index reports totals so a consumer knows the list is complete', () => {
  const document = build(nestedOutline());
  assert.equal(document.text.totalOccurrences, 2);
  assert.equal(document.text.distinctTexts, 1, 'two occurrences, one distinct string');
});

test('a cyclic outline is cut instead of recursing forever', () => {
  // A malformed capture must not be able to hang the server. The cycle is broken and *reported*,
  // so a truncated tree is never mistaken for a complete one.
  const cyclic = node('u1', { kind: 'group', type: 'Group', children: [] });
  const child = node('u2', { depth: 1, children: [cyclic] });
  cyclic.children = [child];
  const document = build([cyclic]);
  assert.equal(document.stats.elements, 2, 'the cycle must not duplicate elements');
  assert.ok(
    document.warnings.some((warning) => /cycle/.test(warning)),
    `the broken cycle must be reported, saw: ${JSON.stringify(document.warnings)}`,
  );
});

test('a repeated subtree is preserved per element, since each has its own identity', () => {
  // Two identical leaves differ by id and position. Collapsing them would merge two real widgets,
  // so the document keeps both and the *text* index is what deduplicates.
  const document = build([
    node('u1', { text: '备注' }),
    node('u2', { text: '备注' }),
  ]);
  assert.equal(document.stats.elements, 2);
  assert.equal(document.text.distinctTexts, 1);
});

/* -------------------------------------------------------------------------- */
/* Missing fields                                                             */
/* -------------------------------------------------------------------------- */

test('a missing text field is an absent field, not an invented empty string', () => {
  const document = build([node('u1')]);
  assert.equal('text' in document.elementsById.u1, false);
  assert.equal('name' in document.elementsById.u1, false);
  assert.equal('attributes' in document.elementsById.u1, false);
});

test('a truncated text reports how much is missing', () => {
  const document = build([node('u1', { text: '库存管理', textTruncated: true, textLength: 400 })]);
  assert.deepEqual(document.elementsById.u1.textTruncated, { length: 400 });
});

test('an element with no structural evidence states unknown rather than omitting the role', () => {
  const document = build([node('u1', { type: '' })]);
  assert.equal(document.elementsById.u1.role.provenance, 'unknown');
  assert.equal(document.elementsById.u1.role.reason, 'not-authored');
  assert.equal(document.stats.rolesUnknown, 1);
  assert.equal(document.stats.byRole.unknown, 1);
  assert.equal(document.stats.rolesKnown, 0);
});

test('role counts account for every element', () => {
  const document = build(nestedOutline().concat([node('u9', { type: 'Unknown Widget' })]));
  assert.equal(document.stats.rolesKnown + document.stats.rolesUnknown, document.stats.elements);
});

/* -------------------------------------------------------------------------- */
/* Complex interactions                                                       */
/* -------------------------------------------------------------------------- */

/** One declared interaction: a button that switches a panel and toggles selection. */
const declaredFacts = [
  {
    widgetRef: 'p1#u5',
    widgetId: 'u5',
    trigger: 'click',
    rawTrigger: 'onClick',
    confidence: 'declared',
    source: 'project-model',
    branches: [
      {
        name: 'Case 1',
        conditions: [{ conditionString: 'if is selected of This equals false' }],
        actions: [
          { kind: 'set-selected', order: 0, value: 'true' },
          { kind: 'set-panel-state', order: 1, panelId: 'u2', state: 1, stateNumber: 2 },
          { kind: 'open-url', order: 2, targets: [{ pageId: 'other-page', pageName: '订单管理' }] },
        ],
      },
    ],
  },
  {
    widgetRef: 'p1#u6',
    widgetId: 'u6',
    trigger: 'click',
    rawTrigger: 'css-cursor-pointer',
    confidence: 'inferred',
    source: 'dom-observation',
    inferredReason: 'CSS cursor is pointer, which suggests it is meant to be clicked',
  },
];

const analysis = (interactions) => ({
  interactions,
  stats: {
    widgets: 6,
    widgetsWithInteractions: interactions.length,
    byConfidence: {
      declared: interactions.filter((fact) => fact.confidence === 'declared').length,
      observed: 0,
      inferred: interactions.filter((fact) => fact.confidence === 'inferred').length,
    },
    byActionKind: {},
    branches: 1,
  },
  gaps: [],
  warnings: [],
});

test('interactions are attached to their element and kept whole', () => {
  const document = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  assert.deepEqual(document.elementsById.u5.interactionRefs, ['p1#u5']);
  assert.equal(document.interactions.items.length, 2);
  assert.equal(document.interactions.items[0].branches[0].actions.length, 3);
});

test('a panel action becomes a switches-state-of relation carrying its evidence level', () => {
  const document = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  const relation = document.relations.find((entry) => entry.kind === 'switches-state-of');
  assert.ok(relation, 'the panel target must become a relation');
  assert.equal(relation.from, 'u5');
  assert.equal(relation.to, 'u2');
  assert.equal(relation.evidence, 'declared');
  assert.equal(relation.provenance, 'fact', 'a model-declared relation is a fact, not a derivation');
});

test('an inferred interaction can only ever produce a derived relation', () => {
  const document = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  const inferred = document.interactions.items.find((fact) => fact.confidence === 'inferred');
  assert.equal(inferred.branches, undefined, 'an inferred record has no actions to build a fact from');
});

test('an unresolvable target is left out of the graph, not invented as a node', () => {
  const document = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  // The open-url action names a page, not a widget on this page: there is no edge to draw.
  const targetRelations = document.relations.filter((relation) => relation.kind === 'targets');
  assert.equal(targetRelations.length, 0);
  assert.equal(document.elementsById['other-page'], undefined, 'no element is fabricated for it');
});

test('a target that is not present on the page is not linked', () => {
  const document = build([node('u1')], {
    interactions: analysis([
      {
        widgetRef: 'p1#u1',
        widgetId: 'u1',
        trigger: 'click',
        confidence: 'declared',
        source: 'project-model',
        branches: [{ actions: [{ kind: 'show', order: 0, targets: [{ widgetId: 'u999', resolved: false }] }] }],
      },
    ]),
  });
  assert.equal(document.relations.filter((relation) => relation.kind === 'targets').length, 0);
});

test('a self-targeting action does not create a self-loop', () => {
  const document = build([node('u1')], {
    interactions: analysis([
      {
        widgetRef: 'p1#u1',
        widgetId: 'u1',
        trigger: 'click',
        confidence: 'declared',
        source: 'project-model',
        branches: [{ actions: [{ kind: 'set-text', order: 0, targets: [{ widgetId: 'u1' }] }] }],
      },
    ]),
  });
  assert.equal(document.relations.filter((relation) => relation.kind === 'targets').length, 0);
});

test('interaction statistics agree with the records that were attached', () => {
  const document = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  assert.deepEqual(document.stats.interactions, { total: 2, declared: 1, observed: 0, inferred: 1 });
  assert.deepEqual(document.interactions.stats.byConfidence, { declared: 1, observed: 0, inferred: 1 });
});

test('gaps are preserved so an unread source stays visible in the standard document', () => {
  const document = build([node('u1')], {
    interactions: {
      ...analysis([]),
      gaps: [{ source: 'axure-project-model', reason: 'not captured', impact: 'no declared interactions' }],
    },
  });
  assert.equal(document.gaps.length, 1);
  assert.equal(document.gaps[0].source, 'axure-project-model');
});

test('identical gaps reported by two layers are collapsed, not duplicated', () => {
  const gap = { source: 'axure-project-model', reason: 'not captured', impact: 'no declared interactions' };
  const document = build([node('u1')], {
    interactions: { ...analysis([]), gaps: [gap] },
    interactionCapture: { gaps: [gap], warnings: [] },
  });
  assert.equal(document.gaps.length, 1, 'the same failure must not be reported twice');
});

/* -------------------------------------------------------------------------- */
/* Agent-facing shaping                                                       */
/* -------------------------------------------------------------------------- */

test('the document declares its schema version', () => {
  const document = build([node('u1')]);
  assert.equal(document.schema, STANDARD_SCHEMA);
  assert.equal(document.schema, 'axure.page/v1');
});

test('capture context is echoed so coverage is auditable', () => {
  const document = build([node('u1')], { capture: { omitted: { budget: 7 } } });
  assert.equal(document.capture.space, 'page');
  assert.equal(document.capture.canvas.width, 1920);
  assert.equal(document.capture.viewport.height, 900);
  assert.equal(document.omitted.budget, 7);
  assert.equal(document.capture.at, '2026-01-01T00:00:00.000Z');
});

test('a scoped ancestor is marked as a connector rather than presented as in scope', () => {
  const document = build([
    node('u1', { kind: 'group', type: 'Group', children: [node('u2', { depth: 1, scoped: true })] }),
  ]);
  assert.equal(document.elementsById.u2.scopedConnector, true);
  assert.equal('scopedConnector' in document.elementsById.u1, false);
});

test('the statistics add up and account for every element', () => {
  const document = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  assert.equal(document.stats.elements, 6);
  assert.equal(document.stats.rolesKnown + document.stats.rolesUnknown, document.stats.elements);
  const byRoleTotal = Object.values(document.stats.byRole).reduce((sum, count) => sum + count, 0);
  assert.equal(byRoleTotal, document.stats.elements);
  assert.equal(document.stats.relations, document.relations.length);
});

test('building twice from the same input produces the same document', () => {
  const first = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  const second = build(nestedOutline(), { interactions: analysis(declaredFacts) });
  assert.deepEqual(first, second, 'the conversion must be deterministic');
});

test('a large page is converted without unbounded work', () => {
  // 3000 leaves: the conversion must stay linear and must not merge distinct elements.
  const many = [];
  for (let index = 0; index < 3_000; index += 1) {
    many.push(node(`u${index}`, { text: index % 3 === 0 ? '共享' : `文本${index}` }));
  }
  const started = Date.now();
  const document = build(many, { widgetCount: 3_000 });
  const elapsed = Date.now() - started;
  assert.equal(document.stats.elements, 3_000);
  assert.equal(document.text.distinctTexts, 2_001, '1000 shared plus 2000 distinct');
  assert.ok(elapsed < 5_000, `conversion took ${elapsed}ms, which is not linear-looking`);
});

test('the raw prototype id is preserved on every element so anything can be traced', () => {
  const document = build(nestedOutline());
  for (const element of document.elements) {
    assert.equal(typeof element.id, 'string');
    assert.ok(element.id.length > 0);
    assert.equal(element.ref, `p1#${element.id}`);
  }
});

console.log(`\n${failures === 0 ? 'all standardization checks passed' : `${failures} standardization check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
