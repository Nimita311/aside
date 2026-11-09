import { withoutCode } from './markdown.js';

export interface LocationReference {
  geo?: { latitude: number; longitude: number; altitude?: number; uncertainty?: number };
  postal?: string[];
}

const PREFIX = '#location/?';
const NUMBER = '-?\\d+(?:\\.\\d+)?';
// RFC 5870's supported WGS-84 subset: coordinates, optional altitude, then
// optional CRS and uncertainty, in that order. Unknown parameters stay literal.
const GEO = new RegExp(`^(${NUMBER}),(${NUMBER})(?:,(${NUMBER}))?(?:;crs=wgs84)?(?:;u=(\\d+(?:\\.\\d+)?))?$`, 'i');
const POSTAL_SEGMENT = /^(?:[A-Za-z0-9._~+-]|%[\da-fA-F]{2})+$/;

function validGeo(geo: NonNullable<LocationReference['geo']>): boolean {
  return typeof geo === 'object' && geo !== null
    && typeof geo.latitude === 'number' && Number.isFinite(geo.latitude) && Math.abs(geo.latitude) <= 90
    && typeof geo.longitude === 'number' && Number.isFinite(geo.longitude) && Math.abs(geo.longitude) <= 180
    && (geo.altitude === undefined || typeof geo.altitude === 'number' && Number.isFinite(geo.altitude))
    && (geo.uncertainty === undefined || typeof geo.uncertainty === 'number' && Number.isFinite(geo.uncertainty) && geo.uncertainty >= 0);
}

function validPostal(postal: string[]): boolean {
  if (!Array.isArray(postal) || postal.length === 0) return false;
  for (const part of postal) if (typeof part !== 'string' || !part.trim() || /[\p{Cc}\p{Cs}]/u.test(part)) return false;
  return true;
}

function parseGeo(value: string): LocationReference['geo'] | null {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  const match = GEO.exec(decoded);
  if (!match || match[0] !== decoded) return null;
  const geo: NonNullable<LocationReference['geo']> = {
    latitude: Number(match[1]) || 0,
    longitude: Number(match[2]) || 0,
    ...(match[3] === undefined ? {} : { altitude: Number(match[3]) || 0 }),
    ...(match[4] === undefined ? {} : { uncertainty: Number(match[4]) }),
  };
  return validGeo(geo) ? geo : null;
}

function parsePostal(value: string): string[] | null {
  const segments = value.split('/');
  if (segments.at(-1) === '') segments.pop();
  if (!segments.length || segments.some(segment => !POSTAL_SEGMENT.test(segment))) return null;
  try {
    // Split before decoding so %2F stays inside an address component. A plus
    // sign is postal content, never application/x-www-form-urlencoded space.
    const postal = segments.map(segment => decodeURIComponent(segment));
    return validPostal(postal) ? postal : null;
  } catch { return null; }
}

/** Parse a complete handle, without geocoding or interpreting its display label. */
export function parseLocationHandle(handle: string): LocationReference | null {
  if (typeof handle !== 'string' || !handle.startsWith(PREFIX)) return null;
  const pairs = handle.slice(PREFIX.length).split('&');
  if (pairs.length > 2) return null;
  const reference: LocationReference = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals < 0) return null;
    const key = pair.slice(0, equals), value = pair.slice(equals + 1);
    if (key === 'geo' && reference.geo === undefined) {
      const geo = parseGeo(value);
      if (!geo) return null;
      reference.geo = geo;
    } else if (key === 'postal' && reference.postal === undefined) {
      const postal = parsePostal(value);
      if (!postal) return null;
      reference.postal = postal;
    } else return null;
  }
  return reference.geo || reference.postal ? reference : null;
}

export const LOCATION_HANDLE_RULE = 'location must be a complete bare #location/? handle with geo or postal, without a Markdown label.';

export function assertLocationHandle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !parseLocationHandle(value)) throw new Error(LOCATION_HANDLE_RULE);
}

