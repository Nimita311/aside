// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderInstanceDetail, type RenderOptions } from '../src/render';

const options: RenderOptions = {
  now: '2026-10-18T10:00', nowDate: new Date('2026-10-18T10:00'), timeFormat: '24h',
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => id, refMarks: () => [], routeHref: route => `/work/${route}`,
  onTagClick() {}, onAssetClick() {}, onEntryTimeClick() {},
};

describe('instance detail configuration fields', () => {
  it.each([21, 0])('renders a numeric recurrence lookahead of %i alongside string settings', recurrenceLookaheadDays => {
    const root = renderInstanceDetail({
      id: 'work', name: 'Work', config: {
        recurrenceLookaheadDays,
        scheduledEventTitlePrefix: '',
        doneEventTitlePrefix: 'done: ',
      },
    }, '', options, { projects: [], actions: { open: [], done: [], cancelled: [] }, stats: [] });
    const fields = Object.fromEntries(Array.from(root.querySelectorAll('dl.detail-fields > dt'))
      .map(label => [label.textContent, label.nextElementSibling?.textContent]));
    expect(fields).toMatchObject({
      ID: 'work',
      'config.recurrenceLookaheadDays': String(recurrenceLookaheadDays),
      'config.scheduledEventTitlePrefix': '',
      'config.doneEventTitlePrefix': 'done: ',
    });
  });
});
