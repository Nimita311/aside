import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

it.skipIf(process.platform !== 'darwin')('native rule construction preserves its fields on unsaved EventKit objects', () => {
  const directory = mkdtempSync('/private/tmp/aside-recurrence-native-');
  try {
    const native = readFileSync(new URL('../native/aside-cal/main.swift', import.meta.url), 'utf8');
    const rules = native.slice(native.indexOf('func nativeRule('), native.indexOf('func upsertEvent('));
    const identity = native.slice(native.indexOf('func markerIdentity('), native.indexOf('// Whether an event'));
    const source = join(directory,'probe.swift'), binary = join(directory,'probe');
    writeFileSync(source, `import Foundation\nimport EventKit\n${rules}\n${identity}\n
let rule = nativeRule(["frequency": "monthly", "interval": 2, "days": [["day": 2, "week": 1]], "count": 10])!
precondition(rule.frequency == .monthly && rule.interval == 2)
precondition(rule.daysOfTheWeek!.first!.weekNumber == 1)
precondition(rule.recurrenceEnd!.occurrenceCount == 10)
let value = ruleDict(rule)
precondition(value["frequency"] as? String == "monthly")
let weekly = nativeRule(["frequency": "weekly", "interval": 2, "days": [["day": 6, "week": 0]]])!
precondition(weekly.firstDayOfTheWeek == 2)
let event = EKEvent(eventStore: EKEventStore())
event.recurrenceRules = [rule]
precondition(event.hasRecurrenceRules)
precondition(markerIdentity("aside://work/series/template/0123456789abcdef/done") == "aside://work/series/template/0123456789abcdef")
precondition(markerIdentity("aside://work/series/template/0123456789abcdef/Done/") == "aside://work/series/template/0123456789abcdef")
precondition(markerIdentity("aside://work/action/action/done") == "aside://work/action/action")
print("native recurrence verified")\n`);
    execFileSync('xcrun',['swiftc','-module-cache-path',join(directory,'modules'),source,'-o',binary],{timeout:60000});
    expect(execFileSync(binary,{encoding:'utf8',timeout:10000})).toContain('native recurrence verified');
  } finally { rmSync(directory,{recursive:true,force:true}); }
}, 75000);


it.skipIf(process.platform !== 'darwin')('fresh native occurrence selection blocks unsafe saves and removals', () => {
  const directory = mkdtempSync('/private/tmp/aside-recurrence-guard-');
  try {
    const native = readFileSync(new URL('../native/aside-cal/main.swift', import.meta.url), 'utf8');
    const timing = native.slice(native.indexOf('func parseWall('), native.indexOf('// The action-identity portion'));
    const operation = native.slice(native.indexOf('func markerIdentity('), native.indexOf('// Remove the event a marker'))
      .replaceAll('EKEvent(eventStore: store)', 'EKEvent(eventStore: backing)');
    const source = join(directory, 'probe.swift'), binary = join(directory, 'probe');
    // An unsaved native event changes to a fractional duration after Node's
    // earlier read. The local store double intercepts every Calendar write;
    // this executes the real native command branch, including fresh selection.
    writeFileSync(source, `import Foundation
import EventKit
import CoreFoundation
import ObjectiveC
let backing = EKEventStore()
class WritableCalendar: EKCalendar {
  override var allowsContentModifications: Bool { true }
}
let calendar = EKCalendar(for: .event, eventStore: backing)
object_setClass(calendar, WritableCalendar.self)
calendar.title = "Work"
let selected = EKEvent(eventStore: backing)
let first = ISO8601DateFormatter().date(from: "2026-10-09T09:00:00Z")!
selected.startDate = first
selected.endDate = first.addingTimeInterval(1830)
selected.timeZone = TimeZone(identifier: "UTC")
selected.calendar = calendar
selected.url = URL(string: "aside://work/series/template/0123456789abcdef")
struct FakeStore {
  func calendars(for type: EKEntityType) -> [EKCalendar] { [calendar] }
  func event(withIdentifier id: String) -> EKEvent? { selected }
  func predicateForEvents(withStart: Date, end: Date, calendars: [EKCalendar]?) -> NSPredicate { NSPredicate(value: true) }
  func events(matching predicate: NSPredicate) -> [EKEvent] { [selected] }
  func remove(_ event: EKEvent, span: EKSpan, commit: Bool) throws { writes += 1 }
  func save(_ event: EKEvent, span: EKSpan, commit: Bool) throws { writes += 1 }
}
let store = FakeStore()
var writes = 0
var errors: [String] = []
func respond(id: Any?, result: [String: Any]) { }
func respondError(id: Any?, _ message: String, code: String? = nil) { errors.append(code ?? message) }
${timing}
${operation}
for removing in [false, true] {
  upsertEvent(id: "guard", ["cmd": "upsert-occurrence", "calendar": "Work", "marker": "aside://work/series/template/0123456789abcdef", "title": "Review", "start": "2026-10-09T09:00", "end": "2026-10-09T09:30", "timezone": "UTC", "durationMinutes": 30, "original": "2026-10-09T09:00:00Z", "originalTimezone": "UTC", "anchor": "2026-10-09T09:00", "eventId": "stale-hint", "remove": removing])
}
precondition(writes == 0)
precondition(errors == ["event-time-unrepresentable", "event-time-unrepresentable"])
selected.startDate = parseWall("2027-03-14T02:30", TimeZone.current, normalizeFloating: true)!
selected.endDate = selected.startDate.addingTimeInterval(1800)
selected.timeZone = nil
upsertEvent(id: "floating-gap", ["cmd": "upsert-occurrence", "calendar": "Work", "marker": "aside://work/series/template/0123456789abcdef/done", "title": "Review", "start": "2027-03-14T02:30", "end": "2027-03-14T03:00", "durationMinutes": 30, "original": "2027-03-14T02:30", "anchor": "2027-03-13T02:30", "eventId": "stale-hint"])
precondition(writes == 1)
print("fresh occurrence timing guard verified")
`);
    execFileSync('xcrun',['swiftc','-module-cache-path',join(directory,'modules'),source,'-o',binary],{timeout:60000});
    expect(execFileSync(binary,{encoding:'utf8',timeout:10000})).toContain('fresh occurrence timing guard verified');
  } finally { rmSync(directory,{recursive:true,force:true}); }
}, 75000);


