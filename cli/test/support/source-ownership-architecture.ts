import ts from 'typescript';
import {dirname, posix} from 'node:path';

export interface SourceAccessSite {file: string; scope: string; operation: string; line: number}
export interface SourceAccessException {
  file: string;
  scope: string;
  operations: Readonly<Record<string, number>>;
  reason: string;
}

const sourceReaders: Record<string, ReadonlySet<string>> = {
  'core/instance': new Set(['isAsideDir', 'readInstanceRecordResult', 'readManifestResult', 'readManifest', 'shouldRetainKnownInstance', 'readConfig', 'instancePathError']),
  'core/reader': new Set(['readInstanceData', 'InstanceReadCache']),
  'core/managed-path': new Set(['readManagedText', 'createManagedReader', 'assertManagedPath']),
  'core/source-metadata': new Set(['readSourceMetadata']),
  'core/artifact': new Set(['listArtifactAttachments', 'collectArtifactReferenceSources']),
  'core/content-attachment': new Set(['contentAttachmentPath']),
  'core/attachment-metadata': new Set(['readAttachmentFiles', 'readReferenceRoots']),
  'core/validator': new Set(['validate']),
  'core/worktree': new Set(['canonicalPath', 'checkoutInfo', 'instanceFamily', 'primaryCounterpart', 'withPrimaryInstances', 'withoutInstanceFamilies']),
  'daemon/host': new Set(['instanceKey']),
  'source/index-file': new Set(['prependIndex', 'updateIndexDescription']),
  'storage/atomic-file': new Set(['writeFileCrashSafe']),
  'source/serialize-existing-record': new Set(['serializeExistingRecord']),
  'source/serialize': new Set(['serializeAction', 'serializeProject', 'serializeArtifact']),
  'mcp/tools/recurrence': new Set(['handleUpdateOccurrence']),
  'mcp/tools/update': new Set(['handleUpdateAction', 'handleUpdateProject', 'handleUpdateEntry']),
  'mcp/tools/capture': new Set(['handleCapture', 'resolveEntityRefs']),
  'mcp/tools/instance': new Set(['handleUpdateInstance']),
  'mcp/tools/artifact': new Set(['createArtifact', 'handleUpdateArtifact', 'prepareCreateArtifact']),
  'source/bootstrap': new Set(['init']),
  'source/recurrence-history': new Set(['recurrenceHistoryPath', 'readRecurrenceHistory', 'writeRecurrenceHistory']),
  'source/execution-context': new Set(['readExecutionContextSnapshot']),
  'automation/models': new Set(['readExecutionContext']),
  'daemon/instance-operations': new Set(['bootstrapInstanceSource', 'createInstanceSource']),
  'source/artifact-source': new Set(['prepareArtifactSource']),
  'source/instance-admission': new Set(['availableInstances', 'registrationPath']),
  'commands/daemon-status': new Set(['readOfflineDaemonInstances']),
};
interface Binding {module: string; member?: string}
interface DeclarationBinding {value?: Binding; initializer?: ts.Expression; member?: string}
const sourceMethods = new Set(['rebuild', 'watch', 'saveAction', 'saveProject', 'saveArtifact', 'saveEntry', 'saveInstance',
  'addIndexEntry', 'setIndexEntry', 'refreshArtifactAttachments', 'assertSourceIdentity', 'actionMatchesSource',
  'captureActionSourceGuard', 'prepareSourceMutation', 'assertMutationPaths', 'assertNewRecordPath', 'editInstance', 'prepareArtifactSource', 'prepareActionCreation']);
const lifecycleMethods = new Set(['setReconciliationOwner', 'requestFeatureReconcile']);
const methodOperation = (member: string): string | undefined => sourceMethods.has(member) ? `source.${member}`
  : lifecycleMethods.has(member) ? `lifecycle.${member}` : undefined;
const memberName = (name: ts.PropertyName | ts.BindingName | undefined): string | undefined => name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
const moduleName = (file: string, specifier: string): string => specifier.startsWith('.')
  ? posix.normalize(posix.join(dirname(file), specifier)).replace(/\.[cm]?[jt]s$/, '') : specifier.replace(/^node:/, '');

function enclosingScope(node: ts.Node): string {
  const names: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
      const name = memberName(current.name); if (name) names.unshift(name);
    } else if (ts.isConstructorDeclaration(current)) names.unshift('constructor');
    else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
        const name = memberName(parent.name); if (name) names.unshift(name);
      }
    }
  }
  return names.join('.') || '<module>';
}

/** A review gate, not a proof of path semantics. Runtime contracts enforce
 * which instance paths a permitted adapter actually touches. */