// JavaScript uses exponent notation for very small/large numbers; RFC 5870
// accepts decimal notation only. Expand without rounding the supplied value.
function decimal(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponent] = text.toLowerCase().split('e');
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const digits = unsigned.replace('.', '');
  const point = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(exponent);
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? '-' : ''}${expanded}`;
}

function encodePostal(part: string): string {
  return encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonical query order and escaping; never changes or resolves postal data. */
export function locationHandle(reference: LocationReference): string {
  if (!reference || typeof reference !== 'object' || (!reference.geo && !reference.postal)
    || reference.geo !== undefined && !validGeo(reference.geo)
    || reference.postal !== undefined && !validPostal(reference.postal)) throw new Error('Invalid location reference.');
  const parameters: string[] = [];
  if (reference.geo) {
    const geo = reference.geo;
    parameters.push(`geo=${decimal(geo.latitude)},${decimal(geo.longitude)}${geo.altitude === undefined ? '' : `,${decimal(geo.altitude)}`}${geo.uncertainty === undefined ? '' : `;u=${decimal(geo.uncertainty)}`}`);
  }
  if (reference.postal) parameters.push(`postal=${reference.postal.map(encodePostal).join('/')}/`);
  return PREFIX + parameters.join('&');
}

/** A display fallback only: authored Markdown labels remain independent. */
export function locationDisplay(reference: LocationReference): string {
  if (reference.postal?.length) return reference.postal.join(', ');
  return reference.geo ? `${decimal(reference.geo.latitude)}, ${decimal(reference.geo.longitude)}` : '';
}

const INLINE = /(?<![\p{L}\p{N}\p{M}_/\\])#location\/\?[^\s<>()[\]{}"'`]+/gu;

/** Scan prose positions; callers exclude Markdown code and link text separately. */
export function locationMentions(prose: string): Array<{ ref: LocationReference; index: number; length: number; handle: string }> {
  const mentions: Array<{ ref: LocationReference; index: number; length: number; handle: string }> = [];
  for (const match of prose.matchAll(INLINE)) {
    // A canonical postal slash explicitly ends its final component. Otherwise
    // preserve a valid value first, peeling only punctuation that invalidates
    // it: St., means the address St. followed by a prose comma.
    const punctuation = /[.,;:!?]+$/.exec(match[0])?.[0] ?? '';
    const base = match[0].slice(0, match[0].length - punctuation.length);
    let handle = base.endsWith('/') && punctuation ? base : match[0];
    let ref = parseLocationHandle(handle);
    if (!ref && punctuation) {
      // A dot is the only valid raw postal character in this punctuation set.
      // Try its leading run, then peel the rest at once, keeping long malformed
      // punctuation runs linear rather than reparsing every shorter suffix.
      const dots = /^\.+/.exec(punctuation)?.[0] ?? '';
      handle = base + dots;
      ref = dots && dots !== punctuation ? parseLocationHandle(handle) : null;
      if (!ref) { handle = base; ref = parseLocationHandle(handle); }
    }
    if (ref) mentions.push({ ref, index: match.index, length: handle.length, handle });
  }
  return mentions;
}

function escaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && text[--index] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

function bracketPairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>(), openings: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '[') openings.push(index);
    else if (text[index] === ']' && openings.length) pairs.set(openings.pop()!, index);
  }
  return pairs;
}

function destinationAt(text: string, start: number): { handle: string; end: number } | null {
  if (text[start] === '<') {
    for (let end = start + 1; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '\n' || text[end] === '<') return null;
      if (text[end] === '>') return { handle: text.slice(start + 1, end), end: end + 1 };
    }
    return null;
  }
  let end = start, depth = 0;
  for (; end < text.length; end++) {
    const character = text[end];
    if (character === '\\') { end++; continue; }
    if (character === '(') depth++;
    else if (character === ')') { if (depth === 0) break; depth--; }
    else if (/\s/.test(character)) break;
    else if (character === '<') return null;
  }
  return depth ? null : { handle: text.slice(start, end), end };
}

function titleEnd(text: string, start: number): number {
  const closing = text[start] === '(' ? ')' : text[start];
  if (!['"', "'", '('].includes(text[start])) return -1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === closing) return index + 1;
    if (text[index] === '\n' && /^[ \t]*\n/.test(text.slice(index + 1))) return -1;
  }
  return -1;
}

function referenceId(label: string): string {
  return label.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase();
}

function markdownDestination(handle: string): string {
  // Deliberately escaped hashes stay literal, as in the browser. Punctuation
  // escapes inside an actual destination have Markdown's normal meaning.
  return handle.startsWith(PREFIX) ? handle.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1') : handle;
}

const LITERAL_HASH_ENTITY = /&#(?:0*35(?!\d)|x0*23(?![\da-f]));?|&num;/i;

