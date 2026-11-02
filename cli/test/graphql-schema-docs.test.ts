import { describe, expect, it } from 'vitest';
import { buildClientSchema, getIntrospectionQuery, graphqlSync, printSchema, validateSchema, type IntrospectionQuery } from 'graphql';
import { buildGraphQLSchema } from '../src/graphql/schema.js';

// Documentation is part of the agent API: a client must discover constraints
// through normal introspection without loading implementation or legacy tools.
function introspection() {
  const result = graphqlSync({
    schema: buildGraphQLSchema(),
    source: getIntrospectionQuery({ inputValueDeprecation: true, oneOf: true }),
  });
  expect(result.errors).toBeUndefined();
  return result.data as unknown as IntrospectionQuery;
}

describe('GraphQL agent schema documentation', () => {
  it('explains default-browser opening and caller-managed private authorization URLs', () => {
    const data = introspection();
    const schema = buildClientSchema(data);
    const mutation = schema.getMutationType()!.getFields();
    expect(mutation.show.type.toString()).toBe('ShowPayload');
    expect(mutation.showUrl.type.toString()).toBe('String');
    for (const field of [mutation.show, mutation.showUrl]) {
      expect(field.args[0].type.toString()).toBe('ShowInput!');
    }
    const mutationDocs = data.__schema.types.find(type => type.name === 'Mutation')!;
    if (mutationDocs.kind !== 'OBJECT') throw new Error('Mutation must be an object');
    for (const name of ['show', 'showUrl']) {
      expect(mutationDocs.fields.find(field => field.name === name)!.args[0].defaultValue).toMatch(/^\{\s*\}$/);
    }
    expect(mutation.show.description).toContain('system default browser');
    expect(mutation.show.description).toContain('showUrl');
    for (const text of ['file://', 'private temporary HTML file', 'without opening or navigating any browser',
      'one-use code', 'automatically installs valid authorization', 'redirects to the target', 'two minutes',
      'request a new URL for each opening', 'No token handling or separate authentication call']) {
      expect(mutation.showUrl.description).toContain(text);
    }
    expect((schema.getType('ShowOutcome') as any).getValues().map((value: any) => value.name)).toEqual(['OPENED', 'UNAVAILABLE']);
  });

  it('exposes resolved project relations and typed content links through introspection', () => {
    const schema = buildClientSchema(introspection());
    const project = schema.getType('Project') as any;
    expect(project.getFields().relatedProjects.type.toString()).toBe('ProjectRelationPage!');
    expect(project.getFields()).not.toHaveProperty('relatedProjectLinks');
    expect(schema.getType('ProjectLink')).toBeUndefined();
    const relation = schema.getType('ProjectRelation') as any;
    expect(relation.getFields().project.type.toString()).toBe('Project!');
    expect(relation.getFields().direction.type.toString()).toBe('ProjectRelationDirection!');
    expect((schema.getType('ProjectRelationDirection') as any).getValues().map((value: any) => value.name)).toEqual(['OUTGOING', 'INCOMING', 'BIDIRECTIONAL']);
    expect(schema.getPossibleTypes(schema.getType('LinkTarget') as any).map((type: any) => type.name)).toEqual(['Entry', 'Project', 'Action', 'Artifact']);
    for (const name of ['Entry', 'Project', 'Action', 'Artifact']) {
      const fields = (schema.getType(name) as any).getFields();
      expect(fields.links.type.toString()).toBe('LinkPage!');
      expect(fields.backlinks.type.toString()).toBe('LinkPage!');
    }
  });

  it('describes every public type, field, argument, input, and enum through standard introspection', () => {
    const data = introspection();
    for (const type of data.__schema.types.filter(type => !type.name.startsWith('__'))) {
      expect(type.description, type.name).toBeTruthy();
      if (type.kind === 'OBJECT' || type.kind === 'INTERFACE') for (const field of type.fields) {
        expect(field.name, `${type.name}.${field.name}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(field.description, `${type.name}.${field.name}`).toBeTruthy();
        for (const arg of field.args) {
          expect(arg.name, `${type.name}.${field.name}(${arg.name})`).toMatch(/^[a-z][A-Za-z0-9]*$/);
          expect(arg.description, `${type.name}.${field.name}(${arg.name})`).toBeTruthy();
        }
      }
      if (type.kind === 'INPUT_OBJECT') for (const field of type.inputFields) {
        expect(field.name, `${type.name}.${field.name}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(field.description, `${type.name}.${field.name}`).toBeTruthy();
      }
      if (type.kind === 'ENUM') for (const value of type.enumValues) {
        expect(value.description, `${type.name}.${value.name}`).toBeTruthy();
      }
    }
  });

  it('uses the same automation types for action delegation declarations, dispatch and history', () => {
    const schema = buildClientSchema(introspection());
    const action = (schema.getType('Action') as any).getFields();
    const automation = (schema.getType('Automation') as any).getFields();
    const mutation = schema.getMutationType()!.getFields();
    expect(action.delegation.type.toString()).toBe('Automation');
    expect(mutation.runDelegation.type.toString()).toBe('AutomationRun');
    for (const field of [action.delegationLog, automation.log]) {
      expect(field.type.toString()).toBe('AutomationRunPage!');
      expect(field.args.find((arg: any) => arg.name === 'where').type.toString()).toBe('AutomationRunWhere');
    }
    for (const name of ['Delegation', 'DelegationRun', 'DelegationRunPage', 'DelegationRunWhere', 'DelegationRunPayload', 'AgentRunDefinition']) {
      expect(schema.getType(name)).toBeUndefined();
    }
    const run = (schema.getType('AutomationRun') as any).getFields();
    expect(run.action.type.toString()).toBe('Action');
    expect(run.completionError.type.toString()).toBe('String');
  });

  it('makes non-obvious query, replacement, clearing, and file contracts discoverable', () => {
    const data = introspection();
    const description = (name: string, field?: string) => {
      const type = data.__schema.types.find(type => type.name === name)!;
      if (!field) return type.description!;
      const fields = type.kind === 'INPUT_OBJECT' ? type.inputFields : type.kind === 'OBJECT' ? type.fields : [];
      return fields.find(item => item.name === field)!.description!;
    };
    expect(description('ActionWhere', 'ids')).toContain('[] matches nothing');
    expect(description('ActionWhere', 'projectIds')).toContain('[] for no');
    expect(description('ArtifactWhere', 'search')).toContain('ECMAScript regex without delimiters or flags');
    expect(description('ArtifactWhere', 'search')).toContain('not attachment contents');
    expect(description('ProjectRelationFilter', 'none')).toContain('record diagnostics');
    expect(description('Entry', 'projects')).toContain('explicitly tagged');
    expect(description('Action', 'calendar')).toContain('scheduled time or a template recurrence schedule');
    expect(description('Project', 'relatedProjects')).toContain('direction');
    expect(description('ProjectTagEditsInput', 'set')).toContain('Replace all');
    expect(description('UpdateArtifactInput', 'attachments')).toContain('Adds or replaces only');
    expect(description('UpdateActionInput', 'body')).toContain('null is not accepted');
    expect(description('UpdateActionInput', 'scheduled')).toContain('Null deschedules');
    expect(description('CaptureInput', 'content')).toContain('exactly one of content or contentFile');
    expect(description('CaptureInput', 'contentFile')).toContain('Absolute path');
    expect(description('ArtifactAttachmentInput', 'source')).toContain('on this server');
    expect(description('CapturePayload', 'createdProjects')).toContain('excluding links to existing');
    expect(description('Mutation')).toContain('earlier writes survive later failures');
    expect(description('Mutation')).toContain('never blindly retry');

    const query = data.__schema.types.find(type => type.name === 'Query')!;
    if (query.kind !== 'OBJECT') throw new Error('Query must be an object');
    const args = query.fields.find(field => field.name === 'actions')!.args;
    expect(args.map(arg => arg.name)).not.toContain('after');
    expect(args.find(arg => arg.name === 'offset')!.defaultValue).toBe('0');
    expect(args.find(arg => arg.name === 'limit')!.defaultValue).toBe('20');
    expect(args.find(arg => arg.name === 'limit')!.description).toContain('1 to 100');
  });

  it('documents recurrence identity and automation choices, preserving live schema round trips', () => {
    const data = introspection();
    const schema = buildClientSchema(data);
    expect(validateSchema(schema)).toEqual([]);
    const sdl = printSchema(schema);
    expect(schema.getType('Model')).toBeUndefined();
    expect(sdl).toContain('model: String');
    expect(schema.getType('ModelOption')).toBeDefined();
    expect(sdl).toContain('Exactly one schedule form');
    expect(sdl).toContain('Exactly one execution form');
    expect(sdl).toContain('Whole-list replacement is unsupported');
    expect(schema.getType('Occurrence')).toBeDefined();
    expect(schema.getType('OccurrenceIdentity')).toBeUndefined();
    expect(sdl).toContain('Do not derive from current scheduled time');
    expect(sdl).toContain('input RecurrenceMutationInput @oneOf');
    expect(sdl).toContain('input ProjectLinkInput @oneOf');
    expect(sdl).not.toContain('model: Model');
  });

  it('exposes primary artifact content as a nullable union with discoverable selection and authoring rules', () => {
    const data = introspection();
    const content = data.__schema.types.find(type => type.name === 'ArtifactContent')!;
    if (content.kind !== 'UNION') throw new Error('ArtifactContent must be a union');
    expect(content.possibleTypes.map(type => type.name)).toEqual(['MarkdownContent', 'Attachment']);
    const artifact = data.__schema.types.find(type => type.name === 'Artifact')!;
    if (artifact.kind !== 'OBJECT') throw new Error('Artifact must be an object');
    expect(artifact.fields.map(field => field.name)).toEqual(expect.arrayContaining(['content', 'attachments']));
    for (const name of ['body', 'files', 'contentFilename']) expect(artifact.fields.map(field => field.name)).not.toContain(name);
    const field = artifact.fields.find(field => field.name === 'content')!;
    expect(field.type).toEqual({kind: 'UNION', name: 'ArtifactContent', ofType: null});
    expect(field.description).toContain('exactly one indexed attachment');
    expect(field.description).toContain('no single primary content');
    expect(field.description).toContain('UpdateArtifactInput.body');
    for (const name of ['CreateArtifactInput', 'UpdateArtifactInput']) {
      const input = data.__schema.types.find(type => type.name === name)!;
      if (input.kind !== 'INPUT_OBJECT') throw new Error(`${name} must be an input object`);
      expect(input.inputFields.map(field => field.name)).toContain('body');
    }
  });

  it('shares the record contract through LinkTarget and keeps attachment relationships separate', () => {
    const schema = buildClientSchema(introspection());
    const target = schema.getType('LinkTarget') as any;
    expect(target.astNode?.kind ?? target.constructor.name).toBe('GraphQLInterfaceType');
    expect(schema.getPossibleTypes(target).map(type => type.name)).toEqual(['Entry', 'Project', 'Action', 'Artifact']);
    expect(Object.keys(target.getFields())).toEqual(expect.arrayContaining(['id', 'handle', 'created', 'description', 'filePath', 'links', 'backlinks', 'attachmentLinks']));
    const attachment = schema.getType('Attachment') as any;
    expect(Object.keys(attachment.getFields())).toEqual(['backlinks', 'filename', 'handle', 'filePath', 'error']);
    expect((schema.getType('Occurrence') as any).getFields().template.type.toString()).toBe('Action');
  });

  it('exposes action metadata directly, identifies projections within occurrence metadata, and retains the nullable selected-instance read', () => {
    const data = introspection();
    const field = (name: string, key: string) => {
      const type = data.__schema.types.find(type => type.name === name)!;
      const fields = type.kind === 'INPUT_OBJECT' ? type.inputFields : type.kind === 'OBJECT' ? type.fields : [];
      return fields.find(item => item.name === key)!;
    };
    for (const name of ['Project', 'Action', 'Artifact']) {
      const type = data.__schema.types.find(type => type.name === name)!;
      if (type.kind !== 'OBJECT') throw new Error(`${name} must be an object`);
      expect(type.fields.map(item => item.name)).not.toContain('frontMatter');
      expect(type.fields.map(item => item.name)).toEqual(expect.arrayContaining(['name', 'created']));
    }
    for (const name of ['ProjectFrontMatter', 'ActionFrontMatter', 'ArtifactFrontMatter', 'EntryMeta', 'PlanningAction', 'PlanningConnection']) {
      expect(data.__schema.types.map(type => type.name)).not.toContain(name);
    }
    const occurrence = field('Action', 'occurrence');
    expect(occurrence.type).toEqual({kind: 'OBJECT', name: 'Occurrence', ofType: null});
    expect(field('Occurrence', 'projected').type).toEqual({kind: 'NON_NULL', name: null, ofType: {kind: 'SCALAR', name: 'Boolean', ofType: null}});
    expect(field('Occurrence', 'projected').description).toContain('unsaved');
    expect(field('Occurrence', 'projected').description).toContain('never stored');
    expect(field('Entry', 'created').name).toBe('created');
    expect(field('Action', 'recurrence').name).toBe('recurrence');
    expect(field('ActionWhere', 'occurrence').name).toBe('occurrence');
    expect(field('Action', 'status').type).toEqual({kind: 'ENUM', name: 'ActionStatus', ofType: null});
    expect(field('Action', 'status').description).toMatch(/null/i);
    expect(field('ActionWhere', 'recurrenceExists').type).toEqual({kind: 'SCALAR', name: 'Boolean', ofType: null});
    expect(field('ActionWhere', 'recurrenceExists').description).toContain('dormant');
    expect(field('OccurrenceWhere', 'projected').name).toBe('projected');
    expect(field('OccurrenceWhere', 'template').name).toBe('template');
    expect(field('Action', 'artifacts').description).toContain('without adding persistent backlinks');
    const activeDescription = field('Query', 'activeInstance').description;
    expect(activeDescription).toContain('null');
    expect(activeDescription).toContain('settings');
    expect(activeDescription).toContain('instructions');
    expect(activeDescription).toContain('do not load records');
    const query = data.__schema.types.find(type => type.name === 'Query')!;
    if (query.kind !== 'OBJECT') throw new Error('Query must be an object');
    expect(query.fields.map(item => item.name)).not.toContain('instance');
    for (const name of ['SelectInstancePayload', 'CreateInstancePayload', 'InstancePayload']) {
      expect(field(name, 'instance').name).toBe('instance');
    }
    expect(query.fields.map(item => item.name)).not.toContain('planningActions');
    expect(field('CreateActionInput', 'duration').description).toContain('defaults to PT30M');
    expect(field('Action', 'duration').description).toContain('Absent duration defaults to PT30M');
    for (const name of ['UpdateActionInput', 'UpdateOccurrenceInput']) {
      const description = field(name, 'duration').description;
      expect(description).toContain('Omit to preserve the existing or inherited duration');
      expect(description).toContain('Null removes the stored value');
      expect(description).toContain('PT30M default');
      expect(description).toContain('All-day events span dates');
      expect(description).not.toContain('Omitted duration defaults');
    }
    expect(field('InstanceSettings', 'scheduledEventTitlePrefix').description).toContain('UpdateInstanceInput.settings');
    expect(field('Instance', 'body').description).toContain('UpdateInstanceInput.body');
    const instanceInput = data.__schema.types.find(type => type.name === 'UpdateInstanceInput')!;
    if (instanceInput.kind !== 'INPUT_OBJECT') throw new Error('UpdateInstanceInput must be an input object');
    expect(instanceInput.inputFields.map(item => item.name)).toEqual(expect.arrayContaining(['automations', 'settings', 'body']));
    for (const name of ['automationEdits', 'recurrenceLookaheadDays', 'scheduledEventTitlePrefix', 'doneEventTitlePrefix']) {
      expect(instanceInput.inputFields.map(item => item.name)).not.toContain(name);
    }
    expect(field('AutomationEditsInput', 'upsert').description).toContain('complete definitions');
    expect(field('AutomationEditsInput', 'patch').description).toContain('supplied fields');
    expect(field('UpdateAutomationInput', 'schedule').description).toContain('Cannot be null');
    expect(field('AutomationRunPatchInput', 'model').description).toContain('unavailable saved choice');
    expect(field('AutomationSchedulePatchInput', 'timezone').description).toContain('null removes');
    expect(field('UpdateInstanceInput', 'automations').description).toContain('preserve other jobs');
    expect(field('InstanceSettingsInput', 'doneEventTitlePrefix').description).toContain('null restores');
    expect(field('Instance', 'automationLog').description).toMatch(/retained/i);
    expect(field('Automation', 'running').description).toContain('unavailable');
    expect(field('Automation', 'log').description).toContain('owner');
    expect(field('AutomationRun', 'output').description).toContain('retained');
    expect(field('AutomationLogPage', 'nextOffset').description).toContain('Byte offset');
    const automation = data.__schema.types.find(type => type.name === 'Automation')!;
    if (automation.kind !== 'OBJECT') throw new Error('Automation must be an object');
    expect(automation.fields.map(item => item.name)).toEqual(['name', 'schedule', 'run', 'enabled', 'timeout', 'overlap', 'next', 'running', 'log']);
    for (const name of ['models', 'automationRuntime', 'automationLog']) expect(query.fields.map(item => item.name)).not.toContain(name);
    for (const name of ['Automations', 'AutomationRuntime', 'AutomationJobRuntime']) expect(data.__schema.types.map(type => type.name)).not.toContain(name);
  });
});
