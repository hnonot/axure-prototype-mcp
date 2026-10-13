/** Tool names, in one place so tests, docs and the DSH bundle cannot disagree. */
export const TOOL_NAMES = {
  listPages: 'axure_list_pages',
  pageMap: 'axure_get_page_map',
  visual: 'axure_get_visual',
} as const;

/** Every tool name as an array, for assertions and documentation. */
export const ALL_TOOL_NAMES: string[] = Object.values(TOOL_NAMES);
