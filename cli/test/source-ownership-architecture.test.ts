import {describe, expect, it} from 'vitest';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {checkSourceAccess, sourceAccessSites, type SourceAccessException} from './support/source-ownership-architecture.js';
import {SOURCE_ACCESS_EXCEPTIONS} from './support/source-ownership-exceptions.js';

// Source and shared storage adapters live outside feature directories. Every
// feature file is checked uniformly, including all MCP tools.
const featureRoots = ['automation', 'graphql', 'web', 'semantic', 'mcp', 'runtime', 'commands'];
const sourceRoot = join(import.meta.dirname, '../src');
function featureFiles(directory: string): string[] {
  return readdirSync(join(sourceRoot, directory), {withFileTypes: true}).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? featureFiles(file) : file.endsWith('.ts') ? [file] : [];
  });
}

describe('feature source ownership architecture', () => {
  it('requires reviewed function-level exceptions for source and filesystem access in every feature file', () => {
    const sites = featureRoots.flatMap(featureFiles).flatMap(file => sourceAccessSites(file, readFileSync(join(sourceRoot, file), 'utf8')));
    expect(checkSourceAccess(sites, SOURCE_ACCESS_EXCEPTIONS)).toEqual([]);
  });

  it.each([
    ['raw filesystem read', `import {readFileSync} from 'node:fs'; export function query(){return readFileSync(file);}`],
    ['aliased filesystem read', `import {readFileSync as read} from 'node:fs'; export function query(){const alias=read; return alias(file);}`],
    ['namespaced filesystem read', `import * as disk from 'node:fs'; export function query(){return disk.readFileSync(file);}`],
    ['destructured filesystem read', `import disk from 'node:fs'; const {readFileSync: read}=disk; export function query(){return read(file);}`],
    ['callback filesystem read', `import {readFile} from 'node:fs'; export function query(){readFile(file, callback);}`],
    ['promise filesystem read', `import {promises as disk} from 'node:fs'; export async function query(){return disk.readFile(file);}`],
    ['dynamic filesystem read', `export async function query(){const disk=await import('node:fs/promises'); return disk.readFile(file);}`],
    ['source helper', `import {readManifestResult as inspect} from '../core/instance.js'; export function query(){return inspect(root);}`],
    ['persistence helper', `import {writeFileCrashSafe as save} from '../storage/atomic-file.js'; export function query(){save(file, data);}`],
    ['namespaced source helper', `import * as instance from '../core/instance.js'; export function query(){return instance.readManifestResult(root);}`],
    ['source cache construction', `import {Store as Records} from '../source/store.js'; export function query(){return new Records(root);}`],
    ['source rebuild', `export function query(store){store.rebuild();}`],
    ['source persistence', `export function query(store){store.saveAction(id, action);}`],
    ['source watch', `export function query(store){store['watch']();}`],
    ['native watch', `import {watch as observe} from 'node:fs'; export function query(){observe(root, callback);}`],
    ['chokidar watch', `import {watch as observe} from 'chokidar'; export function query(){observe(root, callback);}`],
  ])('rejects a new %s without an exception', (_name, source) => {
    const sites = sourceAccessSites('graphql/new-feature.ts', source);
    expect(sites).toHaveLength(1);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it.each(['saveAction', 'saveProject', 'saveArtifact', 'saveEntry', 'saveInstance',
    'addIndexEntry', 'setIndexEntry', 'refreshArtifactAttachments', 'assertSourceIdentity', 'actionMatchesSource',
    'captureActionSourceGuard', 'prepareSourceMutation', 'assertMutationPaths', 'assertNewRecordPath', 'editInstance', 'prepareArtifactSource', 'prepareActionCreation'])('rejects an unapproved Store.%s source access', method => {
    const sites = sourceAccessSites('mcp/tools/query.ts', `export function query(store){store.${method}(id, data);}`);
    expect(sites).toEqual([{file: 'mcp/tools/query.ts', scope: 'query', operation: `source.${method}`, line: 1}]);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it.each([
    ['core/attachment-metadata', 'readAttachmentFiles'], ['core/attachment-metadata', 'readReferenceRoots'],
    ['source/bootstrap', 'init'],
    ['source/instance-admission', 'availableInstances'], ['source/instance-admission', 'registrationPath'],
    ['core/worktree', 'checkoutInfo'], ['core/worktree', 'primaryCounterpart'], ['core/worktree', 'instanceFamily'],
    ['core/worktree', 'withPrimaryInstances'], ['core/worktree', 'withoutInstanceFamilies'],
    ['daemon/host', 'instanceKey'],
    ['source/recurrence-history', 'recurrenceHistoryPath'], ['source/recurrence-history', 'readRecurrenceHistory'],
    ['source/recurrence-history', 'writeRecurrenceHistory'], ['daemon/instance-operations', 'bootstrapInstanceSource'],
    ['daemon/instance-operations', 'createInstanceSource'],
    ['source/serialize-existing-record', 'serializeExistingRecord'],
    ['source/index-file', 'prependIndex'], ['source/index-file', 'updateIndexDescription'],
    ['source/execution-context', 'readExecutionContextSnapshot'], ['source/artifact-source', 'prepareArtifactSource'],
    ['source/serialize', 'serializeAction'], ['source/serialize', 'serializeProject'], ['source/serialize', 'serializeArtifact'],
  ])('rejects a feature bypassing its owner through %s.%s', (module, helper) => {
    const file = 'graphql/new-feature.ts';
    const sites = sourceAccessSites(file, `import {${helper}} from '../${module}.js'; export function query(){return ${helper}(root);}`);
    expect(sites).toHaveLength(1);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it.each([
    'const read=store.prepareSourceMutation; return read(file, transform);',
    'const read=store.prepareSourceMutation.bind(store); return read(file, transform);',
    'return store.prepareSourceMutation.call(store, file, transform);',
    "const read=store['prepareSourceMutation']; return read(file, transform);",
    'const {prepareSourceMutation: read}=store; return read(file, transform);',
    'return transform(store.prepareSourceMutation);',
  ])('rejects extracted source-owner capabilities: %s', body => {
    const file = 'graphql/new-feature.ts', sites = sourceAccessSites(file, `function query(store){${body}}`);
    expect(sites).toEqual([{file, scope: 'query', operation: 'source.prepareSourceMutation', line: 1}]);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it.each([
    'sync.setReconciliationOwner(callback);',
    'const bind=sync.setReconciliationOwner.bind(sync); return bind(callback);',
    'const {setReconciliationOwner: bind}=sync; return bind(callback);',
    'owner.requestFeatureReconcile("calendar", store, 1000);',
  ])('rejects features taking over lifecycle scheduling: %s', body => {
    const sites = sourceAccessSites('mcp/calendar/new-feature.ts', `function run(){${body}}`);
    expect(sites).toHaveLength(1);
    expect(sites[0].operation).toMatch(/^lifecycle\./);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it('rejects an imported source reader passed as a callback', () => {
    const file = 'graphql/new-feature.ts';
    const sites = sourceAccessSites(file, "import {isAsideDir} from '../core/instance.js'; function query(paths){return paths.filter(isAsideDir);}");
    expect(sites).toEqual([{file, scope: 'query', operation: 'core/instance.isAsideDir', line: 1}]);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it.each([
    'const read=readAttachmentFiles.bind(null); return read(root,id,names);',
    'return readAttachmentFiles.call(null,root,id,names);',
    'return readAttachmentFiles.apply(null,[root,id,names]);',
    'const call=readAttachmentFiles.call; return call(null,root,id,names);',
    "const read=readAttachmentFiles['bind'](null); return read(root,id,names);",
    'return invoke(readAttachmentFiles.bind);',
  ])('rejects bound or forwarded imported source adapters: %s', body => {
    const file = 'graphql/new-feature.ts';
    const sites = sourceAccessSites(file, `import {readAttachmentFiles} from '../core/attachment-metadata.js'; function query(root){${body}}`);
    expect(sites).toEqual([{file, scope: 'query', operation: 'core/attachment-metadata.readAttachmentFiles', line: 1}]);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it.each([
    ['mcp/tools/update', 'handleUpdateAction'], ['mcp/tools/update', 'handleUpdateProject'], ['mcp/tools/update', 'handleUpdateEntry'],
    ['mcp/tools/capture', 'handleCapture'], ['mcp/tools/capture', 'resolveEntityRefs'],
    ['mcp/tools/instance', 'handleUpdateInstance'], ['mcp/tools/recurrence', 'handleUpdateOccurrence'],
    ['mcp/tools/artifact', 'createArtifact'], ['mcp/tools/artifact', 'handleUpdateArtifact'],
    ['mcp/tools/artifact', 'prepareCreateArtifact'],
  ])('rejects mutation adapter %s.%s from a new query', (module, helper) => {
    const file = 'graphql/new-feature.ts';
    const source = `import {${helper} as mutate} from '../${module}.js'; function query(store){return mutate(store, args);}`;
    const sites = sourceAccessSites(file, source);
    expect(sites).toEqual([{file, scope: 'query', operation: `${module}.${helper}`, line: 1}]);
    expect(checkSourceAccess(sites, [])).toEqual([expect.stringContaining('Unapproved source access')]);
  });

  it.each([
    `function other(){const read=parse; return read(text);}`,
    `function other(read){return read(text);}`,
    `function other(){const {read}=parser; return read(text);}`,
  ])('does not let unrelated local shadowing hide an imported source reader: %s', other => {
    const file = 'graphql/new-feature.ts';
    const source = `import {readFileSync as read} from 'node:fs'; import {parse} from './parse.js';
      function query(){return read(path);} ${other}`;
    expect(sourceAccessSites(file, source)).toEqual([{file, scope: 'query', operation: 'fs.readFileSync', line: 2}]);
  });

  it('keeps block-scoped shadows local and resolves aliases at their declaration', () => {
    const file = 'graphql/new-feature.ts';
    const source = `import {readFileSync as read} from 'node:fs'; import {parse} from './parse.js';
      function query(){const original=read; {const read=parse; read(text);} return original(path);}`;
    expect(sourceAccessSites(file, source)).toEqual([{file, scope: 'query', operation: 'fs.readFileSync', line: 2}]);
  });

  it('grants only the exact declared file, function, operation, and number of accesses', () => {
    const source = `import {readFileSync, writeFileSync} from 'node:fs';
      export function selectedAttachment(){return readFileSync(file);}`;
    const exception: SourceAccessException = {file: 'graphql/attachment.ts', scope: 'selectedAttachment',
      operations: {'fs.readFileSync': 1}, reason: 'Read the explicitly selected regular attachment bytes.'};
    const check = (text: string, file = exception.file) => checkSourceAccess(sourceAccessSites(file, text), [exception]);
    expect(check(source)).toEqual([]);
    expect(check(source, 'graphql/other.ts')).toEqual(expect.arrayContaining([expect.stringContaining('Unapproved source access')]));
    expect(check(source.replace('selectedAttachment', 'query'))).toEqual(expect.arrayContaining([expect.stringContaining('Unapproved source access')]));
    expect(check(source.replace('return readFileSync(file);', 'writeFileSync(file, data); return readFileSync(file);'))).toEqual([expect.stringContaining('fs.writeFileSync')]);
    expect(check(source.replace('return readFileSync(file);', 'readFileSync(other); return readFileSync(file);'))).toEqual([expect.stringContaining('approved 1')]);
  });

  it('requires reasons and rejects duplicate, invalid, or stale exceptions', () => {
    const exception: SourceAccessException = {file: 'graphql/attachment.ts', scope: 'selectedAttachment', operations: {'fs.readFileSync': 1}, reason: 'Selected attachment bytes.'};
    expect(checkSourceAccess([], [exception])).toEqual([expect.stringContaining('Stale ownership exception')]);
    expect(checkSourceAccess([], [{...exception, reason: '  '}])).toEqual(expect.arrayContaining([expect.stringContaining('Missing ownership exception reason')]));
    expect(checkSourceAccess([], [exception, exception])).toEqual(expect.arrayContaining([expect.stringContaining('Duplicate ownership exception')]));
    expect(checkSourceAccess([], [{...exception, operations: {'fs.readFileSync': 0}}])).toEqual(expect.arrayContaining([expect.stringContaining('Invalid ownership exception count')]));
    const oneAccess = sourceAccessSites(exception.file, `import {readFileSync} from 'node:fs'; function selectedAttachment(){readFileSync(file);}`);
    expect(checkSourceAccess(oneAccess, [{...exception, operations: {'fs.readFileSync': 2}}])).toEqual([expect.stringContaining('Stale ownership exception')]);
  });

  it('does not classify pure queries or imported type names as source access', () => {
    const source = `import type {Store} from '../source/store.js'; import {readFileSync} from 'node:fs';
      export function query(store: Store){return store.getProjects();}`;
    expect(sourceAccessSites('graphql/query.ts', source)).toEqual([]);
  });
});
