// Searchable contents may arrive after the user has typed. Refresh only the
// same active, visible query; pending work never reopens a dismissed dropdown.
export function watchActiveSearch(source: { subscribeSearch(listener: () => void): () => void }, options: {
  query(): string;
  activeQuery(): string;
  visible(): boolean;
  refresh(query: string): void;
}): () => void {
  let frame = 0;
  let stopped = false;
  const detach = source.subscribeSearch(() => {
    const query = options.query();
    if (frame || !query.trim() || !options.visible() || query !== options.activeQuery()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!stopped && options.visible() && options.query() === query && options.activeQuery() === query) options.refresh(query);
    });
  });
  return () => { stopped = true; detach(); cancelAnimationFrame(frame); };
}
