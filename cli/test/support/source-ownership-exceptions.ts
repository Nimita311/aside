import type {SourceAccessException} from './source-ownership-architecture.js';

// These are reviewed operations, not file-wide exemptions. Exact scopes and
// counts make added access require a fresh reason even inside an I/O adapter.
function permit(file: string, reason: string, scopes: Record<string, Record<string, number>>): SourceAccessException[] {
  return Object.entries(scopes).map(([scope, operations]) => ({file, scope, operations, reason}));
}

export const SOURCE_ACCESS_EXCEPTIONS: SourceAccessException[] = [
  ...permit('commands/artifact.ts', 'Validate the explicitly selected root before sending the artifact operation to the daemon; record queries use owner state.', {
    runArtifact: {'core/instance.isAsideDir': 1},
  }),
  ...permit('commands/graphql.ts', 'Read stdin and explicitly selected GraphQL document/variable payload files before daemon execution.', {
    runGraphQL: {'fs.readFileSync': 1},
    'runGraphQL.read': {'fs.readFileSync': 1},
  }),
  ...permit('commands/diagnostics.ts', 'Canonicalize the explicitly selected instance before asking its daemon to remove private diagnostics.', {
    runDiagnostics: {'daemon/host.instanceKey': 1},
  }),
  ...permit('commands/init.ts', 'Bootstrap a new instance only after both daemon locks prove there is no lifecycle owner; live initialization uses owner RPC.', {
    bootstrap: {'source/bootstrap.init': 1},
  }),
  ...permit('commands/instance-gc.ts', 'Check the private registry file only after no daemon is available; offline collection takes the daemon locks.', {
    collectAfterFailedUse: {'fs.existsSync': 1},
  }),
  ...permit('commands/mcp.ts', 'Initial workspace discovery and admission inspect config pointers and manifests before a daemon session exists.', {
    unique: {'daemon/host.instanceKey': 1},
    discoverDirs: {'fs.readdirSync': 1, 'core/instance.isAsideDir': 2},
    resolveDataDir: {'core/instance.readConfig': 1, 'core/instance.isAsideDir': 5, 'daemon/host.instanceKey': 3},
  }),
  ...permit('commands/plugin.ts', 'Explicit installation/status operations inspect external agent configuration, installed plugin packages, and executable/build assets.', {
    onPath: {'fs.accessSync': 1, 'fs.statSync': 1},
    findAgent: {'fs.existsSync': 1},
    checkoutRoot: {'fs.existsSync': 1},
    'samePath.real': {'fs.realpathSync': 1},
    pluginNames: {'fs.readFileSync': 1},
    claudeState: {'fs.existsSync': 1},
    scopedEnabled: {'fs.readFileSync': 1},
    claudeRestorePlan: {'fs.existsSync': 1, 'fs.statSync': 1},
    'claudeRestorePlan.scopeKey': {'fs.realpathSync': 1},
    'claudeRestorePlan.owned': {'fs.existsSync': 1, 'fs.statSync': 1},
    codexNames: {'fs.readFileSync': 1},
    tree: {'fs.readdirSync': 1, 'fs.statSync': 1, 'fs.readFileSync': 1},
    pathCheckout: {'fs.realpathSync': 1, 'fs.existsSync': 1},
    reportBuilds: {'fs.existsSync': 2},
  }),
  ...permit('commands/usage.ts', 'Explicit offline inspection reads private usage logs and canonicalizes its selected root; no authored records are loaded.', {
    summarizeUsage: {'fs/promises.lstat': 1, 'fs/promises.readdir': 1, 'fs/promises.open': 1},
    runUsage: {'core/instance.isAsideDir': 1, 'fs.realpathSync': 1},
  }),
  ...permit('commands/validate.ts', 'Explicit validation checks raw saved files so it can diagnose defects hidden by best-effort loaded state.', {
    runValidate: {'core/validator.validate': 1},
  }),
  ...permit('commands/daemon-status.ts', 'Explicit offline diagnostics inspect saved registrations only when no live daemon catalogue is available.', {
    readOfflineDaemonInstances: {'source/instance-admission.availableInstances': 1, 'core/instance.isAsideDir': 1},
  }),
  ...permit('commands/daemon.ts', 'Inspect machine login/lock files and invoke the explicit offline catalogue adapter only without a running daemon.', {
    status: {'commands/daemon-status.readOfflineDaemonInstances': 1, 'fs.existsSync': 1},
    unavailableDaemon: {'fs.existsSync': 1},
  }),
  ...permit('commands/instance.ts', 'Stopped-daemon registry administration holds the start/lifetime locks; live operations use daemon receipts and catalogue.', {
    editKnown: {'core/instance.isAsideDir': 1, 'core/instance.shouldRetainKnownInstance': 1,
      'core/worktree.withPrimaryInstances': 1, 'core/worktree.withoutInstanceFamilies': 1, 'daemon/host.instanceKey': 8},
    readOfflineInstanceCatalogue: {'source/instance-admission.availableInstances': 1, 'core/instance.readManifestResult': 1},
    collectOfflineCaches: {'fs.existsSync': 1, 'fs.readFileSync': 1, 'daemon/host.instanceKey': 1},
    list: {'fs.existsSync': 1},
  }),
  ...permit('mcp/instance-registry.ts', 'Canonicalize only initial session admission; owner-provided selection uses restore/activateAdmitted without filesystem probes.', {
    'InstanceRegistry.constructor': {'daemon/host.instanceKey': 1},
    'InstanceRegistry.activate': {'daemon/host.instanceKey': 1},
  }),
  ...permit('automation/controller.ts', 'Inspect private saved runs when no worker is running.', {
    'AutomationController.inspect': {'fs.existsSync': 1},
  }),
  ...permit('runtime/execution-cwd.ts', 'Validate the actual working directory immediately before process launch or model discovery.', {
    assertExecutionCwd: {'fs.statSync': 1},
  }),
  ...permit('automation/execution.ts', 'Write private bounded process output, not authored instance records.', {
    'AutomationRunner.execute.output': {'fs.createWriteStream': 1},
  }),
  ...permit('automation/models.ts', 'Inspect external executables/vendor settings and persist the private discovered-model cache.', {
    executablePath: {'fs.statSync': 1, 'fs.accessSync': 1},
    readSaved: {'fs.statSync': 1, 'fs.readFileSync': 1},
    save: {'fs.mkdirSync': 1, 'fs.writeFileSync': 1, 'fs.renameSync': 1, 'fs.unlinkSync': 1},
    mergeSaved: {'fs.mkdirSync': 1},
    fileStamp: {'fs.statSync': 1, 'fs.realpathSync': 1},
  }),
  ...permit('automation/storage.ts', 'Only private automation claims, run records, history, and output directories.', {
    'RunStorage.lastClaim': {'fs.readFileSync': 1},
    'RunStorage.claim': {'fs.mkdirSync': 1, 'storage/atomic-file.writeFileCrashSafe': 1},
    'RunStorage.start': {'fs.mkdirSync': 1},
    'RunStorage.save': {'storage/atomic-file.writeFileCrashSafe': 1},
    'RunStorage.history': {'fs.readFileSync': 1},
    'RunStorage.removeCompleted': {'core/managed-path.readManagedText': 1, 'fs.unlinkSync': 1},
    'RunStorage.ordinaryDirectory': {'fs.lstatSync': 1},
    'RunStorage.ordinaryFile': {'fs.lstatSync': 1},
    'RunStorage.removeEmpty': {'fs.readdirSync': 1, 'fs.rmdirSync': 1},
    'RunStorage.subdirs': {'fs.readdirSync': 1},
  }),
  ...permit('automation/worker.ts', 'Check availability of the external macOS wake helper at worker startup.', {
    '<module>': {'fs.existsSync': 1},
  }),
  ...permit('graphql/automation-prompts.ts', 'Read explicitly selected import/attachment bytes with size, UTF-8, regular-file, and containment guards; authored bodies use Store.', {
    inlinePrompt: {'fs.openSync': 1, 'fs.fstatSync': 1, 'fs.readFileSync': 1, 'fs.closeSync': 1},
    loadedPrompt: {'core/content-attachment.contentAttachmentPath': 1, 'fs.openSync': 1, 'fs.fstatSync': 1, 'fs.readFileSync': 1, 'fs.closeSync': 1},
  }),
  ...permit('graphql/automation-prompts.ts', 'Preflight prompt creation before the owner mutation; the returned commit runs inside the same tracked mutation.', {
    prepareAutomationPrompts: {'mcp/tools/artifact.prepareCreateArtifact': 1},
  }),
  ...permit('graphql/automation-runtime.ts', 'Read bounded private run logs through a verified descriptor.', {
    readAutomationLog: {'fs.openSync': 1, 'fs.fstatSync': 1, 'fs.readSync': 1, 'fs.closeSync': 1},
  }),
  ...permit('graphql/schema.ts', 'Explicit validation intentionally inspects raw saved files rather than a loaded snapshot.', {
    'executeGraphQLImpl.fieldResolver': {'core/validator.validate': 1},
  }),
  ...permit('graphql/system-daemon.ts', 'Inspect the machine-level saved daemon login job.', {
    collectSystemDaemon: {'fs.existsSync': 1},
  }),
  ...permit('graphql/system-installation.ts', 'Explicit bounded inspection of installed program/plugin files, not instance content.', {
    'boundedTree.visit': {'fs.realpathSync': 1, 'fs.opendirSync': 1, 'fs.statSync': 1, 'fs.openSync': 1, 'fs.fstatSync': 1, 'fs.readSync': 1, 'fs.closeSync': 1},
  }),
  ...permit('graphql/usage.ts', 'Maintain private daemon usage logs; canonical paths and identity come from the lifecycle owner.', {
    'GraphQLUsageLog.directory': {'fs/promises.lstat': 1},
    'GraphQLUsageLog.maintain': {'fs/promises.readdir': 2, 'fs/promises.lstat': 2, 'fs/promises.unlink': 1, 'fs/promises.rmdir': 1},
    'GraphQLUsageLog.prune': {'fs/promises.readdir': 1, 'fs/promises.lstat': 1, 'fs/promises.unlink': 2},
    'GraphQLUsageLog.append': {'fs/promises.mkdir': 2, 'fs/promises.chmod': 2, 'fs/promises.open': 2},
  }),
  ...permit('web/locate.ts', 'Locate installed static app assets.', {
    resolveAppDir: {'fs.existsSync': 2},
  }),
  ...permit('web/server.ts', 'Serve explicitly requested static/attachment bytes; authored JSON uses published Store state.', {
    tryFile: {'fs/promises.readFile': 1, 'core/managed-path.assertManagedPath': 1, 'fs/promises.open': 1},
    'AsideWebServer.handle': {'fs/promises.realpath': 1},
  }),
  ...permit('web/server.ts', 'Watch raw asset/attachment bytes for targeted browser invalidation; authored source and .aside events wait for lifecycle publication.', {
    'AsideWebServer.streamWatch': {'fs.watch': 1},
  }),
  ...permit('semantic/cache-retention.ts', 'Only private semantic-cache registration markers and unregistered cache removal.', {
    'SemanticCacheRetention.register': {'fs/promises.rm': 1},
    'SemanticCacheRetention.collect': {'fs/promises.readdir': 1, 'fs/promises.rm': 1},
    'SemanticCacheRetention.directoryExists': {'fs/promises.lstat': 1},
    'SemanticCacheRetention.state': {'fs/promises.lstat': 1, 'fs/promises.readFile': 1},
    'SemanticCacheRetention.write': {'fs/promises.writeFile': 1, 'fs/promises.rename': 1, 'fs/promises.rm': 1},
    'SemanticCacheRetention.remove': {'fs/promises.readdir': 1, 'fs/promises.rm': 2, 'fs/promises.rmdir': 1},
  }),
  ...permit('semantic/search.ts', 'Only derived semantic database generations, maintenance markers, and certificates; no authored source reads.', {
    'SemanticSearchService.openLocation': {'fs/promises.mkdir': 1},
    'SemanticSearchService.generationLocations': {'fs/promises.readdir': 1, 'fs/promises.rm': 1},
    'SemanticSearchService.removeGeneration': {'fs/promises.rename': 1, 'fs/promises.rm': 1},
    'SemanticSearchService.prepareMutation': {'fs/promises.rm': 2},
    'SemanticSearchService.cleanVersion': {'fs/promises.readFile': 1},
    'SemanticSearchService.certificate': {'fs/promises.readFile': 1},
    'SemanticSearchService.maintain': {'storage/atomic-file.writeFileCrashSafe': 1},
    'SemanticSearchService.synchronized.finish': {'storage/atomic-file.writeFileCrashSafe': 1},
  }),
  ...permit('mcp/calendar/client.ts', 'Discover the external Calendar helper executable.', {
    'CalClient.constructor': {'fs.existsSync': 1},
  }),
  ...permit('mcp/geocoding.ts', 'Check the external native geocoding executable before a bounded subprocess request; no authored instance source is inspected.', {
    runHelper: {'fs.existsSync': 1},
  }),
  ...permit('mcp/calendar/recurrence-state.ts', 'Load the private accepted Calendar recurrence mirror.', {
    'RecurrenceMirror.constructor': {'fs.mkdirSync': 1, 'fs.readFileSync': 1},
    'RecurrenceMirror.save': {'storage/atomic-file.writeFileCrashSafe': 1},
  }),
  ...permit('mcp/calendar/recurrence-sync.ts', 'Request owner-provided source guards around external Calendar side effects; the source owner performs comparisons.', {
    'RecurrenceCalSync.sync': {'source.captureActionSourceGuard': 2},
    'RecurrenceCalSync.syncFamily': {'source.captureActionSourceGuard': 2},
    'RecurrenceCalSync.syncFamily.refreshExceptionSources': {'source.captureActionSourceGuard': 1},
  }),
  ...permit('mcp/calendar/recurrence-sync.ts', 'The callback is executed by the injected lifecycle mutation owner in managed instances.', {
    'RecurrenceCalSync.updateOccurrence.write': {'mcp/tools/recurrence.handleUpdateOccurrence': 1},
  }),
  ...permit('mcp/calendar/sync.ts', 'Ask the source owner to guard external Calendar writes and reverse imports; status uses published state.', {
    'CalSync.requireIdentity': {'source.assertSourceIdentity': 1},
    'CalSync.freshOnDisk': {'source.actionMatchesSource': 1},
    'CalSync.writeAction.write': {'source.saveAction': 1},
  }),
  ...permit('mcp/tools/artifact.ts', 'Request a prepared source mutation from Store and persist confirmed artifact effects through lifecycle.', {
    createArtifact: {'mcp/tools/artifact.prepareCreateArtifact': 1},
    prepareCreateArtifact: {'source.prepareArtifactSource': 1},
    'prepareCreateArtifact.commit': {'source.saveArtifact': 1, 'source.addIndexEntry': 1},
    updateArtifact: {'source.prepareArtifactSource': 1, 'source.saveArtifact': 1, 'source.refreshArtifactAttachments': 1, 'source.setIndexEntry': 1},
  }),
  ...permit('mcp/tools/capture.ts', 'Capture persistence preflight checks current paths/collisions and merges the selected weekly file; Store writes report confirmed effects through lifecycle.', {
    rejectIdCollisions: {'source.assertMutationPaths': 1, 'source.assertNewRecordPath': 1},
    resolveRefs: {'source.saveProject': 1, 'source.saveAction': 1, 'source.addIndexEntry': 2},
    capture: {'source.assertMutationPaths': 1, 'source.saveEntry': 1, 'source.addIndexEntry': 1, 'mcp/tools/capture.resolveEntityRefs': 1},
  }),
  ...permit('mcp/tools/content-source.ts', 'Read an explicitly supplied Markdown import through a regular-file/UTF-8/size checked descriptor.', {
    resolveMarkdownSource: {'fs.openSync': 1, 'fs.fstatSync': 1, 'fs.readFileSync': 1, 'fs.closeSync': 1},
  }),
  ...permit('mcp/tools/instance.ts', 'Supply a pure manifest merge to Store; the source owner reads and persists under lifecycle tracking.', {
    updateInstance: {'source.editInstance': 1},
  }),
  ...permit('mcp/tools/recurrence.ts', 'Occurrence mutation preflight and Store persistence.', {
    updateOccurrence: {'source.prepareActionCreation': 1, 'source.saveAction': 1, 'source.addIndexEntry': 1, 'mcp/tools/update.handleUpdateAction': 1},
  }),
  ...permit('mcp/tools/show.ts', 'Validate explicitly requested raw attachment and reader-source file presentation, including containment and type.', {
    buildShowRoute: {'core/content-attachment.contentAttachmentPath': 2, 'core/managed-path.assertManagedPath': 1, 'fs.realpathSync': 2, 'fs.statSync': 1},
  }),
  ...permit('mcp/tools/update.ts', 'Mutation path preflight and persistence; weekly-file reads preserve concurrent content outside the edited entry.', {
    assertUpdatePaths: {'source.assertMutationPaths': 2},
    descriptionWarning: {'source.setIndexEntry': 1},
    updateAction: {'source.saveAction': 1},
    updateProject: {'source.saveProject': 1},
    updateEntry: {'source.prepareSourceMutation': 1, 'source.saveEntry': 1, 'mcp/tools/capture.resolveEntityRefs': 1},
  }),
];
