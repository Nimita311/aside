import { isMap, isNode, isScalar, parseDocument } from 'yaml';
import { Store } from '../../source/store.js';
import { assertAutomationDeclarations } from '../../automation/declaration.js';
import type { AutomationDeclarations } from '../../core/automation.js';
import {assertWebappSettings} from '../../core/webapp-config.js';
import type {WebappConfig} from '../../core/types.js';
import { mergeMetadata, type MetadataField } from '../../core/metadata.js';
import { applyAutomationEditsToMetadata, assertAutomationEdits, type AutomationEdits } from '../../core/automation-edits.js';
import { trackMutation } from '../../source/mutation-result.js';

export interface UpdateInstanceArgs {
  webapp?: WebappConfig;
  automations?: AutomationDeclarations | null;
  automationEdits?: AutomationEdits | null;
  body?: string;
  scheduledEventTitlePrefix?: string | null;
  doneEventTitlePrefix?: string | null;
}

export function handleUpdateInstance(store: Store, args: UpdateInstanceArgs): void {
  trackMutation(store, () => updateInstance(store, args));
}
function updateInstance(store: Store, args: UpdateInstanceArgs): void {
  if (Object.values(args).some(value => value !== undefined)) {
    if (args.automations !== undefined && args.automationEdits != null) throw new Error('Use either automations or automationEdits, not both.');
    const automations = args.automations == null ? undefined : assertAutomationDeclarations(args.automations);
    const edits = args.automationEdits == null ? undefined : assertAutomationEdits(args.automationEdits);
    const webapp = args.webapp === undefined ? undefined : assertWebappSettings(args.webapp);
    if (args.body !== undefined && typeof args.body !== 'string') throw new Error('body must be text; omit to preserve instructions or use an empty string to clear them.');
    for (const key of ['scheduledEventTitlePrefix', 'doneEventTitlePrefix'] as const) {
      if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') throw new Error(`${key} must be text or null.`);
    }
    store.editInstance(Object.keys(args).filter(key => args[key as keyof UpdateInstanceArgs] !== undefined), original => {
      const match = original.match(/^(\uFEFF?\s*---[ \t\r]*\n)(?:([\s\S]*?)\n)?(---[ \t\r]*)(\n[\s\S]*)?$/);
      if (!match) throw new Error('Cannot update instance: aside.md must have YAML front matter.');
      const source = (match[2] ?? '').replace(/\r(?=\n|$)/g, '');
      const document = parseDocument(source, { intAsBigInt: true });
      if (document.errors.length || !isMap(document.contents)) throw new Error('Cannot update instance: invalid manifest YAML.');
      try { document.toJS({ mapAsMap: true }); }
      catch { throw new Error('Cannot update instance: existing YAML aliases cannot be resolved. Repair them before retrying.'); }
      const desired = parseDocument('{}');
      const fields: MetadataField[] = [];
      if (args.automations !== undefined) {
        if (automations && Object.keys(automations).length) desired.set('automations', automations);
        fields.push('automations');
      }
      const configKeys = ['scheduledEventTitlePrefix', 'doneEventTitlePrefix'] as const;
      if (configKeys.some(key => args[key] !== undefined) || webapp?.sidebar !== undefined) {
        const configPairs = document.contents.items.filter(pair => (isNode(pair.key) ? pair.key.toJS(document, { mapAsMap: true }) : pair.key) === 'config');
        if (configPairs.length > 1) throw new Error('Cannot update instance: existing metadata repeats config after resolving YAML aliases. Repair the duplicate field before retrying.');
        const currentConfig = configPairs[0]?.value;
        const replaceConfig = isScalar(currentConfig) && currentConfig.value === null;
        if (currentConfig == null || replaceConfig) desired.set('config', desired.createNode({}));
        else if (!isMap(currentConfig)) throw new Error('Cannot update instance: config must be a YAML mapping. Resolve aliased or malformed config before retrying.');
        for (const key of configKeys) {
          if (args[key] === undefined) continue;
          if (args[key] !== null) desired.setIn(['config', key], args[key]);
          if (!replaceConfig) fields.push(['config', key]);
        }
        if (webapp?.sidebar !== undefined) {
          const currentWebapp = isMap(currentConfig) ? currentConfig.get('webapp', true) : undefined;
          const replaceWebapp = isScalar(currentWebapp) && currentWebapp.value === null;
          if (currentWebapp != null && !replaceWebapp && !isMap(currentWebapp)) throw new Error('Cannot update instance: config.webapp must be a YAML mapping. Resolve aliased or malformed settings before retrying.');
          desired.setIn(['config', 'webapp', 'sidebar'], webapp.sidebar);
          if (!replaceConfig) fields.push(replaceWebapp ? ['config', 'webapp'] : ['config', 'webapp', 'sidebar']);
        }
        if (replaceConfig) fields.push('config');
      }
      const newline = match[1].endsWith('\r\n') ? '\r\n' : '\n';
      // Merge each owned field through the original YAML so aliases elsewhere
      // retain their prior values, rather than inheriting edits to shared anchors.
      let yaml = fields.length ? mergeMetadata(source, desired.toString(), fields, 'instance') : source;
      if (edits) yaml = applyAutomationEditsToMetadata(yaml, edits, 'instance');
      // A body-only edit keeps the original metadata bytes, including its fence
      // separator. YAML edits preserve significant trailing block-scalar space.
      const metadata = fields.length || edits ? `${yaml.replace(/\n/g, newline)}${newline}` : match[2] === undefined ? '' : `${match[2]}\n`;
      const tail = args.body === undefined ? match[4] ?? '' : `${newline}${newline}${args.body.trim().replace(/\r\n|\r|\n/g, newline)}${args.body.trim() ? newline : ''}`;
      const closing = args.body === undefined ? match[3] : match[3].replace(/\r$/, '');
      const serialized = `${match[1]}${metadata}${closing}${tail}`;
      return serialized;
    });
  }
}
