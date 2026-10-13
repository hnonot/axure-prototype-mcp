/**
 * The browser-side extractor.
 *
 * ## Why this exists
 *
 * An Axure prototype published as a share link renders its widgets as plain `<div>`
 * elements. Measurement against a real Axure 10 deployment showed the accessibility tree
 * is close to useless as a structural description: every widget surfaces as an anonymous
 * `paragraph` or `img` with no role, no name, no nesting and no position, because Axure
 * gives its widgets no ARIA semantics.
 *
 * The markup itself is rich and stable. Every widget is `<div id="u<number>">`, its kind is
 * emitted by Axure as the HTML comment immediately preceding it
 * (`<!-- 会员中心 (Dynamic Panel) -->`), and `window.$axure.getRectAndStyleById(id)`
 * resolves authored geometry, fill, border, corner radius, opacity and text for every
 * widget. That runtime model is a better source of truth than computed CSS.
 *
 * This extractor selects and normalizes what Axure already exposes. It performs no layout
 * re-derivation, no OCR, no image understanding and no interaction.
 *
 * ## Contract
 *
 * The function below is **serialized into the page**, so it must be plain JavaScript: no
 * imports, no closures over module scope, and no TypeScript annotations. `npm test`
 * compiles this exact string with `new Function` to prove it, because a stray annotation
 * would otherwise only fail at runtime, inside Chromium, far from the edit that caused it.
 *
 * Everything it returns is treated as untrusted data by the layers above.
 */

/** Raw node shape returned by the injected walker. Defined here so both sides agree. */
export interface RawOutlineNode {
  id: string;
  depth: number;
  kind: string;
  type: string;
  name?: string;
  text?: string;
  textLength?: number;
  action?: string;
  image?: string;
  state?: number;
  stateCount?: number;
  note?: string;
  rect: { left: number; top: number; width: number; height: number; visible: boolean };
  /** Authored style record; `isContainer` marks group/panel styles that are not painted. */
  style?: Record<string, unknown>;
  children?: RawOutlineNode[];
}

/** Result of one extraction pass. */
export interface RawCapture {
  ok: boolean;
  reason?: string;
  frameUrl: string;
  docWidth: number;
  docHeight: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  totalWidgets: number;
  nodes: RawOutlineNode[];
  notes: Array<{ target: string; text: string }>;
  warnings: string[];
}

