import type { Entry } from '../lib/types';

// Flow search is one literal phrase. Global lookup's type/date syntax does
// not change membership here.
export function matchesFlowSearch(entry: Entry, term: string, description = ''): boolean {
  const needle = term.trim().toLowerCase();
  return !needle || [entry.meta.created, description, entry.content]
    .some(text => text.toLowerCase().includes(needle));
}
