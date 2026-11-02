import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { assertDelegation } from '../src/core/delegation.js';
import * as models from '../src/automation/models.js';

let dir: string, host: InstanceHost;
const run = {model: 'external', prompt: '#artifact/2026-10-12-instructions'};
beforeEach(() => {
  dir = mkdtempSync('/tmp/aside-delegation-author-'); init(dir, {name: 'Delegations', description: 'Tests'});
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(models, 'catalogFor').mockResolvedValue({models: [{name: 'external', label: 'external', builtin: false, availability: 'AVAILABLE'}], diagnostics: [], revision: 'test'});
  host = new InstanceHost(new CalClient(null));
});
afterEach(async () => {await host.close(); vi.restoreAllMocks(); rmSync(dir, {recursive: true, force: true});});
async function graph(document: string, mode = 'mutate', variables?: Record<string, unknown>) {return JSON.parse((await host.tool(dir, mode, {document, variables})).text);}
describe('delegation declarations', () => {
  it.each([{run: {script: 'echo'}}, {run: {...run, prompt: 'Instructions'}}, {run: {...run, prompt: {artifact: run.prompt}}}, {run, schedule: {at: '2099-01-01T00:00:00Z'}}, {run, timeout: null}, {run, timeout: 'PT0S'}, {run, overlap: 'skip'}])('rejects malformed declarations: %j', declaration => {
    expect(() => assertDelegation(declaration)).toThrow();
  });
  it('creates an instruction artifact and action together, preserves omitted delegation, and clears it explicitly', async () => {
    const result = await graph(`mutation {capture(input: {content: "Context", description: "Context", actions: [{create: {
      name: "Work", description: "Work", delegation: {run: {model: "external", prompt: {create: {name: "Instructions", description: "Instructions", body: "Perform the work."}}}}
    }}]}) {createdActions {id delegation {timeout run {model prompt {id content {... on MarkdownContent {text}}}}}}}}`);
    expect(result.errors).toBeUndefined();
    const saved = result.data.capture.createdActions[0];
    expect(saved.delegation).toMatchObject({timeout: 'PT30M', run: {model: 'external', prompt: {content: {text: 'Perform the work.'}}}});
    const store = host.load(dir).store;
    expect(store.getAction(saved.id)!.frontMatter.delegation).toEqual({run: {model: 'external', prompt: `#artifact/${saved.delegation.run.prompt.id}`}});
    expect(result.extensions.mutations[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'artifact', effect: 'CREATED'}), expect.objectContaining({kind: 'action', effect: 'CREATED'})]));
    vi.mocked(models.catalogFor).mockClear();
    await graph(`mutation {updateAction(id: "${saved.id}", input: {body: "Changed context"}) {action {delegation {run {model}}}}}`);
    expect(models.catalogFor).not.toHaveBeenCalled();
    const cleared = await graph(`mutation {updateAction(id: "${saved.id}", input: {delegation: null}) {action {delegation {timeout}}}}`);
    expect(cleared.data.updateAction.action.delegation).toBeNull();
    expect(readFileSync(store.getActionFile(saved.id)!, 'utf8')).not.toContain('delegation:');
  });
  it('inherits declarations on projections and lets a saved occurrence suppress its delegation', async () => {
    const result = await graph(`mutation {capture(input: {content: "Context", description: "Context", actions: [{create: {
      name: "Recurring", description: "Recurring", recurrence: [{dtstart: "2099-01-01", rrule: "FREQ=DAILY;COUNT=2"}],
      delegation: {run: {model: "external", prompt: {create: {name: "Instructions", description: "Instructions", body: "Perform the work."}}}}
    }}]}) {createdActions {id}}}`);
    const template = result.data.capture.createdActions[0].id;
    const saved = await graph(`mutation {updateOccurrence(input: {template: "${template}", original: "2099-01-01", delegation: null}) {action {id delegation {timeout} occurrence {projected}}}}`);
    expect(saved.errors).toBeUndefined(); expect(saved.data.updateOccurrence.action.delegation).toBeNull();
    expect(saved.data.updateOccurrence.action.occurrence.projected).toBe(false);
    const read = await graph(`{action(id: "${template}") {delegation {run {model}}}}`, 'query');
    expect(read.data.action.delegation.run.model).toBe('external');
  });
  it('preflights invalid prompt content before saving an inline artifact or action', async () => {
    const result = await graph(`mutation {capture(input: {content: "Context", description: "Context", actions: [{create: {
      name: "Work", description: "Work", delegation: {run: {model: "external", prompt: {create: {name: "Empty instructions", description: "Instructions"}}}}
    }}]}) {createdActions {id}}}`);
    expect(result.errors).toHaveLength(1);
    const store = host.load(dir).store;
    expect(store.getActions().size).toBe(0); expect(store.getArtifacts().size).toBe(0);
  });
});