function htmlHref(tag: string): string | null {
  let index = /^<a\b/i.exec(tag)?.[0].length ?? tag.length;
  while (index < tag.length) {
    while (/\s/.test(tag[index] ?? '')) index++;
    const name = /^[^\s/=>]+/.exec(tag.slice(index))?.[0];
    if (!name) break;
    index += name.length;
    while (/\s/.test(tag[index] ?? '')) index++;
    let value = '';
    if (tag[index] === '=') {
      index++;
      while (/\s/.test(tag[index] ?? '')) index++;
      const quote = tag[index] === '"' || tag[index] === "'" ? tag[index++] : undefined;
      const start = index;
      while (index < tag.length && (quote ? tag[index] !== quote : !/[\s>]/.test(tag[index]))) index++;
      value = tag.slice(start, index);
      if (quote) index++;
    }
    // Browsers retain the first duplicate attribute, including a bare href.
    if (name.toLowerCase() === 'href') return LITERAL_HASH_ENTITY.test(value) ? null : decodeHtmlAttribute(value);
  }
  return null;
}

function decodeHtmlAttribute(value: string): string {
  const entities: Record<string, string> = { amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", comma: ',', period: '.', colon: ':', semi: ';', sol: '/', equals: '=', plus: '+', quest: '?' };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([A-Za-z][A-Za-z\d]+));?/gi, (raw, decimal, hex, name) => {
    if (name) return entities[name] ?? raw;
    const point = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\uFFFD';
  });
}

// These CommonMark HTML blocks retain literal body text until a blank line.
// In particular, [label]: destination inside a div is text, not a definition.
const BLOCK_HTML = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s/>]|$)/i;

function locationSource(markdown: string): { source: string; rawHtml: Uint8Array } {
  const rawLines: Array<[number, number]> = [];
  let offset = 0, htmlBlock = false, blockQuote = 0;
  const lines = withoutCode(markdown).split('\n').map(line => {
    const quote = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? '';
    const depth = (quote.match(/>/g) ?? []).length;
    const content = line.slice(quote.length);
    if (depth < blockQuote || !content.trim()) htmlBlock = false;
    if (!htmlBlock && BLOCK_HTML.test(content)) { htmlBlock = true; blockQuote = depth; }
    if (htmlBlock) rawLines.push([offset, offset + content.length]);
    offset += content.length + 1;
    // Reference definitions inside blockquotes use the quote's own Markdown
    // text. Handles themselves are unchanged; extraction exposes no offsets.
    return content;
  });
  const source = lines.join('\n'), rawHtml = new Uint8Array(source.length);
  for (const [start, end] of rawLines) rawHtml.fill(1, start, end);
  return { source, rawHtml };
}

