import { describe, it, expect } from 'vitest';
import { buildRoute, parseRoute, readInstanceLocation, instanceUrl, ViewState } from '../src/route';

const flow: ViewState = { filter: null, doc: null };

describe('view route round-trip', () => {
  it('round-trips ASCII and non-ASCII ids through the route', () => {
    const ids = [
      '2026-05-08-migration',     // ASCII
      '2026-05-08-项目报告',        // CJK (Han)
      '2026-05-08-회의록',          // Korean (Hangul)
      '2026-05-08-привет',         // Cyrillic
      '2026-05-08-café-résumé',    // accented Latin
      '2026-05-08-สวัสดี',          // Thai (combining marks)
      '2026-05-04T10:00',          // entry id — a timestamp containing a colon
    ];
    for (const id of ids) {
      const state: ViewState = { filter: { type: 'project', id }, doc: null };
      expect(parseRoute(buildRoute(state))).toEqual(state);
    }
  });

  it('round-trips every view-state shape', () => {
    const states: ViewState[] = [
      { filter: null, doc: null },
      { filter: { type: 'project', id: '2026-05-02-migration' }, doc: null },
      { filter: { type: 'action', id: '2026-05-02-deploy-db' }, doc: null },
      { filter: { type: 'entry', id: '2026-05-02T14:30' }, doc: null },
      { filter: { type: 'project', id: '2026-05-02-migration' }, doc: { kind: 'detail' } },
      { filter: { type: 'action', id: '2026-05-02-deploy-db' }, doc: { kind: 'detail' } },
      { filter: null, doc: { kind: 'detail' } }, // the instance detail
      {
        filter: { type: 'project', id: '2026-05-02-migration' },
        doc: { kind: 'asset', path: 'assets/2026-05-02-migration/2026-05-10-schema-review.md' },
      },
      { filter: null, doc: { kind: 'asset', path: 'assets/2026-05-02-migration/2026-05-10-schema-review.md' } },
    ];
    for (const state of states) {
      expect(parseRoute(buildRoute(state))).toEqual(state);
    }
  });

  it('round-trips artifact documents and exact filenames within its instance URL', () => {
    const id = '2026-10-02-设计审查';
    for (const filename of [undefined, 'desktop.png', '100% done #1 (最新).md', 'literal%2F.png', 'trailing.']) {
      for (const filter of [null, { type: 'project' as const, id: '2026-05-02-migration' }, { type: 'action' as const, id: '2026-05-02-deploy-db' }, { type: 'entry' as const, id: '2026-05-02T14:30' }]) {
        const state: ViewState = { filter, doc: { kind: 'artifact', id, ...(filename === undefined ? {} : { filename }) } };
        const route = buildRoute(state);
        const location = readInstanceLocation(instanceUrl('work', route));
        expect(location.instanceId).toBe('work');
        expect(parseRoute(location.route)).toEqual(state);
      }
    }
  });

  it('rejects invalid artifact ids and nested filenames', () => {
    for (const route of [
      'artifact', 'artifact/not-an-id', 'artifact/2026-02-30-report',
      'artifact/2026-10-02-report/', 'artifact/2026-10-02-report/nested/file.md',
      'artifact/2026-10-02-report/nested%2Ffile.md', 'artifact/2026-10-02-report/%2E%2E',
    ]) expect(parseRoute(route)).toEqual(flow);
    expect(() => buildRoute({ filter: null, doc: { kind: 'artifact', id: '2026-10-02-report', filename: '../file' } })).toThrow();
  });

  it('renders the empty state as the empty route', () => {
    expect(buildRoute(flow)).toBe('');
    expect(parseRoute('')).toEqual(flow);
  });

  it('round-trips the entry jump as a bare entry-id route', () => {
    const id = '2026-05-22T15:30';
    const route = buildRoute({ filter: null, doc: null, jump: id });
    expect(route).toBe(id); // ':' stays raw — the URL shows the id verbatim
    expect(parseRoute(route)).toEqual({ filter: null, doc: null, jump: id });
    // The jump URL is distinct from the entry detail page URL.
    expect(parseRoute(`entry/${id}`)).toEqual({
      filter: { type: 'entry', id },
      doc: null,
    });
  });

  it('round-trips a jump composed with a project/action filter', () => {
    const state = {
      filter: { type: 'project' as const, id: '2026-05-02-migration' },
      doc: null,
      jump: '2026-05-22T15:30',
    };
    const route = buildRoute(state);
    expect(route).toBe(`project/${state.filter.id}/${state.jump}`);
    expect(parseRoute(route)).toEqual(state);
    // Entries have no filtered flow to jump within.
    expect(parseRoute('entry/2026-05-02T14:30/2026-05-22T15:30')).toEqual({ filter: null, doc: null });
  });

  it('encodes ids and asset-path segments, keeping asset slashes real', () => {
    const id = '2026-05-08-项目';
    const route = buildRoute({ filter: { type: 'action', id }, doc: null });
    expect(route).toBe(`action/${encodeURIComponent(id)}`);
    expect(/[^\x00-\x7F]/.test(route)).toBe(false);

    const path = 'assets/2026-05-08-项目/2026-05-10-report.md';
    const assetRoute = buildRoute({ filter: null, doc: { kind: 'asset', path } });
    expect(assetRoute).toBe(`asset/${path.split('/').map(encodeURIComponent).join('/')}`);
    expect(/[^\x00-\x7F]/.test(assetRoute)).toBe(false);
    // Slashes stay real — some servers reject %2F in a request path.
    expect(assetRoute.includes('%2F')).toBe(false);
    expect(assetRoute.split('/').length).toBe(4);
  });

  it('parses a multi-segment asset path as one root-relative path', () => {
    expect(parseRoute('asset/assets/2026-05-02-migration/notes.md')).toEqual({
      filter: null,
      doc: { kind: 'asset', path: 'assets/2026-05-02-migration/notes.md' },
    });
  });

  it('falls back to the raw value for malformed percent-encoding', () => {
    expect(parseRoute('project/%E0%A4')).toEqual({
      filter: { type: 'project', id: '%E0%A4' },
      doc: null,
    });
  });

  it('parses unrecognized or malformed routes as the plain flow', () => {
    expect(parseRoute('bogus/whatever')).toEqual(flow);
    expect(parseRoute('project')).toEqual(flow);
    expect(parseRoute('detail/extra')).toEqual(flow); // the instance detail takes nothing after it
    expect(parseRoute('entry/2026-05-02T14:30/detail')).toEqual(flow); // entries have no detail route
    expect(parseRoute('project/x/detail/extra')).toEqual(flow);
    expect(parseRoute('asset')).toEqual(flow);
    expect(parseRoute('2026-05-22T15:30/extra')).toEqual(flow); // a jump takes nothing after it
    expect(parseRoute('flow')).toEqual(flow); // not a route head — plain-flow fallback
  });
});

describe('instance locations', () => {
  it('keeps chooser and instance timelines distinct', () => {
    expect(readInstanceLocation('/')).toEqual({ instanceId: null, route: '' });
    expect(instanceUrl('work', '')).toBe('/work/');
    expect(readInstanceLocation('/work/')).toEqual({ instanceId: 'work', route: '' });
    expect(readInstanceLocation('/work')).toEqual({ instanceId: 'work', route: '' });
  });

  it('round-trips view state independently for each instance, including system-like IDs', () => {
    for (const id of ['work', 'personal', 'api', 'assets', 'project']) {
      const view: ViewState = { filter: { type: 'action', id: '2026-10-04-项目' }, doc: { kind: 'detail' } };
      const location = readInstanceLocation(instanceUrl(id, buildRoute(view)));
      expect(location.instanceId).toBe(id);
      expect(parseRoute(location.route)).toEqual(view);
    }
  });
});