export function sourceAccessSites(file: string, text: string): SourceAccessSite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scopes = new Map<ts.Node, Map<string, DeclarationBinding>>();
  const isScope = (node: ts.Node) => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
    || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
  const scopeAt = (node: ts.Node): Map<string, DeclarationBinding> => {
    let current = node;
    while (!isScope(current) && current.parent) current = current.parent;
    let scope = scopes.get(current);
    if (!scope) {scope = new Map(); scopes.set(current, scope);}
    return scope;
  };
  const lookup = (node: ts.Node, name: string): DeclarationBinding | undefined => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      const scope = scopes.get(current);
      if (scope?.has(name)) return scope.get(name);
    }
  };
  const declare = (name: ts.BindingName, scope: Map<string, DeclarationBinding>, initializer?: ts.Expression) => {
    if (ts.isIdentifier(name)) {scope.set(name.text, {initializer}); return;}
    for (const element of name.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (ts.isIdentifier(element.name)) scope.set(element.name.text, {initializer,
        ...(ts.isObjectBindingPattern(name) ? {member: memberName(element.propertyName ?? element.name)} : {})});
      else declare(element.name, scope);
    }
  };
  const top = scopeAt(source);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = moduleName(file, statement.moduleSpecifier.text), clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause?.name) top.set(clause.name.text, {value: {module}});
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) top.set(named.name.text, {value: {module}});
      else if (named) for (const item of named.elements) if (!item.isTypeOnly) {
        const member = (item.propertyName ?? item.name).text;
        top.set(item.name.text, {value: module === 'fs' && member === 'promises' ? {module: 'fs/promises'} : {module, member}});
      }
    }
  }
  // Bind names by lexical scope, including nonprivileged declarations: a local
  // alias or parameter must never overwrite an unrelated imported reader.
  const declarations = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      let owner: ts.Node = node.parent;
      if (ts.isVariableDeclarationList(owner) && !(owner.flags & ts.NodeFlags.BlockScoped)) {
        while (!ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      }
      declare(node.name, scopeAt(owner), node.initializer);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      scopeAt(node.parent).set(node.name.text, {value: node.parent === source
        ? {module: file.replace(/\.[cm]?[jt]s$/, ''), member: node.name.text} : undefined});
    } else if (ts.isParameter(node)) declare(node.name, scopeAt(node.parent));
    ts.forEachChild(node, declarations);
  };
  declarations(source);
  const select = (object: Binding, member: string): Binding => object.module === 'fs' && member === 'promises' && !object.member
    ? {module: 'fs/promises'} : {module: object.module, member: object.member ? `${object.member}.${member}` : member};
  const resolve = (expression: ts.Expression, seen = new Set<DeclarationBinding>()): Binding | undefined => {
    if (ts.isIdentifier(expression)) {
      const declared = lookup(expression, expression.text);
      if (!declared || seen.has(declared)) return;
      if (declared.value) return declared.value;
      if (!declared.initializer) return;
      seen.add(declared);
      const binding = resolve(declared.initializer, seen);
      return binding && declared.member ? select(binding, declared.member) : binding;
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return resolve(expression.expression, seen);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const object = resolve(expression.expression, seen);
      const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      if (!object || !member) return;
      return select(object, member);
    }
    if (ts.isCallExpression(expression) && (expression.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(expression.expression) && expression.expression.text === 'require')) {
      const argument = expression.arguments[0];
      if (argument && ts.isStringLiteral(argument)) return {module: moduleName(file, argument.text)};
    }
  };
  const sites: SourceAccessSite[] = [];
  const readerOperation = (binding: Binding | undefined): string | undefined => {
    if (!binding?.member) return;
    const member = binding.member.replace(/(?:\.(?:bind|call|apply))+$/, '');
    return sourceReaders[binding.module]?.has(member) ? `${binding.module}.${member}` : undefined;
  };
  const addSite = (node: ts.Node, operation: string) => sites.push({file, scope: enclosingScope(node), operation,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1});
  const visit = (node: ts.Node) => {
    // Capturing a source method is privileged too: aliasing, binding, or passing
    // it as a callback must not hide the operation from the review gate.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (member && methodOperation(member) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        addSite(node, methodOperation(member)!);
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const member = memberName(node.propertyName ?? node.name);
      if (member && methodOperation(member)) addSite(node, methodOperation(member)!);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const binding = resolve(node.expression);
      let operation: string | undefined;
      if (binding && (binding.module === 'fs' || binding.module === 'fs/promises') && binding.member) operation = `${binding.module}.${binding.member}`;
      else if (binding?.module === 'chokidar') operation = 'source.watch';
      else if (readerOperation(binding)) operation = readerOperation(binding);
      else if (ts.isNewExpression(node) && binding?.module === 'source/store' && binding.member === 'Store') operation = 'Store.new';
      else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const member = ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
        if (member) operation = methodOperation(member);
      }
      if (operation) addSite(node, operation);
      for (const argument of node.arguments ?? []) {
        const callback = readerOperation(resolve(argument));
        if (callback) addSite(argument, callback);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

export function checkSourceAccess(sites: readonly SourceAccessSite[], exceptions: readonly SourceAccessException[]): string[] {
  const key = (file: string, scope: string, operation: string) => `${file}:${scope}:${operation}`;
  const allowed = new Map<string, number>(), errors: string[] = [];
  for (const exception of exceptions) {
    if (!exception.reason.trim()) errors.push(`Missing ownership exception reason: ${exception.file}:${exception.scope}`);
    for (const [operation, count] of Object.entries(exception.operations)) {
      const name = key(exception.file, exception.scope, operation);
      if (allowed.has(name)) errors.push(`Duplicate ownership exception: ${name}`);
      if (!Number.isSafeInteger(count) || count <= 0) errors.push(`Invalid ownership exception count: ${name}`);
      allowed.set(name, count);
    }
  }
  const actual = new Map<string, SourceAccessSite[]>();
  for (const site of sites) {
    const name = key(site.file, site.scope, site.operation);
    actual.set(name, [...actual.get(name) ?? [], site]);
  }
  for (const [name, locations] of actual) {
    const count = allowed.get(name) ?? 0;
    if (locations.length > count) errors.push(`Unapproved source access (${locations.length}, approved ${count}): ${name} at line(s) ${locations.map(site => site.line).join(', ')}`);
    else if (locations.length < count) errors.push(`Stale ownership exception (${count}, present ${locations.length}): ${name}`);
    allowed.delete(name);
  }
  for (const name of allowed.keys()) errors.push(`Stale ownership exception (no access remains): ${name}`);
  return errors.sort();
}
