/**
 * Axure sitemap ("page map") reading and page-reference resolution.
 *
 * Every Axure project ships `data/document.js`, which calls `$axure.loadDocument(...)` with a
 * fully decoded document model. After the share shell has booted, the same model is reachable
 * as `window.$axure.document`, so the page tree is read from the project itself rather than
 * scraped from the sitemap UI or re-derived by evaluating minified bundle code.
 *
 * Page names and URLs come from whoever can publish the prototype, so everything this module
 * renders is treated as untrusted data.
 */

import type { FrameHandle } from '../playwright/adapter.js';
import { DomainError, InfrastructureError, messageOf } from '../errors.js';
import { neutralizeUntrusted } from '../security.js';
import { resolvePageReference, type NavigationBoundary } from '../security.js';
import type { SitemapPage, SitemapResult } from '../types.js';

interface RawSitemapNode {
  id?: string;
  pageName?: string;
  type?: string;
  url?: string;
  children?: RawSitemapNode[];
}

interface RawDocument {
  configuration?: { projectName?: string; prototypeId?: string };
  sitemap?: { rootNodes?: RawSitemapNode[] };
}

/**
 * In-page reader.
 *
 * Follows the adapter's single in-page convention: the declaration defines
 * `axureExtractOutline`, which the adapter compiles and calls.
 */
const READ_SITEMAP = `function axureExtractOutline() {
  const ax = window.$axure;
  if (!ax || typeof ax !== 'object') return { ok: false, reason: 'window.$axure is absent' };
  const doc = ax.document;
  if (!doc || !doc.sitemap) return { ok: false, reason: 'window.$axure.document.sitemap is absent' };
  return {
    ok: true,
    configuration: doc.configuration || {},
    rootNodes: doc.sitemap.rootNodes || [],
  };
}`;

/** Read the project sitemap from a booted shell frame. */
export async function readSitemap(frame: FrameHandle, baseUrl: string): Promise<SitemapResult> {
  let raw: { ok: true; configuration: RawDocument['configuration']; rootNodes: RawSitemapNode[] } | { ok: false; reason: string };
  try {
    raw = await frame.run<typeof raw>(READ_SITEMAP);
  } catch (error) {
    throw new InfrastructureError('NOT_AXURE_PROJECT', `cannot read the project document: ${messageOf(error)}`, {
      hint: 'The project root share link must load successfully; check AXURE_URL.',
      cause: error,
    });
  }

  if (!raw.ok) {
    throw new DomainError(
      'NOT_AXURE_PROJECT',
      `the loaded page did not expose an Axure document (${neutralizeUntrusted(raw.reason)})`,
      { hint: 'Point AXURE_URL at the project root share link, for example http://host/PROJECTID.' },
    );
  }

  const pages: SitemapPage[] = [];
  const folders: SitemapResult['folders'] = [];

  const walk = (nodes: RawSitemapNode[], path: string[]): void => {
    for (const node of nodes) {
      const name = neutralizeUntrusted(node.pageName ?? '(unnamed)');
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
        id: neutralizeUntrusted(node.id),
        name,
        url: neutralizeUntrusted(node.url),
        absoluteUrl: new URL(node.url, `${baseUrl}/`).toString(),
        path,
        type: neutralizeUntrusted(node.type ?? 'Wireframe'),
      });
    }
  };

  walk(raw.rootNodes ?? [], []);
  pages.sort((a, b) => a.name.localeCompare(b.name));

  return {
    projectName: neutralizeUntrusted(raw.configuration?.projectName ?? ''),
    baseUrl,
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

  // Folders with no matching page report a count rather than appearing bare, which would
  // otherwise read as "this folder is empty" when a filter simply excluded its pages.
  const render = (node: TreeNode, depth: number): void => {
    if (node.page) {
      lines.push(`${'  '.repeat(depth)}${node.page.id}  ${node.page.name}  -> ${node.page.url}`);
      return;
    }
    if (node.name) {
      const total = countPages(node);
      lines.push(
        `${'  '.repeat(depth)}[folder] ${node.name}` + (total === 0 ? ' (0 pages matched)' : ` (${total})`),
      );
    }
    for (const child of node.children) render(child, node.name ? depth + 1 : depth);
  };
  for (const child of root.children) render(child, 0);

  return lines.join('\n');
}

/** A resolved page target. */
export interface ResolvedPage {
  url: string;
  pageId?: string;
  pageName?: string;
  path: string[];
  type?: string;
}

/**
 * Resolve a caller-supplied page selector to an absolute, permitted URL.
 *
 * Accepts, in order: a sitemap page id, an exact or case-insensitive page name, a
 * project-relative path, or a URL that lies inside the deployment boundary. Anything else —
 * an external host, a `file:` URL, a scheme-relative value, a path that climbs out of the
 * project — is rejected rather than navigated to.
 */
export function resolvePage(
  selector: string | undefined,
  boundary: NavigationBoundary & { defaultPageUrl: string },
  sitemap?: SitemapResult,
): ResolvedPage {
  const value = selector?.trim();
  if (!value) return { url: boundary.defaultPageUrl, path: [] };

  const byId = sitemap?.pages.find((page) => page.id === value);
  if (byId) return { url: byId.absoluteUrl, pageId: byId.id, pageName: byId.name, path: byId.path, type: byId.type };

  const byName =
    sitemap?.pages.find((page) => page.name === value) ??
    sitemap?.pages.find((page) => page.name.toLowerCase() === value.toLowerCase());
  if (byName) {
    return { url: byName.absoluteUrl, pageId: byName.id, pageName: byName.name, path: byName.path, type: byName.type };
  }

  const url = resolvePageReference(boundary, value);
  if (!url) {
    throw new DomainError('PAGE_NOT_FOUND', `"${neutralizeUntrusted(value)}" is not a page of this prototype`, {
      hint:
        'Pass a page id from axure_list_pages (e.g. "6k5oyo"), an exact page name, or a project-relative path. ' +
        'Navigation outside the configured Axure deployment is refused.',
    });
  }
  const known = sitemap?.pages.find((page) => page.absoluteUrl === url);
  return { url, pageId: known?.id, pageName: known?.name, path: known?.path ?? [], type: known?.type };
}

