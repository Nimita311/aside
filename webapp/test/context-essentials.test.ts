// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderContextEssentials, type ContextEssentials, type EssentialsKind } from '../src/context-essentials';
import { refreshDisplay } from '../src/display';
import { actionPills, projectPills } from '../src/instance';
import { formatStamp, type RenderOptions } from '../src/render';

const options: RenderOptions = {
  now: '2026-10-18T10:00', nowDate: new Date('2026-10-18T10:00'), timeFormat: '24h',
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => id, refMarks: () => [], routeHref: route => `/work/${route}`,
  onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(),
};
const mount = (data: ContextEssentials) => document.body.appendChild(renderContextEssentials(data, options));
afterEach(() => document.body.replaceChildren());

describe('shared right-panel essentials', () => {
  it.each<EssentialsKind>(['instance','project','action','entry','artifact','attachment','file','date','date-range'])('gives %s a pill identity followed by its explicit type', kind => {
    const header = mount({ kind, name: 'Example', description: 'A short description.' });
    expect(header.dataset.kind).toBe(kind);
    expect(header.querySelector('.entity-title .context-identity .entity-title-label')?.textContent).toBe('Example');
    expect(header.querySelector('.context-essentials-type')?.textContent).toBe(kind === 'date-range' ? 'Date range' : kind[0].toUpperCase() + kind.slice(1));
    expect(header.children[1].className).toBe('summary-description');
    expect(header.querySelector('.summary-facts')).toBeNull();
    expect(header.querySelector('.context-essentials-facts')).toBeNull();
  });

  it('counts capture, organize and deliver in that order, followed by owned artifacts, retaining known zeros', () => {
    const header = mount({ kind:'instance', name:'Work', description:'A workspace.', counts:{ artifacts:7, actions:{open:1,total:3}, projects:{open:2,total:4}, entries:0, attachments:90 }, updated:'2026-10-18T08:00' });
    expect(Array.from(header.querySelectorAll<HTMLElement>('[data-count-kind]')).map(node => node.dataset.countKind)).toEqual(['entries','projects','actions','artifacts']);
    expect(Array.from(header.querySelectorAll('.stat-count')).map(node => node.textContent)).toEqual(['0','2/4','1/3','7']);
    expect(header.querySelector('[data-count-kind="entries"]')?.getAttribute('aria-label')).toBe('0 entries');
    expect(header.querySelector('[data-count-kind="artifacts"]')?.getAttribute('aria-label')).toBe('7 artifacts');
    expect(header.querySelector('.facts-updated')?.textContent).toBe('updated 2h ago');
    expect(Array.from(header.children).map(node => node.className)).toEqual(['context-essentials-row','summary-description','summary-facts context-essentials-counts']);
  });

  it('counts only containment on artifacts and never infers a file or attachment census from references', () => {
    const counts = {entries:12,projects:{total:3},actions:{total:2},artifacts:4,attachments:2};
    const artifact = mount({kind:'artifact',name:'Brief',counts});
    expect(Array.from(artifact.querySelectorAll<HTMLElement>('[data-count-kind]')).map(node => node.dataset.countKind)).toEqual(['attachments']);
    expect(artifact.querySelector('.summary-stat')?.getAttribute('aria-label')).toBe('2 attachments');
    for (const kind of ['attachment','file'] as const) {
      const header = mount({kind,name:'notes.md',path:'notes/notes.md',counts});
      expect(header.querySelector('.summary-facts')).toBeNull();
      expect(header.querySelector('a')).toBeNull();
      expect(header.querySelector('.context-essentials-path')?.textContent).toBe('notes/notes.md');
    }
    const date = mount({kind:'date',name:'October 18',counts:{entries:1}});
    expect(date.querySelector('.summary-stat')?.getAttribute('aria-label')).toBe('1 entry');
  });

  it('draws a date identity as the calendar page its value shows as', () => {
    const state = (data: ContextEssentials) => mount(data).querySelector<SVGElement>('.context-identity-icon svg')?.dataset.state;
    expect(state({kind:'date',name:'October 18'})).toBe('day');
    expect(state({kind:'date-range',name:'October 12 – 18'})).toBe('range');
    expect(state({kind:'date',name:'October 18, 09:30',icon:'time'})).toBe('time');
  });

  it('keeps self-explanatory lifecycle facts unlabeled and adds labels only for scheduled time and deadline', () => {
    const project = mount({kind:'project',name:'Launch',status:()=>projectPills({name:'Launch',created:'2026-10-12'})});
    expect(project.querySelector('.context-essential-value')?.textContent).toBe('Open');
    expect(project.querySelector<HTMLElement>('.context-essential-label')?.hidden).toBe(true);
    const action = mount({kind:'action',name:'Review',status:current=>actionPills({name:'Review',created:'2026-10-12',scheduled:'2026-10-18T12:00',deadline:'2026-10-21'},current.nowDate)});
    const facts = Array.from(action.querySelectorAll<HTMLElement>('.context-essential-fact'));
    expect(facts.map(node=>node.getAttribute('aria-label'))).toEqual(['Deadline: In 3d','Scheduled: In 2h','No calendar']);
    expect(facts[2].querySelector<HTMLElement>('.context-essential-label')?.hidden).toBe(true);
    expect(action.textContent).not.toContain('State');
  });

  it('updates schedule status, urgency, identity and date preferences in place when the clock changes', () => {
    const action = {name:'Review',created:'2026-10-12',scheduled:'2026-10-18T12:00',duration:'PT30M',deadline:'2026-10-18T12:30'};
    const header = mount({kind:'action',name:current=>formatStamp('2026-10-18T12:00',current),status:current=>actionPills(action,current.nowDate)});
    const pill = header.querySelector('.context-identity');
    const name = header.querySelector('.entity-title-label');
    const factNodes = Array.from(header.querySelectorAll('.context-essential-fact'));
    const later = {...options,now:'2026-10-18T14:00',nowDate:new Date('2026-10-18T14:00'),timeFormat:'12h' as const};
    refreshDisplay(header,later);
    expect(header.querySelector('.context-identity')).toBe(pill);
    expect(header.querySelector('.entity-title-label')).toBe(name);
    expect(Array.from(header.querySelectorAll('.context-essential-fact'))).toEqual(factNodes);
    expect(name?.textContent).toContain('12:00 PM');
    expect(pill?.classList.contains('tag-status-overdue')).toBe(true);
    expect(pill?.classList.contains('tag-status-slipped')).toBe(true);
    expect(factNodes[0].classList.contains('is-overdue')).toBe(true);
    expect(factNodes[1].textContent).toContain('Slipped');
    expect((factNodes[2] as HTMLElement).hidden).toBe(true);
  });

  it('retains resolution and authored schedule-zone context without forcing redundant state labels', () => {
    const header = mount({kind:'action',name:'Review',status:current=>actionPills({name:'Review',created:'2026-10-12',scheduled:'2026-10-18T12:00',timezone:'Asia/Tokyo',resolution:'done'},current.nowDate)});
    const fact = header.querySelector('.context-essential-fact')!;
    expect(fact.querySelector('.context-essential-value')?.textContent).toBe('Done');
    expect(fact.querySelector<HTMLElement>('.context-essential-label')?.hidden).toBe(true);
    expect(fact.querySelector('.context-essential-annotation')?.textContent).toContain('Asia/Tokyo');
    expect(header.querySelector('.context-identity')?.classList.contains('tag-status-closed')).toBe(true);
    expect(header.querySelector('.context-identity')?.classList.contains('tag-status-cancelled')).toBe(false);
  });

  it('draws each tile glyph as its entity icon in the tile state, morphing in place as the clock moves', () => {
    const glyphs = (header: HTMLElement) => Array.from(header.querySelectorAll<HTMLElement>('.context-essential-fact:not([hidden]) .context-essential-icon'))
      .map(node => { const svg = node.querySelector<SVGElement>('svg.entity-icon'); return svg ? `${svg.dataset.icon}:${svg.dataset.state}` : 'exception'; });
    const action = (fields: object) => mount({kind:'action',name:'Review',status:current=>actionPills({name:'Review',created:'2026-10-12',...fields},current.nowDate)});
    expect(glyphs(mount({kind:'project',name:'Launch',status:()=>projectPills({name:'Launch',created:'2026-10-12'})}))).toEqual(['project:live']);
    expect(glyphs(mount({kind:'project',name:'Launch',status:()=>projectPills({name:'Launch',created:'2026-10-12',ended:'2026-10-17'})}))).toEqual(['project:ended']);
    expect(glyphs(action({}))).toEqual(['action:backlog']);
    expect(glyphs(action({resolution:'done'}))).toEqual(['action:done']);
    expect(glyphs(action({resolution:'cancelled'}))).toEqual(['action:cancelled']);
    expect(glyphs(action({recurrence:[{dtstart:'2026-10-19T09:00',rrule:'FREQ=DAILY'}]}))).toEqual(['action:recurring']);
    const header = action({scheduled:'2026-10-18T12:00',duration:'PT30M',deadline:'2026-10-21'});
    expect(glyphs(header)).toEqual(['action:scheduled','action:scheduled','exception']);
    const exception = header.querySelectorAll('.context-essential-fact')[2].querySelector('svg');
    refreshDisplay(header,options);
    expect(header.querySelectorAll('.context-essential-fact')[2].querySelector('svg')).toBe(exception);
    const scheduled = header.querySelectorAll('.context-essential-fact')[1].querySelector('svg');
    refreshDisplay(header,{...options,now:'2026-10-18T14:00',nowDate:new Date('2026-10-18T14:00')});
    expect(glyphs(header)).toEqual(['action:scheduled','action:slipped']);
    expect(header.querySelectorAll('.context-essential-fact')[1].querySelector('svg')).toBe(scheduled);
  });

  it('renders authored text as text even when it resembles HTML', () => {
    const header = mount({kind:'file',name:'<img src=x onerror=alert(1)>',description:'<script>bad()</script>',path:'<a>path</a>'});
    expect(header.querySelector('img,script,a')).toBeNull();
    expect(header.querySelector('.entity-title-label')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
