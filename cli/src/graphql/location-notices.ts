import { extractLocationReferences, parseLocationHandle } from '../core/location-reference.js';
import type { RecordNode } from './query.js';

export interface LocationWriteNotice {
  code: 'location_geo_missing';
  recordHandle: string;
  handle: string;
  message: string;
}

/** Advisory receipts never alter the saved record or turn a valid write into a failure. */
export function missingLocationGeoNotices(nodes: Iterable<RecordNode>): LocationWriteNotice[] {
  const notices: LocationWriteNotice[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const markdown = node.kind === 'entry' ? node.record.content : node.record.body;
    // Location enrichment is advisory. A failure to inspect content must not
    // obscure already-confirmed mutation effects or require a write retry.
    let locations: ReturnType<typeof extractLocationReferences> = [];
    if (typeof markdown === 'string' && markdown.includes('#location/')) {
      try { locations = extractLocationReferences(markdown); }
      catch { /* A structured location can still produce its independent notice. */ }
    }
    if (node.kind === 'action' && typeof node.record.frontMatter.location === 'string') {
      const handle = node.record.frontMatter.location, ref = parseLocationHandle(handle);
      if (ref) locations.push({ ref, handle });
    }
    for (const {ref, handle} of locations) {
      if (ref.geo || !ref.postal) continue;
      const key = `${node.handle}\0${handle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notices.push({code: 'location_geo_missing', recordHandle: node.handle, handle,
        message: 'Saved record contains a postal-only location. Use Query.geocodeAddress whenever possible, inspect the candidates, then add geo with an ordinary record update while preserving postal and any display label. Without geo, this location cannot be geographically filtered.'});
    }
  }
  return notices;
}
