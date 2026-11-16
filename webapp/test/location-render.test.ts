// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderActionDetail, renderAssetDetail, renderEntry, type RenderOptions } from '../src/render';
import { parseActionFile } from '../../cli/src/core/parser';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

const geo = '#location/?geo=51.5034,-0.1276';
const postal = '#location/?postal=10%20Downing%20Street/London/SW1A%202AA/United%20Kingdom/';
const both = `${geo}&postal=10%20Downing%20Street/London/SW1A%202AA/United%20Kingdom/`;

function options(): RenderOptions {
  return {timeFormat: '24h', now: '2026-10-31T09:00', nowDate: new Date('2026-10-31T09:00'), expandProjects: false, expandActions: false,
    activeFilter: null, resolveName: (_type, id) => id, refMarks: () => [], onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(),
    routeHref: route => '/work/' + route};
}
function mount(content: string) {
  return renderEntry({meta: {created: '2026-10-31T09:00'}, weekFile: '2026-10-26', content}, options(), document.body.appendChild(document.createElement('main')));
}

describe('location content elements', () => {
  it('renders coordinates, civic addresses and their combined value without display labels', () => {
    const card = mount(`Point (${geo}). Address ${postal}. Both ${both}.`);
    const chips = [...card.querySelectorAll<HTMLElement>('.inline-tag-location')];
    expect(chips).toHaveLength(3);
    expect(chips.map(chip => chip.dataset.locationHandle)).toEqual([geo, postal, both]);
    expect(chips[0].querySelector('.location-label')?.textContent).toContain('51.5034');
    expect(chips[1].querySelector('.location-label')?.textContent).toContain('10 Downing Street');
    expect(chips[2].querySelector('.location-label')?.textContent).toContain('10 Downing Street');
    expect(chips.every(chip => chip.dataset.locationLabel === undefined)).toBe(true);
    // The pin shows its point once coordinates are saved; postal text alone pends.
    expect(chips.map(chip => chip.querySelector<SVGElement>(':scope > svg.entity-icon')?.dataset.state)).toEqual(['geo', 'postal', 'geo']);
    expect(card.textContent).toContain('Point (');
    expect(card.textContent).toContain('). Address');
    const map = new URL((chips[2] as HTMLAnchorElement).href);
    expect(map.origin).toBe('https://maps.apple.com');
    expect(map.searchParams.get('coordinate')).toBe('51.5034,-0.1276');
    expect(map.searchParams.get('address')).toBe('10 Downing Street, London, SW1A 2AA, United Kingdom');
    expect(chips[2].getAttribute('target')).toBe('_blank');
    expect(chips[2].getAttribute('rel')).toBe('noopener');
  });

  it('keeps optional Markdown labels as presentation while retaining postal and geo data', () => {
    const card = mount(`[**Office**](${both} "Visit the office")`);
    const chip = card.querySelector<HTMLAnchorElement>('.inline-tag-location')!;
    expect(chip.querySelector('.location-label strong')?.textContent).toBe('Office');
    expect(chip.dataset.locationLabel).toBe('Office');
    expect(chip.dataset.locationMarkdownLabel).toBe('**Office**');
    expect(chip.dataset.locationHandle).toBe(both);
    expect(chip.title).toBe('Visit the office');
    const map = new URL(chip.href);
    expect(map.searchParams.get('address')).toBe('10 Downing Street, London, SW1A 2AA, United Kingdom');
    expect(map.searchParams.has('name')).toBe(false);
    expect(chip.getAttribute('aria-describedby')).toBeTruthy();
    expect(chip.outerHTML).not.toContain('aside-location-');
  });

  it('keeps postal-only elements visible and inert, including labeled links', () => {
    const card = mount(`${postal} and [**Home**](${postal}).`);
    const chips = [...card.querySelectorAll<HTMLElement>('.inline-tag-location')];
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.tagName).toBe('SPAN');
      expect(chip.hasAttribute('href')).toBe(false);
      expect(chip.classList.contains('is-unresolved')).toBe(true);
      expect(chip.title).toContain('Coordinates unavailable');
      expect(chip.dataset.locationHandle).toBe(postal);
    }
    expect(chips[1].querySelector('strong')?.textContent).toBe('Home');
    expect(chips[1].dataset.locationMarkdownLabel).toBe('**Home**');
    expect(card.querySelector('.rendered-content a[href]')).toBeNull();
  });

  it('preserves exact authored spelling and coordinate precision for copying', () => {
    const authored = '#location/?postal=Office/GB/&geo=51.503400,-0.127600';
    const card = mount(`Bare ${authored} and [Work](${authored}).`);
    const chips = [...card.querySelectorAll<HTMLElement>('.inline-tag-location')];
    expect(chips).toHaveLength(2);
    expect(chips.every(chip => chip.dataset.locationHandle === authored)).toBe(true);
    expect(chips[1].dataset.locationMarkdownLabel).toBe('Work');
    expect(new URL((chips[0] as HTMLAnchorElement).href).searchParams.get('coordinate')).toBe('51.5034,-0.1276');
  });

  it('matches equivalent location values for hover without rewriting authored handles', () => {
    const first = '#location/?geo=1.0,2.00', second = '#location/?geo=1,2';
    const card = mount(`${first} and ${second}`);
    const links = [...card.querySelectorAll<HTMLElement>('.inline-tag-location')];
    expect(links.map(link => link.dataset.locationHandle)).toEqual([first, second]);
    expect(links[0].dataset.refHover).toBe(links[1].dataset.refHover);
  });

  it('preserves postal periods and leaves punctuation after a canonical trailing slash outside the chip', () => {
    const abbreviated = '#location/?postal=St.';
    const canonical = '#location/?postal=Office/';
    const card = mount(`${abbreviated}, [Street](${abbreviated}) and ${canonical}.`);
    const chips = [...card.querySelectorAll<HTMLElement>('.inline-tag-location')];
    expect(chips.map(chip => chip.dataset.locationHandle)).toEqual([abbreviated, abbreviated, canonical]);
    expect(chips.map(chip => chip.querySelector('.location-label')?.textContent)).toEqual(['St.', 'Street', 'Office']);
    expect(chips[0].nextSibling?.textContent).toBe(', ');
    expect(chips[2].nextSibling?.textContent?.trim()).toBe('.');
  });

  it('keeps code, escaped or entity hashes, unrelated links and malformed candidates literal', () => {
    const malformed = ['#location/?geo=91,0', '#location/?geo=1,2junk', '#location/?geo=1,2&geo=3,4', '#location/?postal=%ZZ/', '#location/?geo=1,2&unknown=evil'];
    const card = mount(`\`${both}\`\n\n\`\`\`md\n${geo}\n\`\`\`\n\n\\${geo} &#35;location/?geo=51.5034,-0.1276 [${geo}](https://example.com) ${malformed.join(' ')} [literal](\\${geo})`);
    expect(card.querySelectorAll('.inline-tag-location')).toHaveLength(0);
    expect(card.querySelector('code')?.textContent).toBe(both);
    for (const literal of malformed) expect(card.textContent).toContain(literal);
    expect(card.querySelector('a[href="https://example.com"]')?.textContent).toBe(geo);
    expect(card.innerHTML).not.toContain('aside-location-');
  });

  it('does not promote invalid authored link destinations through Markdown URI encoding', () => {
    const card = mount('[Office](#location/?postal=東京/千代田区/) and [Invalid](#location/?geo=91,0)');
    expect(card.querySelector('.inline-tag-location')).toBeNull();
    expect(card.innerHTML).not.toContain('aside-location-');
    expect(card.querySelector('.rendered-content a')?.textContent).toBe('Office');
  });

  it('renders postal text safely and never treats authored label text as another location', () => {
    const dangerous = `${geo}&postal=%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E/GB/`;
    const card = mount(`${dangerous} and [${geo}](${postal})`);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('[onerror]')).toBeNull();
    const label = card.querySelector('.inline-tag-location.is-unresolved .location-label');
    expect(label?.textContent).toBe(geo);
    expect(label?.querySelector('.inline-tag-location')).toBeNull();
  });

  it.each(['#project/2026-10-31-place', '#artifact/2026-10-31-place', '#date/2026-10-31'])(
    'keeps a malformed location wholly literal when it contains %s', other => {
    const malformed = '#location/?geo=1,2&unknown=' + other;
    const card = mount(malformed);
    expect(card.querySelector('.rendered-content')?.textContent?.trim()).toBe(malformed);
    expect(card.querySelector('.inline-tag, .artifact-link')).toBeNull();
  });

  it('supports location elements in supporting Markdown documents', () => {
    const reader = renderAssetDetail('assets/plan.md', {kind: 'markdown', text: `Visit [**the office**](${both}).`}, options(), []);
    document.body.append(reader);
    const chip = reader.querySelector<HTMLAnchorElement>('.inline-tag-location')!;
    expect(chip.dataset.locationHandle).toBe(both);
    expect(chip.querySelector('.location-label strong')?.textContent).toBe('the office');
    expect(chip.href).toMatch(/^https:\/\/maps\.apple\.com\/place\?/);
  });
});

