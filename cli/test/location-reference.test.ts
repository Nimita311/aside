import { describe, expect, it } from 'vitest';
import { extractLocationReferences, locationDisplay, locationHandle, locationMentions, parseLocationHandle, type LocationReference } from '../src/core/location-reference.js';

const geo = '#location/?geo=51.5034,-0.1276';
const postal = '#location/?postal=10%20Downing%20Street/London/SW1A%202AA/UK/';

describe('location handle values', () => {
  it('accepts coordinates, postal-only content and both independent fields', () => {
    expect(parseLocationHandle(geo)).toEqual({ geo: { latitude: 51.5034, longitude: -0.1276 } });
    expect(parseLocationHandle(postal)).toEqual({ postal: ['10 Downing Street', 'London', 'SW1A 2AA', 'UK'] });
    expect(parseLocationHandle(`${geo}&postal=10%20Downing%20Street/London/`)).toEqual({ geo: { latitude: 51.5034, longitude: -0.1276 }, postal: ['10 Downing Street', 'London'] });
    expect(parseLocationHandle('#location/?postal=London&geo=51.5,-0.1')).toEqual({ postal: ['London'], geo: { latitude: 51.5, longitude: -0.1 } });
  });

  it('supports the RFC 5870 WGS-84 altitude and uncertainty subset', () => {
    expect(parseLocationHandle('#location/?geo=-90,180,-50.25;crs=wgs84;u=0')).toEqual({ geo: { latitude: -90, longitude: 180, altitude: -50.25, uncertainty: 0 } });
    expect(parseLocationHandle('#location/?geo=90,-180;CRS=WGS84;U=12.5')).toEqual({ geo: { latitude: 90, longitude: -180, uncertainty: 12.5 } });
    expect(parseLocationHandle('#location/?geo=51.5%2C-0.1%3Bu%3D20')).toEqual({ geo: { latitude: 51.5, longitude: -0.1, uncertainty: 20 } });
  });

  it('decodes postal components once without treating plus or encoded slashes as separators', () => {
    const handle = '#location/?postal=A+B/20%2F22%20High%20St/100%2525/%E6%9D%B1%E4%BA%AC/';
    const ref = { postal: ['A+B', '20/22 High St', '100%25', '東京'] };
    expect(parseLocationHandle(handle)).toEqual(ref);
    expect(locationHandle(ref)).toBe('#location/?postal=A%2BB/20%2F22%20High%20St/100%2525/%E6%9D%B1%E4%BA%AC/');
  });

  it('canonicalizes key order and escaping while retaining postal spelling and component order', () => {
    const input = '#location/?postal=St.%20John%27s/Country&geo=051.5000,-000.1000;crs=WGS84;u=2.00';
    const ref = parseLocationHandle(input)!;
    expect(locationHandle(ref)).toBe('#location/?geo=51.5,-0.1;u=2&postal=St.%20John%27s/Country/');
    expect(parseLocationHandle(locationHandle(ref))).toEqual(ref);
    expect(locationDisplay(ref)).toBe("St. John's, Country");
    expect(locationDisplay({ geo: { latitude: 51.5, longitude: -0.1 } })).toBe('51.5, -0.1');
  });

  it('serializes exponent-form JavaScript numbers as RFC decimal numbers', () => {
    const ref = { geo: { latitude: 1e-7, longitude: -0, altitude: 1e21, uncertainty: 1e-8 } };
    const handle = locationHandle(ref);
    expect(handle).toBe('#location/?geo=0.0000001,0,1000000000000000000000;u=0.00000001');
    expect(parseLocationHandle(handle)).toEqual({ geo: { latitude: 1e-7, longitude: 0, altitude: 1e21, uncertainty: 1e-8 } });
  });

  it.each([
    '', '#location/', '#location/?', '#location/?geo=', '#location/?postal=', '#location/?postal=/',
    '#location/?geo=1,2&geo=3,4', '#location/?postal=A&postal=B', '#location/?geo=1,2&label=Office',
    '#location/?GEO=1,2', '#location/?%67eo=1,2', '#location/?geo=1,2&', '#location/?geo=1,2#extra',
    '#location/?geo=91,0', '#location/?geo=0,-181', '#location/?geo=1', '#location/?geo=1,2,3,4',
    '#location/?geo=+1,2', '#location/?geo=.1,2', '#location/?geo=1.,2', '#location/?geo=1e1,2',
    '#location/?geo=NaN,2', '#location/?geo=1,Infinity', '#location/?geo=1,2,NaN',
    '#location/?geo=1,2\n', '#location/?geo=1,2%0A', '#location/?geo=1,2%0D%0A',
    '#location/?geo=1,2;u=-1', '#location/?geo=1,2;u=+1', '#location/?geo=1,2;u=1e2',
    '#location/?geo=1,2;crs=other', '#location/?geo=1,2;u=1;crs=wgs84', '#location/?geo=1,2;u=1;u=2',
    '#location/?geo=1,2;zoom=10', '#location/?geo=1,2;crs=wgs84;crs=wgs84',
    '#location/?postal=/A', '#location/?postal=A//B', '#location/?postal=A//',
    '#location/?postal=%', '#location/?postal=%GG', '#location/?postal=%C0%AF', '#location/?postal=%ED%A0%80',
    '#location/?postal=A%00B', '#location/?postal=%0A', '#location/?postal=%20%20',
    '#location/?postal=Raw space', '#location/?postal=東京', '#location/?postal=A&B', '#location/?postal=A=B',
  ])('rejects malformed complete handles: %s', handle => {
    expect(parseLocationHandle(handle)).toBeNull();
  });

  it.each([
    {}, { postal: [] }, { postal: [''] }, { postal: ['A', '\n'] }, { postal: ['\ud800'] }, { postal: new Array(1) },
    { geo: { latitude: 91, longitude: 0 } }, { geo: { latitude: 0, longitude: Infinity } },
    { geo: { latitude: 0, longitude: 0, altitude: NaN } }, { geo: { latitude: 0, longitude: 0, uncertainty: -1 } },
  ])('rejects invalid values when serializing: %j', ref => {
    expect(() => locationHandle(ref as LocationReference)).toThrow('Invalid location reference');
  });

  it('round-trips encoded punctuation and whitespace without rewriting the postal content', () => {
    const ref = { postal: ['  A & B  ', 'Suite (2), #4?', 'A+B=100%', "O'Brien", 'x[]{}<>', '東京'] };
    expect(parseLocationHandle(locationHandle(ref))).toEqual(ref);
    expect(locationMentions(locationHandle(ref))).toMatchObject([{ ref }]);
  });
});

