import {describe, expect, it} from 'vitest';
import {deriveMutationPayloadIds, hasGraphQLProblems, isFullMutationFailure, summarizeMutationError} from '../src/graphql/results.js';
import type {MutationResult} from '../src/mcp/tools/mutation-result.js';

const result = (value: Partial<MutationResult> = {}): MutationResult => ({status: 'SUCCEEDED', changes: [], failures: [], ...value});

describe('agent-readable GraphQL mutation results', () => {
  it('returns null on success, including successful no-op mutations', () => {
    expect(summarizeMutationError(result())).toBeNull();
    expect(summarizeMutationError(result({changes: [{kind: 'action', id: 'task', effect: 'UPDATED'}]}))).toBeNull();
    expect(isFullMutationFailure(result())).toBe(false);
  });

  it('consolidates durable changes, failed steps, and recovery without public structured error types', () => {
    const partial = result({status: 'PARTIAL', changes: [
      {kind: 'project', id: 'project', effect: 'CREATED', path: '/data/project.md'},
      {kind: 'attachment', id: '#artifact/files/old.txt', effect: 'REMOVED', path: '/data/old.txt'},
    ], failures: [{kind: 'index', id: 'project', fields: ['description'], path: '/data/index.yaml', message: 'Permission denied'}], recovery: 'Read the saved project and repair its description index.'});
    expect(isFullMutationFailure(partial)).toBe(false);
    const error = summarizeMutationError(partial, {message: 'Permission denied'})!;
    expect(error).toContain('Partial failure');
    expect(error).toContain('Created project "project" (/data/project.md)');
    expect(error).toContain('Removed attachment "#artifact/files/old.txt" (/data/old.txt)');
    expect(error).toContain('index "project" [description] (/data/index.yaml): Permission denied');
    expect(error).toContain('Read the saved project');
    expect(error.match(/Permission denied/g)).toHaveLength(1);
  });

  it('classifies returned failures with no writes as full failures and reports no saved changes', () => {
    const failed = result({status: 'FAILED', failures: [{kind: 'index', id: 'unindexed', message: 'Description was not saved'}], recovery: 'Preserve saved changes and do not repeat a saved create.'});
    expect(isFullMutationFailure(failed)).toBe(true);
    expect(summarizeMutationError(failed)).toContain('No changes were saved.');
    expect(summarizeMutationError(failed)).toContain('Description was not saved');
    expect(summarizeMutationError(failed)).not.toContain('Recovery:');
    expect(summarizeMutationError(failed)).not.toContain('Preserve saved');
    expect(isFullMutationFailure(result({status: 'PARTIAL'}))).toBe(true);
  });

  it('uses known warning metadata without parsing authored body or receipt strings', () => {
    const warning = 'Calendar authorization is required.';
    const error = summarizeMutationError(result(), {warnings: [warning, warning]})!;
    expect(error).toBe(`Warnings:\n- ${warning}`);
    expect(isFullMutationFailure(result())).toBe(false);
  });

  it('retains a thrown diagnostic and supplies recovery when durable effects exist', () => {
    const partial = result({status: 'PARTIAL', changes: [{kind: 'entry', id: 'entry', effect: 'CREATED'}]});
    const error = summarizeMutationError(partial, {message: 'Readback failed'})!;
    expect(error).toContain('Readback failed');
    expect(error).toContain('Created entry "entry"');
    expect(error).toContain('retry only the incomplete steps');
  });

  it('derives child record IDs from confirmed creates and excludes indexes, updates, and unsaved outcomes', () => {
    const partial = result({status: 'PARTIAL', changes: [
      {kind: 'project', id: 'saved-project', effect: 'CREATED'},
      {kind: 'index', id: 'saved-project', effect: 'CREATED'},
      {kind: 'project', id: 'saved-project', effect: 'CREATED'},
      {kind: 'action', id: 'existing-action', effect: 'UPDATED'},
      {kind: 'action', id: 'saved-action', effect: 'CREATED'},
    ]});
    expect(deriveMutationPayloadIds('entry', undefined, partial, {entryId: 'unsaved-entry', createdProjectIds: ['unsaved-project'], createdActionIds: ['unsaved-action']})).toEqual({
      id: undefined, createdProjectIds: ['saved-project'], createdActionIds: ['saved-action'],
    });
    expect(deriveMutationPayloadIds('entry', 'existing-entry', partial).id).toBe('existing-entry');
  });

  it('returns the materialized occurrence ID instead of its transient projection ID', () => {
    const partial = result({status: 'PARTIAL', changes: [{kind: 'action', id: 'saved-occurrence', effect: 'CREATED'}]});
    expect(deriveMutationPayloadIds('action', 'projection', partial).id).toBe('saved-occurrence');
  });

  it('finds an attachment-only artifact owner without fabricating an artifact record', () => {
    const partial = result({status: 'PARTIAL', changes: [{kind: 'attachment', id: '#artifact/2026-10-02-files/first.txt', effect: 'CREATED'}]});
    expect(deriveMutationPayloadIds('artifact', undefined, partial).id).toBe('2026-10-02-files');
    expect(deriveMutationPayloadIds('artifact', 'existing-artifact', partial).id).toBe('existing-artifact');
  });

  it('retains successful handler identities when the write was a no-op', () => {
    expect(deriveMutationPayloadIds('action', undefined, result(), {id: 'saved-action'}).id).toBe('saved-action');
    expect(deriveMutationPayloadIds('entry', undefined, result(), {entryId: 'saved-entry'}).id).toBe('saved-entry');
  });

  it('signals transport problems for reported partial failures even without GraphQL errors', () => {
    expect(hasGraphQLProblems({extensions: {mutations: [{operation: 'capture', error: 'Partial failure', changes: []}]}})).toBe(true);
    expect(hasGraphQLProblems({errors: [{message: 'Full failure'}]})).toBe(true);
    expect(hasGraphQLProblems({errors: [], extensions: {mutations: [{operation: 'capture', error: null, changes: []}]}})).toBe(false);
    expect(hasGraphQLProblems({})).toBe(false);
  });
});
