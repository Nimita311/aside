import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join, posix} from 'node:path';
import ts from 'typescript';
import {InstanceHost} from '../src/daemon/host.js';
import type {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {Store} from '../src/source/store.js';
import {InstancePathError} from '../src/core/instance.js';
import {trackMutation} from '../src/source/mutation-result.js';
import {executeGraphQL} from '../src/graphql/schema.js';
import * as models from '../src/automation/models.js';
import {hostGraphQL} from './support/graphql-host.js';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 8, 12));
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(models, 'catalogFor').mockResolvedValue({models: [{name: 'CUSTOM', label: 'Custom', builtin: false, availability: 'AVAILABLE'}], diagnostics: [], revision: 'owner'});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});
function fixture(savedPrompt = false) {
  const root = realpathSync(mkdtempSync('/private/tmp/aside-transaction-scope-'));
  const manifest = join(root, 'aside.md');
  const declaration = savedPrompt ? 'automations:\n  task:\n    schedule: {at: "2099-01-01T00:00:00Z"}\n    run: {model: CUSTOM, prompt: "#artifact/2026-10-08-instructions"}\n' : '';
  writeFileSync(manifest, `---\nid: transaction-owner\nname: Owner\n${declaration}---\n\n`);
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
  const {store} = host.load(root);
  const owner: InstanceLifecycle = (host as any).sources;
  let depth = 0;
  const mutation = owner.mutation.bind(owner);
  vi.spyOn(owner, 'mutation').mockImplementation((selected, write, options) => {
    depth++;
    try {return mutation(selected, write, options);} finally {depth--;}
  });
  const accounted = vi.spyOn(store, 'notePersistedChanges');
  const repair = vi.spyOn(owner, 'invalidate');
  cleanups.push(async () => {await host.close(); rmSync(root, {recursive: true, force: true});});
  const graph = async (document: string) => JSON.parse((await hostGraphQL(host, root, 'mutate', {document})).text);
  return {root, manifest, host, store, owner, graph, accounted, repair, depth: () => depth};
}