it.skipIf(process.platform !== 'darwin')('native stored-family lookup discovers distant exceptions and excludes foreign markers and adjacent projections', () => {
  const directory = mkdtempSync('/private/tmp/aside-recurrence-family-');
  try {
    const native = readFileSync(new URL('../native/aside-cal/main.swift', import.meta.url), 'utf8');
    const wall = native.slice(native.indexOf('func parseWall('), native.indexOf('func timedEventIssue('));
    const identity = native.slice(native.indexOf('func markerIdentity('), native.indexOf('// The event a marker already'));
    const rules = native.slice(native.indexOf('func nativeRule('), native.indexOf('func upsertEvent('));
    const event = native.slice(native.indexOf('func eventDict('), native.indexOf('// Aside-marked events'));
    const lookup = native.slice(native.indexOf('func getSeries('), native.indexOf('func handle('));
    const source = join(directory, 'probe.swift'), binary = join(directory, 'probe');
    // The provider double exposes stored family items with a shared external
    // identifier. All events are unsaved native objects and every query is
    // intercepted; no access grant or user's Calendar data is touched.
    writeFileSync(source, `import Foundation
import EventKit
import ObjectiveC
let backing = EKEventStore()
let calendar = EKCalendar(for: .event, eventStore: backing)
calendar.title = "Work"
var metadata: [ObjectIdentifier: (String, Date, Bool)] = [:]
class ProviderEvent: EKEvent {
  override var eventIdentifier: String! { metadata[ObjectIdentifier(self)]!.0 }
  override var occurrenceDate: Date! { metadata[ObjectIdentifier(self)]!.1 }
  override var isDetached: Bool { metadata[ObjectIdentifier(self)]!.2 }
  override var calendarItemExternalIdentifier: String! { "provider-family" }
}
func fixture(_ id: String, _ original: String, _ start: String, _ detached: Bool, _ marker: String) -> EKEvent {
  let event = EKEvent(eventStore: backing)
  let parser = ISO8601DateFormatter()
  event.title = "Review"; event.calendar = calendar; event.url = URL(string: marker)
  event.startDate = parser.date(from: start)!
  event.endDate = event.startDate.addingTimeInterval(1800)
  event.timeZone = TimeZone(identifier: "UTC")
  event.recurrenceRules = [EKRecurrenceRule(recurrenceWith: .yearly, interval: 1, end: nil)]
  metadata[ObjectIdentifier(event)] = (id, parser.date(from: original)!, detached)
  object_setClass(event, ProviderEvent.self)
  return event
}
let marker = "aside://work/series/template/0123456789abcdef"
let head = fixture("head", "2026-10-09T09:00:00Z", "2026-10-09T09:00:00Z", false, marker)
let distant = fixture("distant", "2036-10-09T09:00:00Z", "2042-10-09T11:00:00Z", true, marker)
let foreign = fixture("foreign", "2036-10-09T09:00:00Z", "2042-10-09T11:00:00Z", true, "aside://another/series/other/0123456789abcdef")
let adjacent = fixture("adjacent", "2026-10-10T09:00:00Z", "2026-10-10T09:00:00Z", false, marker)
struct FakeStore {
  func event(withIdentifier id: String) -> EKEvent? { [head,distant,foreign].first { $0.eventIdentifier == id } }
  func predicateForEvents(withStart: Date, end: Date, calendars: [EKCalendar]?) -> NSPredicate {
    NSPredicate { value, _ in guard let event = value as? EKEvent else { return false }; return event.startDate >= withStart && event.startDate <= end }
  }
  func events(matching predicate: NSPredicate) -> [EKEvent] { [head,distant,foreign,adjacent].filter { predicate.evaluate(with: $0) } }
  func calendarItems(withExternalIdentifier id: String) -> [EKCalendarItem] { [head,distant,foreign] }
}
let store = FakeStore()
var result: [String: Any] = [:]
func respond(id: Any?, result value: [String: Any]) { result = value }
func respondError(id: Any?, _ message: String, code: String? = nil) { fatalError(message) }
${wall}
${identity}
${rules}
${event}
${lookup}

getSeries(id: "probe", ["marker": marker, "start": "2026-10-09T09:00", "timezone": "UTC", "eventId": "head", "externalId": "provider-family", "occurrences": []])
let events = result["events"] as! [[String: Any]]
precondition(events.count == 2)
precondition(events.allSatisfy { $0["url"] as? String == marker })
let exception = events.first { $0["id"] as? String == "distant" }!
precondition(exception["original"] as? String == "2036-10-09T09:00:00Z")
precondition(exception["start"] as? String == "2042-10-09T11:00")
precondition(exception["detached"] as? Bool == true)
print("native distant family discovery verified")
`);
    execFileSync('xcrun',['swiftc','-module-cache-path',join(directory,'modules'),source,'-o',binary],{timeout:60000});
    expect(execFileSync(binary,{encoding:'utf8',timeout:10000})).toContain('native distant family discovery verified');
  } finally { rmSync(directory,{recursive:true,force:true}); }
}, 75000);