/** Location-specific presentation masking; the other record scanners are unchanged. */
function locationReferenceText(markdown: string): { destinations: string[]; prose: string } {
  const { source, rawHtml } = locationSource(markdown);
  const masked = source.split(''), destinations: string[] = [];
  const mask = (start: number, end: number) => { for (let index = start; index < end; index++) if (masked[index] !== '\n') masked[index] = ' '; };
  // Only real hrefs carry data. Other attributes, comments, and anchor labels
  // never become independent mentions, matching the browser's DOM text walk.
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '<' || escaped(source, start)) continue;
    if (source.startsWith('<!--', start)) {
      const closing = source.indexOf('-->', start + 4), end = closing < 0 ? source.length : closing + 3;
      mask(start, end); start = end - 1; continue;
    }
    const opening = /^<\/?([A-Za-z][\w-]*)\b/.exec(source.slice(start));
    if (!opening) continue;
    let end = start + opening[0].length, quote = '';
    for (; end < source.length; end++) {
      if (quote) { if (source[end] === quote) quote = ''; }
      else if (source[end] === '"' || source[end] === "'") quote = source[end];
      else if (source[end] === '>') { end++; break; }
    }
    if (end > source.length || source[end - 1] !== '>') continue;
    const name = opening[1].toLowerCase(), closing = source[start + 1] === '/';
    if (!closing && name === 'a') {
      const href = htmlHref(source.slice(start, end));
      if (href !== null) destinations.push(href);
      const close = /<\/a\s*>/gi; close.lastIndex = end;
      const match = close.exec(source);
      end = match ? close.lastIndex : source.length;
    } else if (!closing && (name === 'style' || name === 'script')) {
      const close = new RegExp(`<\\/${name}\\s*>`, 'gi'); close.lastIndex = end;
      end = close.exec(source) ? close.lastIndex : source.length;
    }
    mask(start, end); start = end - 1;
  }

  let text = masked.join('');
  const definitionBrackets = bracketPairs(text);
  const definitions = new Map<string, string>();
  const starts = /^ {0,3}\[/gm;
  let definition: RegExpExecArray | null;
  while ((definition = starts.exec(text))) {
    const opening = starts.lastIndex - 1, bracket = definitionBrackets.get(opening) ?? -1;
    if (rawHtml[opening]) continue;
    if (bracket < 0 || text[bracket + 1] !== ':') continue;
    if (bracket - opening - 1 > 999) continue;
    const id = referenceId(text.slice(opening + 1, bracket));
    if (!id || id.length > 999) continue;
    let start = bracket + 2;
    while (/[ \t]/.test(text[start] ?? '')) start++;
    if (text[start] === '\n') { start++; while (/[ \t]/.test(text[start] ?? '')) start++; }
    const destination = destinationAt(text, start);
    if (!destination?.handle) continue;
    let end = destination.end;
    while (/[ \t]/.test(text[end] ?? '')) end++;
    if (text[end] !== '\n' && end !== text.length) {
      end = titleEnd(text, end);
      if (end < 0) continue;
      while (/[ \t]/.test(text[end] ?? '')) end++;
      if (text[end] !== '\n' && end !== text.length) continue;
    } else if (text[end] === '\n') {
      let title = end + 1;
      while (/[ \t]/.test(text[title] ?? '')) title++;
      let stop = titleEnd(text, title);
      if (stop >= 0) {
        while (/[ \t]/.test(text[stop] ?? '')) stop++;
        if (text[stop] === '\n' || stop === text.length) end = stop;
      }
    }
    if (!definitions.has(id)) definitions.set(id, markdownDestination(destination.handle));
    mask(definition.index, end); starts.lastIndex = end;
  }

  text = masked.join('');
  const linkBrackets = bracketPairs(text);
  for (let opening = 0; opening < text.length; opening++) {
    if (text[opening] !== '[' || rawHtml[opening] || escaped(text, opening)) continue;
    const bracket = linkBrackets.get(opening) ?? -1;
    if (bracket < 0) continue;
    let end = bracket + 1, handle: string | undefined;
    if (text[end] === '(') {
      let start = end + 1;
      while (/\s/.test(text[start] ?? '')) start++;
      const destination = destinationAt(text, start);
      if (!destination) continue;
      end = destination.end;
      while (/\s/.test(text[end] ?? '')) end++;
      if (text[end] !== ')') {
        end = titleEnd(text, end);
        if (end < 0) continue;
        while (/\s/.test(text[end] ?? '')) end++;
      }
      if (text[end] !== ')') continue;
      end++; handle = markdownDestination(destination.handle);
    } else {
      let label = text.slice(opening + 1, bracket);
      if (text[end] === '[') {
        const reference = linkBrackets.get(end) ?? -1;
        if (reference < 0) continue;
        label = text.slice(end + 1, reference) || label; end = reference + 1;
      }
      if (label.length > 999) continue;
      handle = definitions.get(referenceId(label));
      if (handle === undefined) continue;
    }
    const image = text[opening - 1] === '!' && !escaped(text, opening - 1);
    if (!image) destinations.push(handle);
    mask(image ? opening - 1 : opening, end); opening = end - 1;
  }
  // Match markdownReferenceText's external-URI masking without running its
  // code scanner again: blanked labels/tags can otherwise manufacture an
  // indented code block and hide visible text that followed them on a line.
  const prose = masked.join('').replace(/(^|[\s(<{"'\[])([a-z][a-z0-9+.-]*:[^\s<>]+)/gi,
    (_match, boundary: string, token: string) => boundary + ' '.repeat(token.length));
  return { destinations, prose };
}

/** Extract authored destinations and bare references, excluding code and labels. */
export function extractLocationReferences(markdown: string): Array<{ ref: LocationReference; handle: string }> {
  const { destinations, prose } = locationReferenceText(markdown);
  const references: Array<{ ref: LocationReference; handle: string }> = [];
  for (const handle of destinations) {
    const ref = parseLocationHandle(handle);
    if (ref) references.push({ ref, handle });
  }
  for (const { ref, handle } of locationMentions(prose)) references.push({ ref, handle });
  return references;
}