describe('complete lifecycle mutation scope', () => {
  it('accounts a linked artifact created after a valid no-op parent before leaving lifecycle', async () => {
    const f = fixture(true), before = readFileSync(f.manifest, 'utf8');
    const save = f.store.saveArtifact.bind(f.store);
    const write = vi.spyOn(f.store, 'saveArtifact').mockImplementation((...args) => {
      expect(f.depth()).toBe(1);
      return save(...args);
    });
    const result = await f.graph(`mutation {updateInstance(input:{automations:{upsert:[{name:"task",schedule:{at:"2099-01-01T00:00:00Z"},run:{model:"CUSTOM",prompt:{create:{name:"Instructions",description:"Instructions",body:"Write a digest."}}}}]}}){error}}`);
    expect(result.errors).toBeUndefined();
    expect(result.data.updateInstance.error).toBeNull();
    expect(write).toHaveBeenCalledOnce();
    expect(readFileSync(f.manifest, 'utf8')).toBe(before);
    const changes = result.extensions.mutations[0].changes;
    expect(changes.map((change: any) => change.kind)).toEqual(['artifact', 'index']);
    expect(f.accounted).toHaveBeenCalledExactlyOnceWith(changes);
  });

  it('accounts and repairs a late partial failure inside lifecycle before GraphQL formats the receipt', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'addIndexEntry').mockImplementation(() => {throw new Error('Index failed after record saved');});
    const refresh = f.owner.refresh.bind(f.owner);
    const readback = vi.spyOn(f.owner, 'refresh').mockImplementation(selected => {
      expect(f.depth()).toBe(1);
      expect(f.accounted).toHaveBeenCalledOnce();
      return refresh(selected);
    });
    const result = await f.graph('mutation{createArtifact(input:{name:"Saved",description:"Saved",body:"Durable"}){error artifact{id content{...on MarkdownContent{text}}}}}');
    expect(result.errors).toBeUndefined();
    expect(result.data.createArtifact.error).toContain('Index failed after record saved');
    expect(result.data.createArtifact.artifact.content.text).toBe('Durable');
    const changes = result.extensions.mutations[0].changes;
    expect(changes).toEqual([expect.objectContaining({kind: 'artifact', effect: 'CREATED'})]);
    expect(f.accounted).toHaveBeenCalledExactlyOnceWith(changes);
    expect(f.repair).toHaveBeenCalledWith(f.store);
    expect(readback).toHaveBeenCalledOnce();
  });

  it('retains linked partial effects when a later linked index commit fails', async () => {
    const f = fixture(true);
    vi.spyOn(f.store, 'addIndexEntry').mockImplementation(() => {throw new Error('Linked index failed');});
    const result = await f.graph(`mutation {updateInstance(input:{automations:{upsert:[{name:"task",schedule:{at:"2099-01-01T00:00:00Z"},run:{model:"CUSTOM",prompt:{create:{name:"Instructions",description:"Instructions",body:"Saved instructions."}}}}]}}){error}}`);
    expect(result.errors).toBeUndefined();
    expect(result.data.updateInstance.error).toContain('Linked index failed');
    expect(f.accounted).toHaveBeenCalledExactlyOnceWith(result.extensions.mutations[0].changes);
    expect(f.store.getArtifact('2026-10-08-instructions')?.body).toBe('Saved instructions.');
  });

  it('runs linked hooks once and does not commit them after failed parent preflight', () => {
    const f = fixture(), linked = vi.fn();
    f.owner.mutation(f.store, () => f.store.saveInstance('---\nid: transaction-owner\nname: Updated\n---\n', ['name']), {beforeWrite: linked});
    expect(linked).toHaveBeenCalledOnce();
    linked.mockClear();
    expect(() => f.owner.mutation(f.store, () => {throw new Error('Rejected before write');}, {beforeWrite: linked})).toThrow('Rejected before write');
    expect(linked).not.toHaveBeenCalled();
  });

  it('rejects an adapter-owned outer journal before executing the lifecycle write', () => {
    const f = fixture(), write = vi.fn();
    expect(() => trackMutation(f.store, () => f.owner.mutation(f.store, write))).toThrow('ownership of the complete mutation journal');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a foreign journal before source repair can persist effects', async () => {
    const f = fixture();
    await f.host.tool(f.root, 'create_artifact', {name: 'Files', description: 'Files'});
    const id = f.store.getArtifactIds()[0], file = f.store.getArtifactFile(id)!;
    const original = readFileSync(file, 'utf8');
    const directory = join(f.root, 'artifacts', '2026', id);
    mkdirSync(directory); writeFileSync(join(directory, 'external.txt'), 'External attachment');
    f.store.recordRebuildFailure(new Error('Source repair pending'));
    const write = vi.fn(), refresh = vi.spyOn(f.owner, 'refresh');

    expect(() => trackMutation(f.store, () => f.owner.mutation(f.store, write, {readback: true})))
      .toThrow('ownership of the complete mutation journal');

    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('preserves the owner admission error before starting an ordinary journal', () => {
    const f = fixture(), write = vi.fn();
    rmSync(f.manifest);

    expect(() => f.owner.mutation(f.store, write)).toThrow(InstancePathError);
    expect(write).not.toHaveBeenCalled();
    expect(f.accounted).not.toHaveBeenCalled();
  });

  it('repairs failed readback before accepting the next serial root', async () => {
    const f = fixture();
    // The record is durable, but its graph could not publish. This differs
    // from throwing after a successful save, which leaves a queryable snapshot.
    vi.spyOn((f.store as any).core, 'deriveRelations').mockImplementationOnce(() => {throw new Error('Graph publication failed');});
    vi.spyOn(f.store, 'rebuild').mockImplementationOnce(() => {throw new Error('Readback temporarily unavailable');});
    const result = await f.graph(`mutation {
      first:createArtifact(input:{name:"First",description:"First",body:"First body"}){error artifact{content{...on MarkdownContent{text}}}}
      second:createArtifact(input:{name:"Second",description:"Second",body:"Second body"}){error artifact{content{...on MarkdownContent{text}}}}
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.first.artifact).toBeNull();
    expect(result.data.first.error).toContain('Readback temporarily unavailable');
    expect(result.data.second).toEqual({error: null, artifact: {content: {text: 'Second body'}}});
    expect(f.store.getArtifact('2026-10-08-first')?.body).toBe('First body');
    expect(f.accounted).toHaveBeenCalledTimes(2);
  });

  it('prepares action status commands from the owner-repaired source generation', async () => {
    const f = fixture(), id = '2026-10-08-latest';
    const directory = join(f.root, 'actions', '2026'), file = join(directory, `${id}.md`);
    mkdirSync(directory, {recursive: true});
    const source = '---\nname: Latest\ncreated: 2026-10-08\n';
    writeFileSync(file, `${source}---\nBody.\n`);
    f.store.rebuild();
    expect(f.store.getAction(id)!.frontMatter.scheduled).toBeUndefined();
    // A source repair is pending; the loaded state predates the saved schedule.
    // GraphQL must not reject SCHEDULED using that older state before invoking
    // the mutation owner, which owns repair and selects the current generation.
    writeFileSync(file, `${source}scheduled: 2026-10-09T10:00\n---\nBody.\n`);
    f.store.recordRebuildFailure(new Error('Source repair pending'));
    const refresh = vi.spyOn(f.owner, 'refresh');
    const result = await f.graph(`mutation{updateAction(id:"${id}",input:{status:SCHEDULED}){error action{status scheduled}}}`);
    expect(result.errors).toBeUndefined();
    expect(result.data.updateAction).toEqual({error: null, action: {status: 'SCHEDULED', scheduled: '2026-10-09T10:00'}});
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('requires an owner-provided final receipt instead of inventing an adapter journal', async () => {
    const f = fixture();
    const result = await executeGraphQL(f.store, 'mutation', {document: 'mutation{capture(input:{content:"Ignored",description:"Ignored"}){error}}'}, {
      mutate: (() => ({text: ''})) as any,
    });
    expect(JSON.stringify(result.errors)).toContain('Lifecycle-provided mutation receipt is unavailable');
    expect(f.accounted).not.toHaveBeenCalled();
  });
});

function adapterTransactionErrors(text: string): string[] {
  const document = ts.createSourceFile('graphql/adapter.ts', text, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const journal = (value: ts.Node | undefined) => {
    if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return false;
    const module = posix.normalize(value.text.startsWith('.') ? posix.join('graphql', value.text) : value.text)
      .replace(/\.[cm]?[jt]s$/, '');
    return /(?:^|\/)source\/mutation-result$/.test(module);
  };
  const forbidden = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
    elements.some(element => !element.isTypeOnly && (element.propertyName ?? element.name).text !== 'MutationWriteError');
  const propertyName = (name: ts.PropertyName): string | undefined => {
    const value = ts.isComputedPropertyName(name) ? name.expression : name;
    return ts.isIdentifier(value) || ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
  };
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && journal(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (clause.name || bindings && ts.isNamespaceImport(bindings)
          || bindings && ts.isNamedImports(bindings) && forbidden(bindings.elements)) errors.push('GraphQL cannot own mutation journals or write hooks');
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && journal(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause) || forbidden(clause.elements)) errors.push('GraphQL cannot re-export mutation journal capabilities');
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && journal(node.moduleReference.expression)) errors.push('GraphQL cannot acquire a journal namespace');
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && journal(node.arguments[0])) errors.push('GraphQL cannot acquire journal capabilities dynamically');
    if ((ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isMethodSignature(node) || ts.isMethodDeclaration(node))
      && propertyName(node.name) === 'refreshSource') errors.push('GraphQL cannot own source repair policy');
    ts.forEachChild(node, visit);
  }
  visit(document); return errors;
}

describe('GraphQL transaction capability boundary', () => {
  it('keeps authored GraphQL adapters free of journal and repair capabilities', () => {
    const files = (directory: string): string[] => readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
      const file = join(directory, entry.name);
      return entry.isDirectory() ? files(file) : file.endsWith('.ts') ? [file] : [];
    });
    for (const file of files(join(import.meta.dirname, '../src/graphql'))) expect(adapterTransactionErrors(readFileSync(file, 'utf8'))).toEqual([]);
  });
  it.each([
    "import {trackMutation as record} from '../source/mutation-result.js';",
    "import {beforeMutationWrite} from '../source/mutation-result.js';",
    "import {trackOwnedMutation} from '../source/mutation-result.js';",
    "import * as journal from '../source/mutation-result.js';",
    "const journal = require('../source/mutation-result.js');",
    "const journal = import('../source/mutation-result.js');",
    "export {trackMutation as execute} from '../source/mutation-result.js';",
    "export * from '../source/mutation-result.js';",
    "export * as journal from '../source/mutation-result.js';",
    "import journal = require('../source/mutation-result.js');",
    "import {trackMutation} from '../source/./mutation-result.js';",
    "const journal = import(`../source/mutation-result.js`);",
    "const journal = require(`../source/./mutation-result.js`);",
    'interface Options {refreshSource?: (source: Store) => void}',
    'interface Options {"refreshSource"?: (source: Store) => void}',
    'const options = {[`refreshSource`]: (source) => owner.refresh(source)};',
    'interface Options {refreshSource(source: Store): void}',
  ])('rejects adapter-owned transaction/repair capability: %s', source => expect(adapterTransactionErrors(source)).not.toEqual([]));
  it('allows prepared domain plans, owner callbacks and receipt/error formatting', () => {
    expect(adapterTransactionErrors("import {MutationWriteError, type MutationResult} from '../source/mutation-result.js'; const outcome = owner.mutate(() => ({operation: name, input, beforeWrite: preparedCommit}));")).toEqual([]);
    expect(adapterTransactionErrors("export {MutationWriteError, type MutationResult} from '../source/mutation-result.js'; export type * from '../source/mutation-result.js';")).toEqual([]);
  });
});