export const EXTRACT_SOURCE = String.raw`
function axureExtractOutline(options) {
  const warnings = [];
  const root = document.getElementById('base') || document.body;
  const widgetIdPattern = /^u\d+$/;

  const ax = window.$axure;
  const styleApi = ax && typeof ax.getRectAndStyleById === 'function';
  if (!styleApi) warnings.push('Axure runtime style API unavailable; styles are omitted.');

  const styleCache = new Map();
  function authored(id) {
    if (!styleApi) return null;
    if (styleCache.has(id)) return styleCache.get(id);
    let value = null;
    try { value = ax.getRectAndStyleById(id) || null; } catch (e) { value = null; }
    styleCache.set(id, value);
    return value;
  }

  function argbToCss(value) {
    if (!value || typeof value !== 'object') return undefined;
    if (value.fillType === 'none') return undefined;
    if (value.fillType && value.fillType !== 'solid') return String(value.fillType);
    const n = typeof value.color === 'number' ? value.color >>> 0 : null;
    if (n === null) return undefined;
    const a = ((n >>> 24) & 0xff) / 255;
    const r = (n >>> 16) & 0xff;
    const g = (n >>> 8) & 0xff;
    const b = n & 0xff;
    return { r: r, g: g, b: b, a: a };
  }

  function num(value) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  // Prototype text is attacker-influenceable, and this string is embedded in a
  // line-oriented format the model reads. Every value that reaches the output is collapsed
  // to one line here, so untrusted content cannot forge a node, a section or a warning.
  function cleanText(value) {
    if (typeof value !== 'string') return undefined;
    const text = value
      .replace(/\u00a0/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length ? text : undefined;
  }

  // The kind comment is parsed without a regex over the whole comment, because a regex
  // such as /^(.*?)\(([^()]*)\)$/ lets a newline inside the parentheses reach the output.
  function commentInfo(el) {
    let info = null;
    for (let node = el.previousSibling; node; node = node.previousSibling) {
      if (node.nodeType === 1) break;
      if (node.nodeType === 8) {
        const raw = node.nodeValue || '';
        const open = raw.indexOf('(');
        if (open !== -1 && raw.trimEnd().endsWith(')')) {
          const close = raw.lastIndexOf(')');
          if (close > open) {
            info = {
              name: cleanText(raw.slice(0, open)),
              type: cleanText(raw.slice(open + 1, close)),
            };
          }
        }
        break;
      }
      if (node.nodeType === 3 && (node.nodeValue || '').trim()) break;
    }
    return info;
  }

  function kindOf(type, childTypes) {
    const isWidget = (name) => childTypes.indexOf(name) !== -1;
    switch (type) {
      case 'Dynamic Panel': return 'dynamic-panel';
      case 'Group': return isWidget('widget') ? 'group' : 'shape';
      case 'Repeater': return 'repeater';
      case 'Table': return 'table';
      case 'Inline Frame': return 'inline-frame';
      case 'Text Area':
      case 'Text Field':
      case 'List Box':
      case 'Combo Box':
      case 'Checkbox':
      case 'Radio Button':
      case 'Button': return 'input';
      case 'Menu':
      case 'Menu (Vertical)':
      case 'Menu (Horizontal)': return 'menu';
      case 'Vector':
      case 'SVG':
      case 'Icon': return 'vector';
      case 'Image':
      case 'Image Map': return 'image';
      case 'Rectangle':
      case 'Rounded Rectangle':
      case 'Ellipse':
      case 'Placeholder':
      case 'Horizontal Line':
      case 'Vertical Line':
      case 'Connector':
      case 'Snapshot': return 'shape';
      case 'Heading 1':
      case 'Heading 2':
      case 'Heading 3':
      case 'Label':
      case 'Paragraph':
      case 'Flow Shape':
      case 'Box':
      case 'Note':
      case 'Marker': return 'text';
      default: return childTypes.length ? 'group' : 'widget';
    }
  }

  function isHidden(computed) {
    return computed.display === 'none' || computed.visibility === 'hidden';
  }

  function classList(el) {
    return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  function imageOf(el) {
    const img = el.querySelector(':scope > img[id$="_img"], :scope > img');
    if (!img) return undefined;
    const src = img.getAttribute('src') || '';
    return src ? cleanText(src) : undefined;
  }

  function ownText(el) {
    const textEl = el.querySelector(':scope > [id$="_text"]');
    if (!textEl) return undefined;
    const computed = getComputedStyle(textEl);
    if (computed.display === 'none' || computed.visibility === 'hidden') return undefined;
    const raw = textEl.innerText || textEl.textContent || '';
    if (!raw.trim()) return undefined;
    // Text keeps its line structure because it is JSON-escaped downstream, but control
    // characters and non-breaking spaces are normalized.
    const text = raw
      .replace(/\u00a0/g, ' ')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
    return text.length ? text : undefined;
  }

  let totalWidgets = 0;
  const notes = [];

  function visit(el, depth) {
    if (!(el instanceof HTMLElement)) return null;
    const id = el.id;
    const isWidget = widgetIdPattern.test(id);

    // A non-widget element (base, panel-state container, rendering sub-element such as
    // u1_text / u1_img) is transparent: its widget descendants are spliced into the
    // enclosing widget's child list so the outline never contains wrapper nodes.
    if (!isWidget) {
      const flattened = [];
      for (const child of Array.from(el.children)) {
        const childNode = visit(child, depth);
        if (!childNode) continue;
        if ('sublist' in childNode) flattened.push.apply(flattened, childNode.sublist);
        else flattened.push(childNode.node);
      }
      if (flattened.length === 0) return null;
      return { sublist: flattened };
    }

    const children = [];
    for (const child of Array.from(el.children)) {
      const childNode = visit(child, depth + 1);
      if (!childNode) continue;
      if ('sublist' in childNode) children.push.apply(children, childNode.sublist);
      else children.push(childNode.node);
    }

    totalWidgets += 1;

    const computed = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const info = commentInfo(el);
    const type = info && info.type ? info.type : 'Unknown';
    const childTypes = classList(el);
    const authoredStyle = authored(id);
    const authoredRect = authoredStyle && authoredStyle.rect ? authoredStyle.rect : null;
    const style = authoredStyle && authoredStyle.style ? authoredStyle.style : null;

    const width = Math.round((authoredRect ? authoredRect.width : rect.width) * 10) / 10;
    const height = Math.round((authoredRect ? authoredRect.height : rect.height) * 10) / 10;
    const left = Math.round((authoredRect ? authoredRect.left : rect.left + window.scrollX) * 10) / 10;
    const top = Math.round((authoredRect ? authoredRect.top : rect.top + window.scrollY) * 10) / 10;

    const node = {
      id: id,
      depth: depth,
      kind: kindOf(type, childTypes),
      type: type,
      name: info && info.name && info.name !== 'Unnamed' ? info.name : undefined,
      rect: { left: left, top: top, width: width, height: height, visible: !isHidden(computed) },
      style: style
        ? {
            fill: style.fill,
            borderFill: style.borderFill,
            borderWidth: style.borderWidth,
            cornerRadius: style.cornerRadius,
            opacity: style.opacity,
            fontName: style.fontName,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            foreGroundFill: style.foreGroundFill,
            horizontalAlignment: style.horizontalAlignment,
            verticalAlignment: style.verticalAlignment,
            paddingLeft: style.paddingLeft,
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            lineSpacing: style.lineSpacing,
            image: style.image || null,
            // A group and a dynamic panel both carry a white style record of their own that
            // is not painted; reporting it as fill=#ffffff on a container is misleading.
            isContainer: type === 'Group' || type === 'Dynamic Panel' || type === 'Repeater'
          }
        : undefined,
    };

    const text = ownText(el);
    if (text) {
      node.text = text;
      node.textLength = text.length;
    }

    if (computed.cursor === 'pointer') node.action = 'click';
    const image = imageOf(el);
    if (image) node.image = image;

    if (collectNotes) {
      const noteEl = el.querySelector('[id$="_note"], .ax_default_note');
      if (noteEl) {
        const noteText = cleanText(noteEl.innerText || noteEl.textContent);
        if (noteText) {
          node.note = noteText;
          notes.push({ target: id, text: noteText });
        }
      }
    }

    const stateContainers = el.querySelectorAll(':scope > [id^="' + id + '_state"]');
    if (stateContainers.length) {
      node.stateCount = stateContainers.length;
      for (const state of Array.from(stateContainers)) {
        const stateStyle = getComputedStyle(state);
        if (stateStyle.display !== 'none' && stateStyle.visibility !== 'hidden') {
          const match = /_state(\d+)$/.exec(state.id);
          node.state = match ? Number.parseInt(match[1], 10) : 0;
          const label = state.getAttribute('data-label');
          if (label) node.name = node.name || cleanText(label);
          break;
        }
      }
    }

    if (children.length) node.children = children;
    return { node: node };
  }

  const collectNotes = options.includeNotes === true;

  const collected = [];
  for (const child of Array.from(root.children)) {
    const result = visit(child, 0);
    if (!result) continue;
    if (result.sublist) collected.push.apply(collected, result.sublist);
    else collected.push(result.node);
  }

  return {
    ok: true,
    frameUrl: location.href,
    docWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    totalWidgets: totalWidgets,
    nodes: collected,
    notes: notes,
    warnings: warnings,
  };
}
`;