describe('action location metadata', () => {
  function detail(location?: string, body = '') {
    const view = renderActionDetail('2026-10-31-visit', {frontMatter: {
      name: 'Visit', created: '2026-10-31T09:00', ...(location === undefined ? {} : {location}),
    }, body}, undefined, options(), []);
    document.body.append(view);
    return view;
  }

  it.each([geo, postal, both])('renders the primary %s independently of body mentions', handle => {
    const view = detail(handle, `Another point: ${geo}.`);
    const field = [...view.querySelectorAll('.detail-fields > dt')].find(node => node.textContent === 'Location')?.nextElementSibling;
    const chip = field?.querySelector<HTMLElement>('.inline-tag-location');
    expect(chip?.dataset.locationHandle).toBe(handle);
    expect(chip?.tagName).toBe(handle === postal ? 'SPAN' : 'A');
    expect(chip?.querySelector('.location-label')?.textContent).toBe(handle === geo
      ? '51.5034, -0.1276' : '10 Downing Street, London, SW1A 2AA, United Kingdom');
    expect(chip?.dataset.locationLabel).toBeUndefined();
    expect(view.querySelector('.detail-body .inline-tag-location')?.getAttribute('data-location-handle')).toBe(geo);
  });

  it('omits an unset location and displays malformed or labeled saved fields as plain text', () => {
    expect([...detail().querySelectorAll('.detail-fields > dt')].some(node => node.textContent === 'Location')).toBe(false);
    for (const location of ['#location/?geo=91,0', `[Office](${both})`, '<img src=x onerror=alert(1)>']) {
      const view = detail(location);
      const field = [...view.querySelectorAll('.detail-fields > dt')].find(node => node.textContent === 'Location')!.nextElementSibling!;
      expect(field.textContent).toBe(location);
      expect(field.querySelector('.inline-tag-location, a, img')).toBeNull();
    }
  });

  it.each([
    ['{postal: Office}', '{"postal":"Office"}'],
    ['[Office, London]', '["Office","London"]'],
    ['123', '123'], ['0', '0'], ['false', 'false'], ['null', 'null'],
  ])('keeps invalid YAML location %s visible as plain repairable text', (yaml, expected) => {
    const parsed = parseActionFile(`---\nname: Visit\ncreated: 2026-10-31T09:00\nlocation: ${yaml}\n---\n`);
    expect(parsed.issues.some(issue => issue.code === 'invalid_location')).toBe(true);
    const view = renderActionDetail('2026-10-31-visit', parsed.value, undefined, options(), []);
    const field = [...view.querySelectorAll('.detail-fields > dt')].find(node => node.textContent === 'Location')!.nextElementSibling!;
    expect(field.textContent).toBe(expected);
    expect(field.querySelector('*')).toBeNull();
  });
});
