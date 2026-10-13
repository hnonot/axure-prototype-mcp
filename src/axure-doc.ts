/**
 * Axure sitemap ("page map") extraction.
 *
 * Every Axure project ships `data/document.js`, which calls
 * `$axure.loadDocument(...)` with a fully decoded document model. After the share
 * shell has booted, the same model is reachable as `window.$axure.document`, so the
 * page tree can be read from the project itself instead of being scraped from the
 * sitemap UI or re-derived by evaluating minified bundle code.
 *
 * This is what lets an agent discover which prototype pages exist before it spends a
 * heavy capture call on one of them.
 */

import type { Frame } from 'playwright';
import { AxureError } from './errors.js';
import type { AxureConfig } from './config.js';
import type { SitemapPage, SitemapResult } from './types.js';

interface RawSitemapNode {
  id?: string;
  pageName?: string;
  type?: string;
  url?: string;
  children?: RawSitemapNode[];
  /** Axure marks a folder as a generated "sitemap" container. */
  isFolder?: boolean;
}

interface RawDocument {
  configuration?: { projectName?: string; prototypeId?: string };
  sitemap?: { rootNodes?: RawSitemapNode[] };
}

/** The in-page reader, expressed as an IIFE so it evaluates as one expression. */
const READ_SITEMAP = `(() => {
  const ax = window.$axure;
  if (!ax || typeof ax !== 'object') return { ok: false, reason: 'window.$axure is absent' };
  const doc = ax.document;
  if (!doc || !doc.sitemap) return { ok: false, reason: 'window.$axure.document.sitemap is absent' };
  return {
    ok: true,
    configuration: doc.configuration || {},
    rootNodes: doc.sitemap.rootNodes || [],
  };
})()`;

/**
 * Read the project sitemap from a booted shell frame.
 *
 * @param frame - shell frame that has finished loading the Axure share page.
 * @param config - resolved server configuration, used to absolutize page URLs.
 */
export async function readSitemap(frame: Frame, config: AxureConfig): Promise<SitemapResult> {
  const raw = (await frame.evaluate(READ_SITEMAP)) as
    | { ok: true; configuration: RawDocument['configuration']; rootNodes: RawSitemapNode[] }
    | { ok: false; reason: string };

  if (!raw.ok) {
    throw new AxureError(
      'NOT_AXURE_PROJECT',
      `the loaded page did not expose an Axure document (${raw.reason})`,
      'point AXURE_URL at the project root share link, for example http://host/PROJECTID.',
    );
  }

  const pages: SitemapPage[] = [];
  const folders: SitemapResult['folders'] = [];

  const walk = (nodes: RawSitemapNode[], path: string[]): void => {
    for (const node of nodes) {
      const name = node.pageName ?? '(unnamed)';
      if (node.children?.length) {
        const folderPath = [...path, name];
        const ids: string[] = [];
        const collect = (list: RawSitemapNode[]): void => {
          for (const item of list) {
            if (item.url && item.id) ids.push(item.id);
            if (item.children) collect(item.children);
          }
        };
        collect(node.children);
        folders.push({ path: folderPath, name, pageIds: ids });
        walk(node.children, folderPath);
        continue;
      }
      if (!node.url || !node.id) continue;
      pages.push({
        id: node.id,
        name,
        url: node.url,
        absoluteUrl: new URL(node.url, `${config.baseUrl}/`).toString(),
        path,
        type: node.type ?? 'Wireframe',
      });
    }
  };

  walk(raw.rootNodes ?? [], []);

  return {
    projectName: raw.configuration?.projectName ?? '',
    baseUrl: config.baseUrl,
    generatedAt: new Date().toISOString(),
    pageCount: pages.length,
    folderCount: folders.length,
    pages,
    folders,
  };
}

/** Render a sitemap as an indented tree for the model. */
export function renderSitemap(result: SitemapResult): string {
  const lines: string[] = [];
  lines.push(`# Axure project${result.projectName ? `: ${result.projectName}` : ''}`);
  lines.push(`base: ${result.baseUrl}`);
  lines.push(`pages: ${result.pageCount}  folders: ${result.folderCount}`);
  lines.push('format: <pageId>  <page name>  -> <relative url>');
  lines.push('');

  if (result.pageCount === 0) {
    lines.push('(no page matches the filter)');
    return lines.join('\n');
  }

  // Rebuild the tree from the flat page and folder projections. Folders with no matching
  // page are reported with a count rather than left bare, which would otherwise read as
  // "this folder is empty" when a filter simply excluded its pages.
  interface TreeNode {
    name: string;
    children: TreeNode[];
    page?: SitemapPage;
  }
  const root: TreeNode = { name: '', children: [] };
  const ensure = (segments: string[]): TreeNode => {
    let cursor = root;
    for (const segment of segments) {
      let next = cursor.children.find((child) => child.name === segment);
      if (!next) {
        next = { name: segment, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    return cursor;
  };
  for (const page of result.pages) ensure(page.path).children.push({ name: page.name, children: [], page });

  const countPages = (node: TreeNode): number =>
    (node.page ? 1 : 0) + node.children.reduce((sum, child) => sum + countPages(child), 0);

  const render = (node: TreeNode, depth: number): void => {
    if (node.page) {
      lines.push(`${'  '.repeat(depth)}${node.page.id}  ${node.page.name}  -> ${node.page.url}`);
      return;
    }
    if (node.name) {
      const total = countPages(node);
      const count = total === 0 ? ' (0 pages here; filtered out or a folder-only node)' : ` (${total})`;
      lines.push(`${'  '.repeat(depth)}[folder] ${node.name}${count}`);
    }
    for (const child of node.children) render(child, node.name ? depth + 1 : depth);
  };
  for (const child of root.children) render(child, 0);

  return lines.join('\n');
}

/** Resolve a caller-supplied page selector to an absolute URL. */
export function resolvePageUrl(
  selector: string | undefined,
  config: AxureConfig,
  sitemap?: SitemapResult,
): { url: string; pageId?: string; pageName?: string } {
  const value = selector?.trim();
  if (!value) return { url: config.defaultPageUrl, pageName: undefined };

  // A sitemap page id.
  const byId = sitemap?.pages.find((page) => page.id === value);
  if (byId) return { url: byId.absoluteUrl, pageId: byId.id, pageName: byId.name };

  // A sitemap page name (exact, then case-insensitive).
  const byName =
    sitemap?.pages.find((page) => page.name === value) ??
    sitemap?.pages.find((page) => page.name.toLowerCase() === value.toLowerCase());
  if (byName) return { url: byName.absoluteUrl, pageId: byName.id, pageName: byName.name };

  // An absolute URL, or a path/page URL relative to the project base.
  if (/^https?:\/\//i.test(value)) {
    return { url: value, pageId: sitemap?.pages.find((page) => page.absoluteUrl === value)?.id };
  }
  const url = new URL(value, `${config.baseUrl}/`).toString();
  return { url, pageId: sitemap?.pages.find((page) => page.absoluteUrl === url)?.id };
}
