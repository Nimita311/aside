import { describe, expect, it } from 'vitest';
import { TOOL_SCHEMAS, validateToolArgs } from '../src/mcp/schemas.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';

const valid: Record<string, object> = {
  query: { document: '{ projects { totalCount } }' }, mutate: { document: 'mutation { __typename }' },
  select_instance: { path: '/tmp/aside' }, create_instance: { path: '/tmp/aside', name: 'Work', description: 'Work' },
  list_instances: {}, query_entries: {}, query_actions: {}, query_projects: {}, query_artifacts: {},
  create_artifact: { name: 'Plan', description: 'Plan' }, update_artifact: { id: '2026-10-04-plan' },
  capture: { content: 'Note', description: 'Note' }, update_action: { id: '2026-10-04-task' },
  update_project: { id: '2026-10-04-project' }, update_entry: { id: '2026-10-04T12:00' },
  validate: {}, show: {}, calendar_info: {},
};

describe('strict shared tool arguments', () => {
  it.each(Object.keys(TOOL_SCHEMAS))('rejects unsupported top-level arguments for %s', name => {
    expect(() => validateToolArgs(name, { ...valid[name], unsupported: true })).toThrow(/unsupported/);
  });
  it.each([
    ['capture', { ...valid.capture, projects: [{ name: 'Project', description: 'Project', created: '2026-10-04T12:00' }] }, /projects.0.*created/],
    ['capture', { ...valid.capture, actions: [{ name: 'Task', description: 'Task', owner: 'me' }] }, /actions.0.*owner/],
    ['update_entry', { ...valid.update_entry, projects: [{ name: 'Project', description: 'Project', related_projects: [{ project: 'p', description: 'related', owner: 'me' }] }] }, /related_projects.0.*owner/],
    ['update_project', { ...valid.update_project, related_projects: [{ project: 'p', description: 'related', id: 'p' }] }, /related_projects.0.*id/],
    ['create_artifact', { ...valid.create_artifact, files: [{ source: '/tmp/source', path: '/tmp/target' }] }, /files.0.*path/],
    ['update_artifact', { ...valid.update_artifact, files: [{ source: '/tmp/source', content: 'text' }] }, /files.0.*content/],
  ] as const)('rejects unsupported nested %s arguments with their location', (name, args, message) => {
    expect(() => validateToolArgs(name, args)).toThrow(message);
  });
  it.each(['update_action', 'update_project'])('requires a nonblank supplied %s name', name => {
    for (const nameValue of ['', '  ', null]) expect(() => validateToolArgs(name, { ...valid[name], name: nameValue })).toThrow(/name/);
    expect(validateToolArgs(name, { ...valid[name], name: 'New name' }).name).toBe('New name');
  });
  it('rejects direct host arguments before loading an instance or invoking calendar access', async () => {
    const host = new InstanceHost(new CalClient('/nonexistent/aside-cal'));
    try {
      await expect(host.tool('/nonexistent/aside', 'update_action', { id: 'a', typo: 'value' })).rejects.toThrow(/typo/);
      await expect(host.tool(null, 'calendar_info', { unknown: true })).rejects.toThrow(/unknown/);
      await expect(host.show('/nonexistent/aside', { unknown: true } as any)).rejects.toThrow(/unknown/);
      expect(host.loadedPaths()).toEqual([]);
    } finally { host.close(); }
  });

  it.each(['', '  ', '\n\t'])('rejects blank calendar routing without changing account qualifier semantics', calendar => {
    expect(() => validateToolArgs('update_action', { id: 'a', calendar })).toThrow(/calendar.*null/);
    const action = { name: 'Task', description: 'Task', calendar };
    expect(() => validateToolArgs('capture', { content: 'Note', description: 'Note', actions: [action] })).toThrow(/calendar/);
    expect(() => validateToolArgs('update_entry', { id: 'e', actions: [action] })).toThrow(/calendar/);
    expect(validateToolArgs('update_action', { id: 'a', calendar: null, calendar_account: '' })).toMatchObject({ calendar: null, calendar_account: '' });
  });

  it('validates project closure without applying a runtime timezone or changing null reopening', () => {
    for (const ended of ['2026-02-30T25:90', '2026-02-29T12:00', '2026-10-04', '2026-10-04T12:00Z', '']) {
      expect(() => validateToolArgs('update_project', { id: 'p', ended })).toThrow(/ended/);
    }
    for (const ended of ['2024-02-29T12:00', '2026-03-08T02:30', '0001-01-01T00:00', null]) {
      expect(validateToolArgs('update_project', { id: 'p', ended })).toMatchObject({ ended });
    }
  });
});
