export interface CommandPaletteItem {
  id: string;
  label: string;
  keywords?: string[];
  shortcut?: string;
  available?: boolean;
}

export function filterCommandPaletteItems<T extends CommandPaletteItem>(
  items: readonly T[],
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (item.available === false) return false;
    if (!terms.length) return true;
    const haystack = [item.label, ...(item.keywords ?? [])].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
