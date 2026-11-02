import { readManagedText } from '../../core/managed-path.js';
import { assertRecurrence, CompiledRecurrence, occurrenceKey, projectedAction, type OccurrenceIdentity } from '../../core/recurrence.js';
import { isRepeatedSchedule, scheduleInstant, schedulingIssues, wallTimeAt } from '../../core/scheduling.js';
import { handleUpdateOccurrence } from '../tools/recurrence.js';
import { nativeSeries, type NativeSeries } from './recurrence-rule.js';
import { canReplaceEventTime, eventTimingDiagnostic } from './timing.js';
import { RecurrenceMirror, type FamilyMirror } from './recurrence-state.js';
import { parseMarker, buildMarker } from './markers.js';
import { desiredFromAction, importFromEvent, type SyncResult } from './sync.js';
import type { CalClient } from './client.js';
import type { CalCalendar, CalEvent, NativeRecurrenceRule } from './protocol.js';
import type { Store } from '../store.js';
import type { Action } from '../../core/types.js';

function marker(instance: string, template: string, key: string) { return `aside://${instance}/series/${encodeURIComponent(template)}/${key}`; }
function state(url: string) { return parseMarker(url.replace(/\/series\/[^/]+\/[a-f0-9]{16}/, '/action/occurrence'))?.state ?? 'active'; }
function normalizeRule(rule: NativeRecurrenceRule, anchor: string): string {
  const value = structuredClone(rule), date = new Date(anchor.length === 10 ? anchor + 'T00:00Z' : anchor + ':00Z');
  if (value.frequency === 'weekly' && !value.days) value.days = [{ day: date.getUTCDay() + 1, week: 0 }];
  if (value.frequency === 'monthly' && !value.days && !value.monthDays) value.monthDays = [date.getUTCDate()];
  if (value.frequency === 'yearly' && !value.months && !value.yearDays && !value.weeks) value.months = [date.getUTCMonth() + 1];
  return JSON.stringify(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, Array.isArray(v) ? [...v].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v]));
}
interface Observed { event: CalEvent; identity: OccurrenceIdentity; source?: string }
function startDefinition(action: Action): string {
  const fm = action.frontMatter;
  return JSON.stringify([fm.scheduled ?? null, fm.scheduled?.includes('T') ? fm.timezone ?? null : null]);
}
function eventOccurrence(rule: CompiledRecurrence, template: string, event: CalEvent) {
  const original = event.originalInstant !== undefined ? rule.schedule.timezone ? new Date(event.originalInstant).toISOString().replace('.000Z','Z') : rule.allDay ? event.originalLocal?.slice(0,10) : event.originalLocal : undefined;
  let occurrence = rule.contains(template, original ?? event.original ?? (rule.schedule.timezone ? new Date(event.startInstant).toISOString().replace('.000Z','Z') : event.allDay ? event.start.slice(0,10) : event.start));
  if (!occurrence && event.original) {
    const authored = rule.contains(template, event.original);
    if (authored && (event.originalInstant === undefined || scheduleInstant(authored.scheduled, rule.schedule.timezone) === event.originalInstant)) occurrence = authored;
  }
  // A floating clock in a local gap is normalized by Calendar. Recover the
  // authored slot only when it resolves to the exact original native instant.
  if (!occurrence && !rule.schedule.timezone && !rule.allDay && event.originalInstant !== undefined) {
    const authored = rule.previous(template, wallTimeAt(event.originalInstant));
    if (authored && scheduleInstant(authored.scheduled) === event.originalInstant) occurrence = authored;
  }
  return occurrence;
}

