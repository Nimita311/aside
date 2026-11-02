// Optional browser execution against a static file host. The daemon UI uses
// RemoteStore; importing this entry point deliberately includes the data core.
export { DataCore as Store, ENTITY_KINDS } from '../../cli/src/core/data-core';
export type { StoreView, Relations, EntityKind, EntityRecord, InstanceRecord, SearchProgress, FileDiagnostic, CheckScope, HotSet, UpdateSummary, PendingUpdate } from '../../cli/src/core/data-snapshot';