describe('location mentions in Markdown', () => {
  it('reports authored tokens and exact prose positions without matching malformed prefixes', () => {
    const prose = `Meet at ${geo}, then ${postal}. Invalid #location/?geo=1,2oops and #location/?geo=1,2&extra=x.`;
    const mentions = locationMentions(prose);
    expect(mentions.map(value => value.handle)).toEqual([geo, postal]);
    expect(mentions.map(value => prose.slice(value.index, value.index + value.length))).toEqual([geo, postal]);
    expect(locationMentions(`word${geo} /${geo} \\${geo}`)).toEqual([]);
  });

  it('preserves valid postal component dots while separating sentence punctuation', () => {
    const short = '#location/?postal=St.';
    for (const text of [short, `${short},`, `${short}?!`]) {
      const mention = locationMentions(text)[0];
      expect(mention.handle).toBe(short);
      expect(mention.ref.postal).toEqual(['St.']);
      expect(text.slice(mention.index, mention.index + mention.length)).toBe(short);
      expect(extractLocationReferences(text)).toEqual([{ ref: { postal: ['St.'] }, handle: short }]);
    }
    expect(locationMentions(`${postal}.,?!`)[0].handle).toBe(postal);
    expect(locationMentions(`${geo}.`)[0].handle).toBe(geo);
    expect(locationMentions(`${geo};u=10;`)[0].handle).toBe(`${geo};u=10`);
    expect(locationMentions('#location/?postal=St...')[0].handle).toBe('#location/?postal=St...');
  });

  it('bounds scanning work for long unmatched labels and punctuation, retaining valid inner links', () => {
    const source = '['.repeat(100_000) + ` [Office](${postal})`;
    const started = performance.now();
    expect(extractLocationReferences(source)).toEqual([{ ref: parseLocationHandle(postal), handle: postal }]);
    expect(locationMentions(geo + ';'.repeat(100_000))[0].handle).toBe(geo);
    // The former repeated closing-bracket scans took about ten seconds for
    // this input. Leave ample margin for the single-pass implementation.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('extracts authored link destinations and bare handles without interpreting display labels', () => {
    const destination = '#location/?postal=Named%20Address&geo=1.00,2.00';
    const markdown = `[A completely different place](${destination}) ${postal}`;
    const references = extractLocationReferences(markdown);
    expect(references.map(value => value.handle)).toEqual([destination, postal]);
    expect(references[0].ref).toEqual({ postal: ['Named Address'], geo: { latitude: 1, longitude: 2 } });
    expect(locationDisplay(references[0].ref)).toBe('Named Address');
    expect(extractLocationReferences(`[${postal}](https://example.com)`)).toEqual([]);
  });

  it('excludes code, escaped hashes, ordinary URL fragments and labels', () => {
    const markdown = [
      `\`${geo}\``, `\`\`literal \` ${postal}\`\``,
      '```md', geo, '```', '~~~~', postal, '~~~~',
      '> ```md', `> ${geo}`, '> ```',
      '', `    ${postal}`, `\\${geo}`,
      `<code>${geo}</code>`, `<pre>${postal}</pre>`,
      `[${geo}](https://example.com)`, `[External](https://example.com/${geo})`,
      `https://example.com/?target=${geo}`, postal,
    ].join('\n');
    expect(extractLocationReferences(markdown).map(value => value.handle)).toEqual([postal]);
  });

  it('keeps a malformed target wholly literal rather than extracting a valid location prefix', () => {
    for (const invalid of [`${geo}&postal=Bad%`, `${geo}junk`, `${geo}/extra`, `${geo}&unknown=1`]) {
      expect(locationMentions(invalid)).toEqual([]);
      expect(extractLocationReferences(`[Location](${invalid})`)).toEqual([]);
    }
  });

  it('resolves only used full, collapsed, and shortcut reference links', () => {
    const markdown = `[Office][place] [Place][] [PLACE]\n\n[place]: <${postal}> "Office"\n[unused]: #location/?postal=Unused/GB/`;
    expect(extractLocationReferences(markdown).map(value => value.handle)).toEqual([postal, postal, postal]);
    expect(extractLocationReferences(`[unused]: ${postal}`)).toEqual([]);
    expect(extractLocationReferences(`[Office][missing]\n\n[unused]: ${postal}`)).toEqual([]);
  });

  it('normalizes reference IDs and uses the first valid definition', () => {
    const markdown = `[Office][  Main\n Office ]\n\n[main office]:\n  ${postal}\n  'First title'\n[MAIN OFFICE]: #location/?postal=Other/GB/`;
    expect(extractLocationReferences(markdown).map(value => value.handle)).toEqual([postal]);
  });

  it('keeps reference-link and balanced inline labels out of location data', () => {
    const markdown = `[${postal}][outside]\n[${postal}][]\n[Office [nested]](${geo})\n[Label ${postal}](https://example.com)\n\n[outside]: https://example.com\n[${postal}]: https://example.com`;
    expect(extractLocationReferences(markdown).map(value => value.handle)).toEqual([geo]);
    expect(extractLocationReferences(`[${postal}]\n\n[${postal}]: https://example.com`)).toEqual([]);
  });

  it('keeps visible handles behind escaped link openings and literal escaped destinations safe', () => {
    expect(extractLocationReferences(`\\[${postal}](https://example.com)`).map(value => value.handle)).toEqual([postal]);
    expect(extractLocationReferences(`[Office](\\${postal})`)).toEqual([]);
    expect(extractLocationReferences(`[Office][place]\n\n[place]: \\${postal}`)).toEqual([]);
    expect(extractLocationReferences(`\\${postal}`)).toEqual([]);
  });

  it('applies Markdown destination escapes without promoting deliberately escaped hashes', () => {
    const meaningful = '#location/?postal=A_B/';
    expect(extractLocationReferences('[Office](#location/?postal=A\\_B/)')).toEqual([{ ref: { postal: ['A_B'] }, handle: meaningful }]);
    expect(extractLocationReferences('[Office][p]\n\n[p]: #location/?postal=A\\_B/')).toEqual([{ ref: { postal: ['A_B'] }, handle: meaningful }]);
    expect(extractLocationReferences('[Office](\\#location/?postal=A\\_B/)')).toEqual([]);
    expect(extractLocationReferences('<a href="#location/?postal=A\\_B/">Office</a>')).toEqual([]);
  });

  it('resolves blockquote definitions without scanning external link labels or unused definitions', () => {
    expect(extractLocationReferences(`> [Office][p]\n>\n> [p]: ${postal}`).map(value => value.handle)).toEqual([postal]);
    expect(extractLocationReferences(`> [p]: ${postal}`)).toEqual([]);
    expect(extractLocationReferences(`> [${postal}][outside]\n>\n> [outside]: https://example.com`)).toEqual([]);
    expect(extractLocationReferences(`> > [${postal}][outside]\n> >\n> > [outside]: https://example.com`)).toEqual([]);
  });

  it('keeps raw HTML block bodies literal instead of treating their text as Markdown definitions or labels', () => {
    expect(extractLocationReferences(`<div>\n[p]: ${postal}\n</div>`).map(value => value.handle)).toEqual([postal]);
    expect(extractLocationReferences(`<div>\n[${postal}](https://example.com)\n</div>`).map(value => value.handle)).toEqual([postal]);
    expect(extractLocationReferences(`<div>\n</div>\n\n[${postal}][outside]\n\n[outside]: https://example.com`)).toEqual([]);
  });

  it('ignores image destinations and their labels in every Markdown link form', () => {
    const markdown = `![${postal}](${postal}) ![Office][place] ![place][] ![place]\n\n[place]: ${postal}`;
    expect(extractLocationReferences(markdown)).toEqual([]);
  });

  it('masks hidden HTML content and attributes while retaining visible body references', () => {
    const markdown = `<!-- ${postal} [Office](${postal}) -->\n<span title="${postal}" data-href="${postal}">Visible ${geo}</span>\n<script>${postal}</script><style>${postal}</style>`;
    expect(extractLocationReferences(markdown).map(value => value.handle)).toEqual([geo]);
    expect(extractLocationReferences(`<!-- unclosed ${postal}`)).toEqual([]);
    expect(extractLocationReferences(`\\<span title="${postal}">`).map(value => value.handle)).toEqual([postal]);
  });

  it('collects real HTML anchor hrefs while masking all anchor label content', () => {
    const markdown = `<a href="${postal}">Label ${geo}</a> <a HREF='https://example.com'>${postal}</a> <a>${postal}</a>`;
    expect(extractLocationReferences(markdown).map(value => value.handle)).toEqual([postal]);
    expect(extractLocationReferences(`<a data-href="${postal}" href="https://example.com">${postal}</a>`)).toEqual([]);
    expect(extractLocationReferences(`<a href href="${postal}">${postal}</a>`)).toEqual([]);
    expect(extractLocationReferences(`<a href=${postal}>Office</a>`).map(value => value.handle)).toEqual([postal]);
  });

  it('decodes HTML href separators without promoting browser-literal entity hashes', () => {
    const encoded = `${geo}&amp;postal=Office/GB/`;
    expect(extractLocationReferences(`<a href="${encoded}">Office</a>`).map(value => value.handle)).toEqual([`${geo}&postal=Office/GB/`]);
    for (const href of ['&#35;location/?postal=Office/GB/', '&num;location/?postal=Office/GB/', '#location/?postal=A&#35;B/']) {
      expect(extractLocationReferences(`<a href="${href}">Office</a>`)).toEqual([]);
    }
  });
});