// Runs within CalSync's authorization, identity, and data-dir lock gates.
export class RecurrenceCalSync {
  private mirror?: RecurrenceMirror;
  private mirrorIdentity?: string;
  private timeBlocked = new Map<string, string>();
  private checkedOrdinary = new Set<string>();
  reset(): void { this.mirror = undefined; this.mirrorIdentity = undefined; this.timeBlocked.clear(); this.checkedOrdinary.clear(); }
  constructor(private cal: CalClient) {}
  pendingOrdinary(): string[] { return [...this.mirror?.pendingOrdinary ?? []]; }
  ordinaryEvent(id: string): string | undefined { return this.mirror?.ordinaryEvents.get(id); }
  isOrdinaryPending(id: string): boolean { return this.mirror?.pendingOrdinary.has(id) ?? false; }
  beginOrdinary(id: string): void { this.checkedOrdinary.delete(id); }
  hasOwnedOccurrence(template: string, original: string): boolean {
    return [...this.mirror?.families.values() ?? []].some(previous => previous.template === template &&
      (new CompiledRecurrence(previous.family.schedule).contains(template, original) ||
        previous.observed.some(value => value.identity.original === original && !!value.event.id)));
  }
  rememberOrdinary(store: Store, instance: string, id: string, eventId: string, scheduled?: string): void {
    this.state(store, instance);
    this.acknowledgeOrdinary(id, eventId, scheduled);
  }
  rememberOrdinaryStart(store: Store, instance: string, id: string, scheduled: string): void {
    const mirror = this.state(store, instance), previous = mirror.ordinaryStarts.get(id);
    if (previous === scheduled) return;
    mirror.ordinaryStarts.set(id, scheduled);
    try { mirror.save(); }
    catch (error) {
      if (previous) mirror.ordinaryStarts.set(id, previous); else mirror.ordinaryStarts.delete(id);
      throw error;
    }
  }
  acknowledgeOrdinary(id: string, eventId?: string, scheduled?: string): void {
    const mirror = this.mirror;
    if (!mirror) return;
    const pending = mirror.pendingOrdinary.delete(id), previous = mirror.ordinaryEvents.get(id), previousStart = mirror.ordinaryStarts.get(id);
    this.checkedOrdinary.delete(id);
    if (eventId) {
      mirror.ordinaryEvents.set(id, eventId);
      if (scheduled) mirror.ordinaryStarts.set(id, scheduled);
    } else {
      mirror.ordinaryEvents.delete(id); mirror.ordinaryStarts.delete(id);
    }
    if (!pending && previous === eventId && previousStart === mirror.ordinaryStarts.get(id)) return;
    try { mirror.save(); }
    catch (error) {
      if (pending) mirror.pendingOrdinary.add(id);
      if (previous) mirror.ordinaryEvents.set(id, previous); else mirror.ordinaryEvents.delete(id);
      if (previousStart) mirror.ordinaryStarts.set(id, previousStart); else mirror.ordinaryStarts.delete(id);
      throw error;
    }
  }
  private state(store: Store, instance: string): RecurrenceMirror {
    const identity = JSON.stringify([store.getDataDir(), instance]);
    if (this.mirrorIdentity !== identity) {
      this.checkedOrdinary.clear();
      this.mirror = new RecurrenceMirror(store.getDataDir(), instance);
      this.mirrorIdentity = identity;
    }
    return this.mirror!;
  }
  private async fetch(base: string, mirror: FamilyMirror, guard: () => void): Promise<CalEvent[]> {
    const { events } = await this.cal.getSeries({ marker: base, start: mirror.family.schedule.dtstart, timezone: mirror.family.schedule.timezone,
      allDay: mirror.family.schedule.dtstart.length === 10, eventId: mirror.eventId, externalId: mirror.externalId,
      occurrences: mirror.observed.map(o => ({ original: o.identity.original, timezone: o.identity.timezone, eventId: o.event.id, start: o.event.start })) });
    guard();
    return events.filter(e => e.url === base || e.url.startsWith(base + '/'));
  }
  private async prune(mirror: RecurrenceMirror, base: string, guard: () => void): Promise<void> {
    const previous = mirror.families.get(base)!;
    const events = await this.fetch(base, previous, guard);
    const roots = events.filter(e => !e.detached && (e.seriesHead || !events.some(v => v.seriesHead)));
    for (const event of roots.sort((a,b) => a.startInstant - b.startInstant)) { guard(); await this.cal.deleteSeries({ eventId: event.id, marker: base }); guard(); }
    // A wholly detached family can outlive its root; removing every stored item
    // is safe because native writes re-fetch and re-check marker ownership.
    const remaining = roots.length ? await this.fetch(base, previous, guard) : events;
    if (remaining.some(event => !event.detached)) throw new Error('Native Calendar family removal was not confirmed; ordinary handoff is pending.');
    for (const event of remaining.filter(event => event.detached)) { guard(); await this.cal.upsertOccurrence({ calendar: event.calendar, calendar_account: event.calendar_account,
      marker: base, title: event.title, start: event.start, end: event.end, timezone: event.timezone ?? undefined,
      durationMinutes: event.durationMinutes, allDay: event.allDay, original: event.original ?? previous.observed.find(o => o.event.id === event.id)?.identity.original ?? '',
      originalTimezone: previous.family.schedule.timezone, originalAllDay: previous.family.schedule.dtstart.length === 10,
      anchor: previous.family.schedule.dtstart, eventId: event.id, remove: true }); guard(); }
    if (remaining.length && (await this.fetch(base, previous, guard)).length) throw new Error('Detached Calendar family removal was not confirmed; ordinary handoff is pending.');
    mirror.families.delete(base);
    try { mirror.save(); } catch (error) { mirror.families.set(base, previous); throw error; }
  }
  private async retireOrdinary(mirror: RecurrenceMirror, instance: string, id: string, action: Action, guard: () => void): Promise<void> {
    const hint = mirror.ordinaryEvents.get(id);
    if (!hint && !mirror.pendingOrdinary.has(id) && this.checkedOrdinary.has(id)) return;
    const provenance = action.frontMatter.occurrence;
    if (provenance && !hint && !mirror.pendingNative.has(id) && !mirror.pendingOrdinary.has(id) && [...mirror.families.values()].some(previous => previous.template === provenance.template &&
      new CompiledRecurrence(previous.family.schedule).contains(provenance.template, provenance.original))) {
      this.checkedOrdinary.add(id); return;
    }
    let copies: CalEvent[] = [];
    if (hint) {
      const { events } = await this.cal.getEvents({ eventIds: [hint] }); guard();
      const event = events.find(event => event.id === hint), ownership = event && parseMarker(event.url);
      if (event && (ownership?.instance !== instance || ownership.actionId !== id)) throw new Error('Ordinary Calendar copy is no longer owned; preserve it until the native handoff is repaired.');
      if (event) copies = [event];
    }
    if (!copies.length) {
      const start = mirror.ordinaryStarts.get(id) ?? action.frontMatter.scheduled ?? (provenance ? provenance.original.endsWith('Z') ? wallTimeAt(Date.parse(provenance.original), provenance.timezone) : provenance.original : undefined);
      if (!start) throw new Error('The prior ordinary Calendar copy is unavailable and its start is unknown; preserve the template until its handoff is repaired.');
      const date = new Date(start.slice(0, 10) + 'T00:00Z').getTime();
      for (const days of [31, 366]) {
        const { events } = await this.cal.listEvents({ start: new Date(date - days * 86400000).toISOString().slice(0,10), end: new Date(date + days * 86400000).toISOString().slice(0,10) }); guard();
        copies = events.filter(event => { const marker = parseMarker(event.url); return marker?.instance === instance && marker.actionId === id; });
        if (copies.length) break;
      }
    }
    for (const event of copies) {
      if (event.recurring) throw new Error('Ordinary Calendar copy became recurring; preserve it until the native handoff is repaired.');
      const timing = eventTimingDiagnostic(event);
      if (timing) throw new Error(timing.reason);
    }
    if (copies.length) {
      if (provenance) { mirror.pendingNative.add(id); mirror.save(); }
      for (const event of copies) {
        guard(); const removed = await this.cal.deleteEvent({ eventId: event.id, marker: buildMarker(instance, id, 'active') }); guard();
        if (!removed.deleted) throw new Error('Ordinary Calendar copy removal was not confirmed; native handoff is pending.');
      }
    }
    const previousStart = mirror.ordinaryStarts.get(id);
    if (hint || previousStart || copies.length) {
      mirror.ordinaryEvents.delete(id); mirror.ordinaryStarts.delete(id);
      try { mirror.save(); }
      catch (error) {
        if (hint) mirror.ordinaryEvents.set(id, hint);
        if (previousStart) mirror.ordinaryStarts.set(id, previousStart);
        throw error;
      }
    }
    this.checkedOrdinary.add(id);
  }
  async sync(store: Store, instance: string, calendars: CalCalendar[], prefixes: { active: string; done: string }, guard: () => void, reverse: boolean): Promise<SyncResult[]> {
    const results: SyncResult[] = [], mirror = this.state(store, instance);
    for (const [id, action] of store.getActions()) if (action.frontMatter.occurrence && !store.getAction(action.frontMatter.occurrence.template)?.frontMatter.recurrence) {
      results.push({ id, status: 'error', reason: `Missing recurrence template ${action.frontMatter.occurrence.template}; preserve its Calendar representation until the source is repaired.` });
    }
    for (const [templateId, template] of store.getActions()) if (template.frontMatter.recurrence) {
      try {
        const schedules = assertRecurrence(template.frontMatter.recurrence), file = store.getActionFile(templateId);
        const source = file ? readManagedText(store.getDataDir(), file) : undefined;
        const templateGuard = () => { guard(); if (file && readManagedText(store.getDataDir(), file) !== source || JSON.stringify(store.getAction(templateId)) !== JSON.stringify(template)) throw new Error('Template changed during Calendar reconciliation; retry with its current definition.'); };
        if (store.getIssues().some(i => i.severity === 'error' && (i.file === file || i.message.startsWith(templateId + ':')) && /recurrence|occurrence/.test(i.code))) throw new Error('Recurrence definition is malformed or rewrites history.');
        store.assertRecurrenceChange(templateId, schedules);
        // Only a recorded prior ordinary event or schedule needs a handoff. Fresh
        // templates do not require a date-window discovery sweep.
        if (mirror.ordinaryEvents.has(templateId) || mirror.ordinaryStarts.has(templateId)) {
          await this.retireOrdinary(mirror, instance, templateId, template, templateGuard);
        }
        const families: NativeSeries[] = [], translationErrors: string[] = [];
        if (template.frontMatter.calendar) for (const schedule of schedules) {
          try { families.push(...nativeSeries(schedule)); }
          catch (error) { translationErrors.push(`${schedule.dtstart}: ${(error as Error).message}`); }
        }
        const wanted = new Set(families.map(f => marker(instance, templateId, f.key)));
        // Publish removal before the replacement. A persisted mirror retains
        // obsolete anchors/phases even after restart or a failed replacement.
        const saved = [...store.getActions()].filter(([,a]) => a.frontMatter.occurrence?.template === templateId);
        for (const [id, action] of saved) if (mirror.pendingNative.has(id) && !isNativeOccurrence(store, action)) {
          mirror.pendingNative.delete(id); mirror.pendingOrdinary.add(id); mirror.save();
        }
        const previousFamilies = [...mirror.families.values()].filter(previous => previous.template === templateId);
        const ordinary = saved.filter(([,action]) => !isNativeOccurrence(store, action) && previousFamilies.some(previous =>
          new CompiledRecurrence(previous.family.schedule).contains(templateId, action.frontMatter.occurrence!.original)));
        // Persist the handoff before changing a native rule or deleting its
        // family. This includes shortened endings with an unchanged family key.
        if (ordinary.length) { for (const [id] of ordinary) mirror.pendingOrdinary.add(id); mirror.save(); }
        for (const [base, previous] of [...mirror.families]) if (previous.template === templateId && !wanted.has(base)) {
          await this.prune(mirror, base, templateGuard);
        }
        if (!template.frontMatter.calendar) {
          results.push({ id: templateId, status: 'deleted' }); continue;
        }
        // Retire a confirmed ordinary copy before publishing the same saved
        // identity as a native exception. Keep evidence until publication succeeds.
        for (const [id, action] of saved) if (isNativeOccurrence(store, action)) {
          const path = store.getActionFile(id)!, source = readManagedText(store.getDataDir(), path);
          const savedGuard = () => { templateGuard(); if (readManagedText(store.getDataDir(), path) !== source || JSON.stringify(store.getAction(id)) !== JSON.stringify(action)) throw new Error('Occurrence changed during Calendar reconciliation; retry with its current state.'); };
          savedGuard(); await this.retireOrdinary(mirror, instance, id, action, savedGuard);
        }
        for (const family of families) await this.syncFamily(store, instance, templateId, template, family, saved, calendars, prefixes, templateGuard, reverse, mirror);
        results.push(translationErrors.length ? { id: templateId, status: 'error', reason: translationErrors.join(' ') } : { id: templateId, status: 'synced' });
        for (const [id, action] of store.getActions()) if (action.frontMatter.occurrence?.template === templateId && isNativeOccurrence(store, action)) {
          results.push({ id, status: !action.frontMatter.scheduled || action.frontMatter.resolution === 'cancelled' || !action.frontMatter.calendar ? 'deleted' : 'synced' });
          const native = mirror.pendingNative.delete(id), ordinary = mirror.pendingOrdinary.delete(id);
          if (native || ordinary) mirror.save();
        }
      } catch (error) {
        results.push({ id: templateId, status: 'error', reason: (error as Error).message });
        for (const id of mirror.pendingNative) if (store.getAction(id)?.frontMatter.occurrence?.template === templateId) results.push({ id, status: 'error', reason: (error as Error).message });
      }
    }
    return results;
  }
  private async syncFamily(store: Store, instance: string, templateId: string, template: Action, family: NativeSeries, saved: [string, Action][], calendars: CalCalendar[], prefixes: { active: string; done: string }, guard: () => void, reverse: boolean, mirror: RecurrenceMirror): Promise<void> {
    const identityGuard = guard;
    const file = store.getActionFile(templateId);
    const source = file ? readManagedText(store.getDataDir(), file) : undefined;
    const exceptionSources = new Map(saved.map(([id]) => { const path = store.getActionFile(id)!; return [path, readManagedText(store.getDataDir(), path)]; }));
    guard = () => {
      identityGuard();
      if (file && readManagedText(store.getDataDir(), file) !== source || JSON.stringify(store.getAction(templateId)) !== JSON.stringify(template)) throw new Error('Template changed during Calendar reconciliation; retry with its current definition.');
      for (const [path, content] of exceptionSources) if (readManagedText(store.getDataDir(), path) !== content) throw new Error('Occurrence changed during Calendar reconciliation; retry with its current state.');
    };
    const refreshExceptionSources = () => { for (const [id, action] of store.getActions()) if (action.frontMatter.occurrence?.template === templateId) { const path = store.getActionFile(id)!; exceptionSources.set(path, readManagedText(store.getDataDir(), path)); } };
    const base = marker(instance, templateId, family.key), rule = new CompiledRecurrence(family.schedule);
    const version = JSON.stringify(template), previous = mirror.families.get(base), stable = previous?.definition === version;
    const snapshot: FamilyMirror = previous ? structuredClone(previous) : { template: templateId, family, observed: [] };
    snapshot.family = family;
    const witnessed = new Map(snapshot.observed.map(value => [occurrenceKey(value.identity), value]));
    for (const [, action] of saved) {
      const identity = action.frontMatter.occurrence!;
      if (!rule.contains(templateId, identity.original)) continue;
      const existing = witnessed.get(occurrenceKey(identity));
      if (existing) continue;
      // Saved records authorize exact-time lookup without inventing a witness:
      // an absent event here can be our own prior cancellation, not a gesture.
      const wall = rule.wallFor(identity.original)!;
      snapshot.observed.push({ identity, event: { id: '', url: base, calendar: '', title: '', start: action.frontMatter.scheduled ?? wall,
        end: wall, timezone: identity.timezone ?? null, startInstant: scheduleInstant(wall, identity.timezone)!, endInstant: scheduleInstant(wall, identity.timezone)! } });
    }
    // Include the current and next native occurrence, independent of projection
    // lookahead. Stored detached items are fetched by the provider family ID.
    const next = rule.occurrences(templateId, wallTimeAt(Date.now(), family.schedule.timezone)).next().value;
    if (next && !snapshot.observed.some(o => occurrenceKey(o.identity) === occurrenceKey(next.identity))) snapshot.observed.push({ identity: next.identity,
      event: { id: '', url: base, title: '', calendar: '', start: next.scheduled, end: next.scheduled, timezone: next.identity.timezone ?? null,
        startInstant: scheduleInstant(next.scheduled, next.identity.timezone)!, endInstant: scheduleInstant(next.scheduled, next.identity.timezone)! } });
    const events = new Map<string, CalEvent>();
    for (const event of await this.fetch(base, snapshot, guard)) events.set(`${event.id}:${event.original ?? event.start}`, event);
    const canonical = normalizeRule(family.rule, family.schedule.dtstart);
    const masters = [...events.values()].filter(e => !e.detached && e.seriesRule && (e.seriesHead || ![...events.values()].some(v => v.seriesHead)));
    const desired = desiredFromAction({ id: templateId, frontMatter: { ...template.frontMatter, scheduled: family.schedule.dtstart, timezone: family.schedule.timezone, recurrence: undefined }, body: template.body }, instance, prefixes);
    if (!desired.have) return;
    const nativeMatches = masters.every(e => normalizeRule(e.seriesRule!, family.schedule.dtstart) === canonical);
    const master = masters.find(e => e.start === desired.up.start || e.allDay && e.start.slice(0,10) === family.schedule.dtstart) ?? masters[0];
    const anchored = !!master && !!master.allDay === !!desired.up.allDay && (desired.up.allDay ? master.start.slice(0,10) === desired.up.start.slice(0,10) : master.start === desired.up.start);
    const current = new Map<string, Observed>();
    const replaceTime = new Set<string>();
    for (const event of events.values()) {
      const occurrence = eventOccurrence(rule, templateId, event);
      if (!occurrence) continue;
      const original = occurrence.identity.original;
      const key = occurrenceKey(occurrence.identity);
      current.set(key, { event, identity: occurrence.identity });
      const existing = saved.find(([,a]) => occurrenceKey(a.frontMatter.occurrence!) === key);
      const action = existing?.[1] ?? projectedAction(template, occurrence.identity, occurrence.scheduled);
      const timing = eventTimingDiagnostic(event);
      if (timing) {
        if (!this.timeBlocked.has(key)) this.timeBlocked.set(key, startDefinition(action));
        const fm = action.frontMatter;
        const explicit = existing && this.timeBlocked.get(key) !== startDefinition(action) && fm.scheduled && fm.calendar && fm.resolution !== 'cancelled' &&
          schedulingIssues(fm).length === 0 && scheduleInstant(fm.scheduled, fm.timezone) !== undefined && !isRepeatedSchedule(fm.scheduled, fm.timezone);
        if (!explicit || !canReplaceEventTime(event)) throw new Error(timing.reason);
        replaceTime.add(key);
        continue;
      }
      this.timeBlocked.delete(key);
      if (!reverse || !stable || !nativeMatches || !anchored || !event.detached || event.seriesRule && normalizeRule(event.seriesRule, family.schedule.dtstart) !== canonical) continue;
      if (existing && witnessed.get(key)?.source !== JSON.stringify(existing[1])) continue;
      const imported = importFromEvent({ id: existing?.[0] ?? templateId, frontMatter: action.frontMatter, body: action.body }, { ...event, url: buildMarker(instance, existing?.[0] ?? templateId, state(event.url)) }, calendars);
      if (imported.summaries.length) {
        guard(); handleUpdateOccurrence(store, { template: templateId, original, scheduled: imported.fm.scheduled ?? null, timezone: imported.fm.timezone ?? null, duration: imported.fm.duration ?? null, resolution: imported.fm.resolution ?? null, calendar: imported.fm.calendar ?? null, calendar_account: imported.fm.calendar_account ?? null }); refreshExceptionSources();
      }
    }
    if (reverse && stable && nativeMatches && anchored) {
      for (const [key, value] of witnessed) if (value.event.id && !current.has(key)) {
        const existing = saved.find(([, action]) => occurrenceKey(action.frontMatter.occurrence!) === key);
        // A cancelled, unpinned, or descheduled source explicitly removes its
        // native exception. Never feed that acknowledged removal back as an edit.
        if (existing && !desiredFromAction({ id: existing[0], ...existing[1] }, instance, prefixes).have) continue;
        if (existing && value.source !== JSON.stringify(existing[1])) continue;
        guard(); handleUpdateOccurrence(store, { template: templateId, original: value.identity.original, scheduled: null }); refreshExceptionSources();
      }
    }
    if (!master || !stable || !nativeMatches || !anchored || master.title !== desired.up.title || master.calendar !== desired.up.calendar || master.calendar_account !== (desired.up.calendar_account ?? master.calendar_account) || !master.allDay && master.durationMinutes !== desired.up.durationMinutes || master.timezone !== (desired.up.timezone ?? null)) {
      // Calendar's "this and future" edit can create another physical master
      // with the same marker. It is a source-of-truth mismatch, never an Aside
      // occurrence gesture. Remove the extra pieces before restoring the rule.
      for (const extra of masters.filter(event => event.id !== master?.id)) { guard(); await this.cal.deleteSeries({ eventId: extra.id, marker: base }); guard(); }
      // Retain native lookup hints before publishing, including after a lost
      // reply, so retries adopt this owned marker rather than duplicate it.
      mirror.families.set(base, { ...snapshot, family: previous?.family ?? family }); mirror.save();
      guard(); const published = await this.cal.upsertSeries({ ...desired.up, marker: base, seriesRule: family.rule, eventId: master?.id ?? snapshot.eventId }); guard();
      snapshot.eventId = published.eventId;
      snapshot.externalId = published.externalId ?? master?.externalId ?? snapshot.externalId;
    } else { snapshot.eventId = master.id; snapshot.externalId = master.externalId ?? snapshot.externalId; }
    for (const [id,action] of store.getActions()) if (action.frontMatter.occurrence?.template === templateId) {
      const provenance = action.frontMatter.occurrence, wall = rule.wallFor(provenance.original);
      if (!wall) continue;
      if (!rule.contains(templateId, provenance.original)) {
        const matchesAnother = template.frontMatter.recurrence!.some(s => new CompiledRecurrence(s).contains(templateId, provenance.original));
        const stale = [...events.values()].find(e => e.original === provenance.original);
        if (!matchesAnother && stale) {
          guard(); await this.cal.upsertOccurrence({ ...desired.up, marker: base, original: provenance.original, originalTimezone: provenance.timezone, anchor: family.schedule.dtstart, eventId: stale.id, remove: true }); guard();
          if ((await this.fetch(base, snapshot, guard)).some(event => event.original === provenance.original)) throw new Error('Native Calendar occurrence removal was not confirmed; ordinary handoff is pending.');
        }
        continue;
      }
      const actual = desiredFromAction({ id, frontMatter: action.frontMatter, body: action.body }, instance, prefixes);
      const fallback = desiredFromAction({ id, frontMatter: projectedAction(template, provenance, wall).frontMatter, body: action.body }, instance, prefixes);
      if (!fallback.have) continue;
      const target = actual.have ? actual.up : fallback.up;
      const observed = current.get(occurrenceKey(provenance))?.event;
      if (!actual.have && !observed) { current.delete(occurrenceKey(provenance)); continue; }
      const url = base + (actual.have && action.frontMatter.resolution === 'done' ? '/done' : '');
      if (actual.have && observed && observed.url === url && observed.title === target.title && observed.calendar === target.calendar && (!target.calendar_account || observed.calendar_account === target.calendar_account) && observed.start === target.start && !!observed.allDay === !!target.allDay && observed.timezone === (target.timezone ?? null) && (target.allDay || observed.durationMinutes === target.durationMinutes)) continue;
      guard(); const exported = await this.cal.upsertOccurrence({ ...target, marker: base + (actual.have && action.frontMatter.resolution === 'done' ? '/done' : ''), original: provenance.original, originalTimezone: provenance.timezone, originalAllDay: provenance.original.length === 10, anchor: family.schedule.dtstart, eventId: observed?.id, remove: !actual.have, ...(replaceTime.has(occurrenceKey(provenance)) && { allowTimeReplacement: true }), notes: `Aside occurrence: ${provenance.original}\n${target.notes ?? ''}` }); guard();
      if (!actual.have) current.delete(occurrenceKey(provenance));
      else {
        const startInstant = scheduleInstant(target.start, target.timezone)!;
        let effective: CalEvent = { id: exported.eventId, url, title: target.title, calendar: target.calendar, calendar_account: target.calendar_account, start: target.start, end: target.end, allDay: target.allDay, timezone: target.timezone ?? null, startInstant, endInstant: startInstant + (target.durationMinutes ?? 0) * 60000, durationMinutes: target.durationMinutes, original: provenance.original, detached: true, recurring: true, seriesRule: family.rule };
        if (!target.timezone && !target.allDay) {
          // Retain the returned native identifier before confirmation so a
          // failed read still locates an exception moved far from its origin.
          current.set(occurrenceKey(provenance), { identity: provenance, event: effective });
          snapshot.observed = [...current.values()].map(value => ({ ...value, source: occurrenceKey(value.identity) === occurrenceKey(provenance) ? undefined : witnessed.get(occurrenceKey(value.identity))?.source }));
          mirror.families.set(base, snapshot); mirror.save();
          const confirmation = await this.cal.getEvents({ eventIds: [exported.eventId] }); guard();
          const actual = confirmation.events.find(event => event.id === exported.eventId && event.url === url && occurrenceKey(eventOccurrence(rule, templateId, event)?.identity ?? { template: '', original: '' }) === occurrenceKey(provenance));
          if (!actual) throw new Error('Calendar occurrence was saved but readback did not confirm its identity; retry its current definition.');
          const timing = eventTimingDiagnostic(actual);
          if (timing) throw new Error(timing.reason);
          if (actual.title !== target.title || actual.calendar !== target.calendar || target.calendar_account && actual.calendar_account !== target.calendar_account || actual.allDay || actual.timezone !== null || actual.durationMinutes !== target.durationMinutes) throw new Error('Calendar occurrence was saved but readback differs from its saved definition; retry confirmation.');
          if (actual.start !== target.start) { handleUpdateOccurrence(store, { template: templateId, original: provenance.original, scheduled: actual.start }); refreshExceptionSources(); }
          effective = actual;
        }
        current.set(occurrenceKey(provenance), { identity: provenance, event: effective });
        this.timeBlocked.delete(occurrenceKey(provenance));
      }
    }
    const sources = new Map([...store.getActions().values()].filter(action => action.frontMatter.occurrence?.template === templateId).map(action => [occurrenceKey(action.frontMatter.occurrence!), JSON.stringify(action)]));
    snapshot.observed = [...current.values()].map(value => ({ ...value, source: sources.get(occurrenceKey(value.identity)) })); snapshot.definition = version;
    mirror.families.set(base, snapshot); mirror.save();
  }
}

export function isNativeOccurrence(store: Store | undefined, action: { frontMatter: Action['frontMatter'] }): boolean {
  const identity = action.frontMatter.occurrence;
  if (!identity || !store) return false;
  const template = store.getAction(identity.template);
  const file = store.getActionFile(identity.template);
  // Malformed references and history edits must not fall through to ordinary
  // export, which would duplicate or replace a preserved native exception.
  if (!template?.frontMatter.recurrence || store.getIssues().some(issue => issue.severity === 'error' && /recurrence|occurrence/.test(issue.code) && (file && issue.file === file || issue.message.startsWith(identity.template + ':')))) return true;
  try { assertRecurrence(template.frontMatter.recurrence); } catch { return true; }
  if (!template.frontMatter.calendar) return false;
  try { return store.getAction(identity.template)?.frontMatter.recurrence?.some(schedule => new CompiledRecurrence(schedule).contains(identity.template, identity.original) && nativeSeries(schedule).length > 0) ?? false; } catch { return false; }
}
