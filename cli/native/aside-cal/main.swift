// aside-cal — the EventKit helper the CLI ships so Node can reach Calendar.app.
//
// Protocol: one JSON object per line in, one per line out. A request is
//   {"id": <any>, "cmd": <string>, ...args}
// answered by exactly one response carrying the same id:
//   {"id": <any>, "ok": true,  "result": {...}}
//   {"id": <any>, "ok": false, "error": "<message>", "code": "<class>"?}
// `code` is a machine-readable failure class (calendar-not-found /
// calendar-read-only / event-recurring) so the MCP classifies failures without
// parsing the message; uncoded errors are transient. The process is long-lived;
// it lives and dies with the MCP (stdin close ends the loop). See
// cli/calendar-impl.md for the full design.

import EventKit
import Foundation
import CoreFoundation
import Darwin

// Become our own TCC "responsible process". A child inherits its parent's TCC
// responsibility, so when launched by Terminal / VS Code / the MCP host, the
// calendar prompt is attributed to *that* app — none of which carry a calendar
// usage string, so TCC denies (or won't even prompt) without ever reaching us.
// Re-exec ourselves once with the disclaim spawn attribute: the re-exec'd process
// disclaims its parent and stands as its own responsible process, so TCC uses
// *our* identity and embedded NSCalendarsFullAccessUsageDescription and binds the
// grant to aside-cal — identically whoever launches us. The stub supervises the
// disclaimed child over the inherited stdio, so Node talks to it transparently.
// See cli/calendar-impl.md.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attr: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

// The disclaimed child's pid, for the stub's SIGTERM handler (a signal handler
// can only reach a global).
var disclaimedChild: pid_t = 0

func becomeResponsibleProcess() {
  if ProcessInfo.processInfo.environment["ASIDE_CAL_RESPONSIBLE"] != nil { return }

  // Our own executable path (argv[0] may be relative or a symlink name).
  var size = UInt32(0)
  _ = _NSGetExecutablePath(nil, &size)
  var pathBuf = [CChar](repeating: 0, count: Int(size))
  guard _NSGetExecutablePath(&pathBuf, &size) == 0 else { return }

  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  defer { posix_spawnattr_destroy(&attr) }
  guard responsibility_spawnattrs_setdisclaim(&attr, 1) == 0 else { return }

  let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  defer { for a in argv where a != nil { free(a) } }
  var envStrings = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
  envStrings.append("ASIDE_CAL_RESPONSIBLE=1") // sentinel so the child runs the helper, not another re-exec
  let envp: [UnsafeMutablePointer<CChar>?] = envStrings.map { strdup($0) } + [nil]
  defer { for e in envp where e != nil { free(e) } }

  // nil file actions → the child inherits stdin/stdout/stderr, so it speaks to
  // Node over the same pipes. Spawn failure falls through to run in-process.
  var pid: pid_t = 0
  guard posix_spawn(&pid, pathBuf, nil, &attr, argv, envp) == 0 else { return }
  // A SIGTERM at the stub must take the disclaimed child down too — otherwise
  // the orphan keeps running with the inherited pipes open, feeding a respawned
  // helper's parse buffer. (The normal shutdown is stdin close, which the child
  // sees directly.)
  disclaimedChild = pid
  signal(SIGTERM) { _ in
    if disclaimedChild > 0 { kill(disclaimedChild, SIGTERM) }
    _exit(1)
  }
  var status: Int32 = 0
  while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
  exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}

becomeResponsibleProcess()

// An uncaught Objective-C exception from EventKit terminates the helper before it
// can reply. The MCP detects the exit and fails the in-flight request, but log the
// reason to stderr (which the MCP forwards) so the failure isn't opaque.
NSSetUncaughtExceptionHandler { exception in
  let reason = exception.reason ?? ""
  FileHandle.standardError.write(Data("aside-cal uncaught exception: \(exception.name.rawValue): \(reason)\n".utf8))
}

// Opt-in stderr tracing (the MCP forwards it). Set ASIDE_CAL_DEBUG to see whether
// the EKEventStoreChanged notification actually reaches the helper in-session —
// the one thing not observable from Node or testable with the fake. Silent unless
// the env var is present; never writes to stdout (the protocol channel).
let debugEnabled = ProcessInfo.processInfo.environment["ASIDE_CAL_DEBUG"] != nil
func debugLog(_ message: String) {
  guard debugEnabled else { return }
  FileHandle.standardError.write(Data("aside-cal: \(message)\n".utf8))
}

let store = EKEventStore()

// EventKit caches the objects it hands out; an external edit (or our own write)
// leaves them stale until the store is reset, so a fetch after a change returns
// the pre-edit snapshot and the reverse reconcile sees no diff. The change
// observer fires on an arbitrary thread and must not touch the store (only the
// command thread may), so it just marks the store dirty; the command thread resets
// before the next fetch, so every command reads the post-change state.
let dirtyLock = NSLock()
var storeDirty = false

func markStoreDirty() {
  dirtyLock.lock()
  storeDirty = true
  dirtyLock.unlock()
}

func resetStoreIfDirty() {
  dirtyLock.lock()
  let dirty = storeDirty
  storeDirty = false
  dirtyLock.unlock()
  if dirty {
    store.reset()  // drops cached objects; committed events persist
    debugLog("store reset (re-reading after a change)")
  }
}

func authStatusString(_ s: EKAuthorizationStatus) -> String {
  switch s {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .fullAccess: return "fullAccess"
  case .writeOnly: return "writeOnly"
  default: return "unknown"
  }
}

func calendarTypeString(_ t: EKCalendarType) -> String {
  switch t {
  case .local: return "local"
  case .calDAV: return "calDAV"
  case .exchange: return "exchange"
  case .subscription: return "subscription"
  case .birthday: return "birthday"
  default: return "unknown"
  }
}

// Calendar colors arrive as CGColor; emit them as #RRGGBB for the agent.
func hexColor(_ cg: CGColor?) -> String? {
  guard let comps = cg?.components else { return nil }
  func channel(_ v: CGFloat) -> Int { return max(0, min(255, Int((v * 255).rounded()))) }
  let r: CGFloat, g: CGFloat, b: CGFloat
  switch comps.count {
  case 2: r = comps[0]; g = comps[0]; b = comps[0]  // grayscale + alpha
  case 3, 4: r = comps[0]; g = comps[1]; b = comps[2]  // rgb(+alpha)
  default: return nil
  }
  return String(format: "#%02X%02X%02X", channel(r), channel(g), channel(b))
}

// stdout is written from both the stdin-processing thread and the main thread's
// change observer, so serialize whole lines.
let emitLock = NSLock()

// Serialize and write one newline-delimited response. Returns false when the
// object isn't JSON-serializable, so the caller can fall back to an error reply
// rather than leave the request unanswered — a dropped reply hangs the MCP until
// its request timeout, turning a recoverable failure into a stall.
@discardableResult
func emit(_ obj: [String: Any]) -> Bool {
  guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
  data.append(0x0a)  // newline-delimited
  emitLock.lock()
  try? FileHandle.standardOutput.write(contentsOf: data)
  emitLock.unlock()
  return true
}

func respond(id: Any?, result: [String: Any]) {
  var obj: [String: Any] = ["ok": true, "result": result]
  if let id = id { obj["id"] = id }
  if !emit(obj) {
    // The result couldn't be serialized; answer with an error so the caller
    // learns the request failed instead of waiting it out.
    respondError(id: id, "internal error: result could not be serialized")
  }
}

// `code` is the structured failure class (see the protocol comment up top);
// omit it for transient failures the MCP should retry.
func respondError(id: Any?, _ message: String, code: String? = nil) {
  var obj: [String: Any] = ["ok": false, "error": message]
  if let code = code { obj["code"] = code }
  if let id = id { obj["id"] = id }
  emit(obj)
}

func listCalendars(id: Any?) {
  let items: [[String: Any]] = store.calendars(for: .event).map { c in
    var item: [String: Any] = [
      "id": c.calendarIdentifier,
      "name": c.title,
      "account": c.source?.title ?? "",
      "writable": c.allowsContentModifications,
      "type": calendarTypeString(c.type),
    ]
    if let hex = hexColor(c.cgColor) { item["color"] = hex }
    return item
  }
  respond(id: id, result: ["calendars": items])
}

// Surfaces the TCC prompt (macOS 14+ full access). The completion fires on an
// arbitrary queue, so a semaphore lets us answer synchronously per request.
func requestAccess(id: Any?) {
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  var failure: String?
  store.requestFullAccessToEvents { ok, error in
    granted = ok
    failure = error?.localizedDescription
    sem.signal()
  }
  sem.wait()
  if let failure = failure {
    respondError(id: id, failure, code: "authorization-request-failed")
    return
  }
  let status = EKEventStore.authorizationStatus(for: .event)
  respond(id: id, result: ["granted": granted, "status": authStatusString(status)])
}

// Times cross the wire as floating wall-clock strings (`YYYY-MM-DDTHH:MM`),
// interpreted in the event's zone (or the default zone when floating). The Node
// side passes elapsed minutes for timed events; date-only spans use wall dates.
func parseWall(_ s: String, _ zone: TimeZone, normalizeFloating: Bool = false) -> Date? {
  guard s.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$"#, options: .regularExpression) != nil else { return nil }
  let halves = s.split(separator: "T", maxSplits: 1)
  guard halves.count == 2 else { return nil }
  let d = halves[0].split(separator: "-")
  let t = halves[1].split(separator: ":")
  guard d.count == 3, t.count >= 2,
    let y = Int(d[0]), let mo = Int(d[1]), let day = Int(d[2]),
    let h = Int(t[0]), let mi = Int(t[1])
  else { return nil }
  var comps = DateComponents()
  comps.year = y; comps.month = mo; comps.day = day
  comps.hour = h; comps.minute = mi
  comps.second = t.count >= 3 ? Int(t[2]) ?? 0 : 0
  var cal = Calendar(identifier: .gregorian)
  cal.timeZone = zone
  // Gregorian validity is independent of a local clock transition. Permit only
  // a real civil value to normalize: never February 30, hour 24, or year 0000.
  var civil = Calendar(identifier: .gregorian)
  civil.timeZone = TimeZone(secondsFromGMT: 0)!
  guard (1...9999).contains(y), let civilDate = civil.date(from: comps) else { return nil }
  let requested = civil.dateComponents([.year, .month, .day, .hour, .minute], from: civilDate)
  guard requested.year == y, requested.month == mo, requested.day == day,
    requested.hour == h, requested.minute == mi else { return nil }
  guard let date = cal.date(from: comps) else { return nil }
  let actual = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
  guard normalizeFloating || (actual.year == y && actual.month == mo && actual.day == day &&
    actual.hour == h && actual.minute == mi) else { return nil }
  return date
}

func isoWall(_ date: Date, _ zone: TimeZone) -> String {
  var cal = Calendar(identifier: .gregorian)
  cal.timeZone = zone
  let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
  return String(format: "%04d-%02d-%02dT%02d:%02d", c.year!, c.month!, c.day!, c.hour!, c.minute!)
}

// A timed calendar event is representable only at the first minute-precision
// wall occurrence with a positive whole-minute elapsed length. The end may
// itself fall in the repeated hour: elapsed duration represents it exactly.
func timedEventIssue(_ start: Date, _ end: Date, _ zone: TimeZone) -> String? {
  if zone.identifier.hasPrefix("GMT+") || zone.identifier.hasPrefix("GMT-") {
    return "calendar timezone must be a named IANA zone, not a numeric offset"
  }
  guard start.timeIntervalSince1970.isFinite, end.timeIntervalSince1970.isFinite else {
    return "calendar event has invalid start/end instants"
  }
  guard parseWall(isoWall(start, zone), zone) == start else {
    return "calendar start is a later repeated-hour occurrence or has sub-minute precision"
  }
  let minutes = end.timeIntervalSince(start) / 60
  guard minutes.isFinite, minutes > 0, minutes.rounded(.towardZero) == minutes else {
    return "calendar event length must be positive whole elapsed minutes"
  }
  return nil
}

func eventTimingIssue(_ event: EKEvent) -> String? {
  return event.isAllDay ? nil : timedEventIssue(event.startDate, event.endDate, event.timeZone ?? TimeZone.current)
}

func calendarsNamed(_ name: String, account: String?) -> [EKCalendar] {
  return store.calendars(for: .event).filter {
    $0.title == name && (account == nil || ($0.source?.title ?? "local") == account)
  }
}

// The action-identity portion of a marker — `aside://<instance>/action/<id>`,
// dropping any lifecycle suffix. nil for non-aside or malformed URLs. Markers are
// canonical percent-encoded ASCII on both sides, so identities compare as plain
// strings (no decoding needed). Used to confirm an event we're about to overwrite
// is ours and for the same action.
func markerIdentity(_ url: String) -> String? {
  guard url.hasPrefix("aside://") else { return nil }
  if let match = url.range(of: "^aside://[a-z0-9-]+/series/[^/]+/[a-f0-9]{16}(?:/(?i:done|complete|completed|cancel|cancelled|canceled|backlog|deschedule|descheduled))?/?$", options: .regularExpression) {
    let pieces = String(url[match]).split(separator: "/")
    return pieces.prefix(5).joined(separator: "/").replacingOccurrences(of: "aside:/", with: "aside://")
  }
  var parts = url.dropFirst("aside://".count).split(separator: "/", omittingEmptySubsequences: false)
  if parts.last?.isEmpty == true { parts.removeLast() }
  guard parts.count >= 3, parts.count <= 4, parts[1] == "action", !parts[2].isEmpty else { return nil }
  let instance = String(parts[0])
  guard instance.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil else { return nil }
  if parts.count == 4 && !["done", "complete", "completed", "cancel", "cancelled", "canceled", "backlog", "deschedule", "descheduled"].contains(parts[3].lowercased()) { return nil }
  guard let action = String(parts[2]).removingPercentEncoding,
    let encoded = action.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")) else { return nil }
  return "aside://\(instance)/action/\(encoded)"
}

// Whether an event belongs to a recurring series (any occurrence, including a
// detached one). Ordinary action commands refuse these; Aside template series
// and their exceptions use explicit commands and fixed occurrence identities.
func isRecurring(_ ev: EKEvent) -> Bool {
  return ev.hasRecurrenceRules || ev.isDetached
}

// The event a marker already points at: the cached id when it still carries the
// marker, else a marker search in a window around the requested time — the
// upsert-by-marker safety net that makes a retried create idempotent (a lost
// reply would otherwise leave the MCP re-creating an event that already exists).
func existingEvent(_ eid: String?, _ wantId: String, near start: Date, end: Date, in cal: EKCalendar) -> EKEvent? {
  if let eid = eid, let ev = store.event(withIdentifier: eid),
    let url = ev.url?.absoluteString, markerIdentity(url) == wantId {
    return ev
  }
  let windowStart = start.addingTimeInterval(-86400)
  let windowEnd = max(start, end).addingTimeInterval(86400)
  let predicate = store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: [cal])
  return store.events(matching: predicate).first { ev in
    guard let url = ev.url?.absoluteString else { return false }
    return markerIdentity(url) == wantId
  }
}

// Create or update the event a marker points at. Updates the event the marker
// resolves to (by cached id, or the by-marker safety net); otherwise creates.
// The event's `url` carries the marker — the sole action↔event link.
func nativeRule(_ raw: [String: Any]) -> EKRecurrenceRule? {
  let frequencies: [String: EKRecurrenceFrequency] = ["daily": .daily, "weekly": .weekly, "monthly": .monthly, "yearly": .yearly]
  guard let name = raw["frequency"] as? String, let frequency = frequencies[name], let interval = raw["interval"] as? Int, interval > 0 else { return nil }
  let end: EKRecurrenceEnd?
  if let count = raw["count"] as? Int { guard count > 0 else { return nil }; end = EKRecurrenceEnd(occurrenceCount: count) }
  else if let until = raw["until"] as? Double { end = EKRecurrenceEnd(end: Date(timeIntervalSince1970: until / 1000)) }
  else { end = nil }
  let days = (raw["days"] as? [[String: Int]])?.compactMap { value -> EKRecurrenceDayOfWeek? in
    guard let day = value["day"], let weekday = EKWeekday(rawValue: day) else { return nil }
    return EKRecurrenceDayOfWeek(weekday, weekNumber: value["week"] ?? 0)
  }
  return EKRecurrenceRule(recurrenceWith: frequency, interval: interval, daysOfTheWeek: days, daysOfTheMonth: raw["monthDays"] as? [NSNumber], monthsOfTheYear: raw["months"] as? [NSNumber], weeksOfTheYear: raw["weeks"] as? [NSNumber], daysOfTheYear: raw["yearDays"] as? [NSNumber], setPositions: raw["positions"] as? [NSNumber], end: end)
}

func ruleDict(_ rule: EKRecurrenceRule) -> [String: Any] {
  let frequencies: [EKRecurrenceFrequency: String] = [.daily: "daily", .weekly: "weekly", .monthly: "monthly", .yearly: "yearly"]
  var value: [String: Any] = ["frequency": frequencies[rule.frequency] ?? "unknown", "interval": rule.interval]
  if let days = rule.daysOfTheWeek, !days.isEmpty { value["days"] = days.map { ["day": $0.dayOfTheWeek.rawValue, "week": $0.weekNumber] } }
  for (key, numbers) in [("monthDays", rule.daysOfTheMonth), ("months", rule.monthsOfTheYear), ("weeks", rule.weeksOfTheYear), ("yearDays", rule.daysOfTheYear), ("positions", rule.setPositions)] { if let numbers = numbers, !numbers.isEmpty { value[key] = numbers } }
  if let end = rule.recurrenceEnd { if end.occurrenceCount > 0 { value["count"] = end.occurrenceCount } else if let date = end.endDate { value["until"] = date.timeIntervalSince1970 * 1000 } }
  return value
}

func upsertEvent(id: Any?, _ obj: [String: Any]) {
  let calName = obj["calendar"] as? String ?? ""
  let account = obj["calendar_account"] as? String
  let matches = calendarsNamed(calName, account: account)
  let label = account.map { "\(calName) (\($0))" } ?? calName
  guard !matches.isEmpty else {
    respondError(id: id, "calendar not found: \(label)", code: "calendar-not-found")
    return
  }
  guard matches.count == 1 else {
    respondError(id: id, "calendar ambiguous: \(label). Rename a matching calendar or choose a unique account name.", code: "calendar-ambiguous")
    return
  }
  let cal = matches[0]
  guard cal.allowsContentModifications else {
    respondError(id: id, "calendar read-only: \(label)", code: "calendar-read-only")
    return
  }
  guard let marker = obj["marker"] as? String, let title = obj["title"] as? String,
    let startStr = obj["start"] as? String, let endStr = obj["end"] as? String
  else {
    respondError(id: id, "missing marker/title/start/end")
    return
  }
  let tzId = obj["timezone"] as? String
  if let tzId = tzId, TimeZone(identifier: tzId) == nil {
    respondError(id: id, "timezone: unrecognized IANA time zone \(tzId)", code: "invalid-scheduling")
    return
  }
  let zone = tzId.flatMap { TimeZone(identifier: $0) } ?? TimeZone.current
  let allDay = (obj["allDay"] as? Bool) ?? false
  guard let start = parseWall(startStr, zone, normalizeFloating: tzId == nil && !allDay) else {
    respondError(id: id, "scheduled: invalid start in the selected time zone", code: "invalid-scheduling")
    return
  }
  let end: Date
  if !allDay, let rawDuration = obj["durationMinutes"] {
    guard let number = rawDuration as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      respondError(id: id, "duration: expected positive whole elapsed minutes", code: "invalid-scheduling")
      return
    }
    let minutes = number.doubleValue
    guard minutes.isFinite, minutes > 0, minutes.rounded(.towardZero) == minutes, minutes <= 9007199254740991 else {
      respondError(id: id, "duration: expected positive whole elapsed minutes", code: "invalid-scheduling")
      return
    }
    end = start.addingTimeInterval(minutes * 60)
    var gregorian = Calendar(identifier: .gregorian)
    gregorian.timeZone = zone
    guard end.timeIntervalSinceReferenceDate.isFinite, (1...9999).contains(gregorian.component(.year, from: end)) else {
      respondError(id: id, "duration: event end exceeds the supported year range 0001–9999", code: "invalid-scheduling")
      return
    }
  } else {
    guard let wallEnd = parseWall(endStr, zone), (allDay ? wallEnd >= start : wallEnd > start) else {
      respondError(id: id, "duration: invalid end in the selected time zone", code: "invalid-scheduling")
      return
    }
    end = wallEnd
  }

  // Ownership: only ever adopt an existing event that already carries this
  // action's marker — found by the given id or the by-marker search. A
  // stale/colliding id pointing at a hand-made event (or a different action) is
  // left untouched — we create our own instead. An adopted event that became
  // recurring is refused rather than edited (or duplicated by a blind create).
  let series = obj["cmd"] as? String == "upsert-series"
  let occurrence = obj["cmd"] as? String == "upsert-occurrence"
  let recurrence = (obj["seriesRule"] as? [String: Any]).flatMap { nativeRule($0) }
  if series && recurrence == nil { respondError(id: id, "invalid native recurrence", code: "invalid-scheduling"); return }
  var selected: EKEvent?
  if occurrence {
    guard let original = obj["original"] as? String, let anchor = obj["anchor"] as? String, let wantId = markerIdentity(marker) else { respondError(id: id, "missing occurrence identity"); return }
    let originalZone = (obj["originalTimezone"] as? String).flatMap { TimeZone(identifier: $0) } ?? TimeZone.current
    let originalDate: Date?
    if original.hasSuffix("Z") { let parser = ISO8601DateFormatter(); originalDate = parser.date(from: original) }
    else { originalDate = parseWall(original.count == 10 ? original + "T00:00" : original, originalZone, normalizeFloating: obj["originalTimezone"] == nil && original.count != 10) }
    guard let originalDate = originalDate, parseWall(anchor.count == 10 ? anchor + "T00:00" : anchor, originalZone, normalizeFloating: obj["originalTimezone"] == nil && anchor.count != 10) != nil else { respondError(id: id, "invalid occurrence identity"); return }
    let near = originalDate.addingTimeInterval(-86400), far = originalDate.addingTimeInterval(86400)
    let predicate = store.predicateForEvents(withStart: near, end: far, calendars: nil)
    var candidates = store.events(matching: predicate)
    if let eid = obj["eventId"] as? String, let hint = store.event(withIdentifier: eid) { candidates.insert(hint, at: 0) }
    selected = candidates.first { ev in
      guard let url = ev.url?.absoluteString, markerIdentity(url) == wantId else { return false }
      return abs((ev.occurrenceDate ?? ev.startDate).timeIntervalSince(originalDate)) < 1
    }
    if selected == nil && (obj["remove"] as? Bool) != true { respondError(id: id, "native occurrence missing; refusing to create a duplicate", code: "event-time-unrepresentable"); return }
    // Selection above is a fresh read, after the command-thread store reset.
    // A projected occurrence has the same timing safety gate as an ordinary
    // event, including removals. A stale event ID never grants permission to
    // overwrite an unrepresentable time that changed after Node's earlier read.
    if let selected = selected, let issue = eventTimingIssue(selected), (obj["allowTimeReplacement"] as? Bool) != true {
      respondError(id: id, "\(issue). Calendar occurrence preserved; correct its time before syncing through Aside.", code: "event-time-unrepresentable"); return
    }
    if (obj["remove"] as? Bool) == true {
      guard let selected = selected else { respond(id: id, result: ["eventId": ""]); return }
      do { try store.remove(selected, span: .thisEvent, commit: true); respond(id: id, result: ["eventId": selected.eventIdentifier ?? ""]) }
      catch { respondError(id: id, error.localizedDescription) }; return
    }
  }
  let event: EKEvent
  if let selected = selected { event = selected }
  else if !occurrence, let wantId = markerIdentity(marker),
    let existing = existingEvent(obj["eventId"] as? String, wantId, near: start, end: end, in: cal) {
    guard series || !isRecurring(existing) else {
      respondError(id: id, "event is part of a recurring series", code: "event-recurring")
      return
    }
    if let issue = eventTimingIssue(existing), (obj["allowTimeReplacement"] as? Bool) != true {
      respondError(id: id, "\(issue). Sync is blocked for this action; choose an unambiguous scheduled/timezone or correct the Calendar event.", code: "event-time-unrepresentable")
      return
    }
    event = existing
  } else {
    event = EKEvent(eventStore: store)
  }
  event.calendar = cal
  event.title = title
  event.isAllDay = allDay
  event.startDate = start
  // EventKit requires endDate >= startDate; a single all-day event uses the same
  // day (it spans by date, not time). All-day events are zone-agnostic.
  event.endDate = max(start, end)
  event.timeZone = allDay ? nil : tzId.flatMap { TimeZone(identifier: $0) }  // nil => floating
  event.url = URL(string: marker)
  event.notes = obj["notes"] as? String
  if series, let recurrence = recurrence { event.recurrenceRules = [recurrence] }

  do {
    try store.save(event, span: series ? .futureEvents : .thisEvent, commit: true)
    // A save with no resulting identifier would have the MCP cache an empty id and
    // later read the event as deleted — report it as a failure instead.
    guard let eventId = event.eventIdentifier, !eventId.isEmpty else {
      respondError(id: id, "event saved but no identifier was assigned")
      return
    }
    var result: [String: Any] = ["eventId": eventId]
    if let external = event.calendarItemExternalIdentifier { result["externalId"] = external }
    respond(id: id, result: result)
  } catch {
    respondError(id: id, error.localizedDescription)
  }
}

// Remove the event a marker points at, by cached id. In-domain: deletes only
// when the event still carries this action's marker — a stale id pointing at a
// hand-made or other-action event is left untouched. Idempotent: a missing event
// is reported as deleted:false, not an error.
func deleteEvent(id: Any?, _ obj: [String: Any]) {
  guard let eid = obj["eventId"] as? String else {
    respondError(id: id, "missing eventId")
    return
  }
  guard let event = store.event(withIdentifier: eid) else {
    respond(id: id, result: ["deleted": false])
    return
  }
  guard let marker = obj["marker"] as? String,
    let exUrl = event.url?.absoluteString,
    markerIdentity(exUrl) != nil, markerIdentity(exUrl) == markerIdentity(marker)
  else {
    respond(id: id, result: ["deleted": false])  // not ours — never touch it
    return
  }
  guard obj["cmd"] as? String == "delete-series" || !isRecurring(event) else {
    respondError(id: id, "event is part of a recurring series", code: "event-recurring")
    return
  }
  if let issue = eventTimingIssue(event) {
    respondError(id: id, "\(issue). Calendar event preserved; correct its time before removing it through Aside.", code: "event-time-unrepresentable")
    return
  }
  do {
    try store.remove(event, span: obj["cmd"] as? String == "delete-series" ? .futureEvents : .thisEvent, commit: true)
    respond(id: id, result: ["deleted": true])
  } catch {
    respondError(id: id, error.localizedDescription)
  }
}

// Wire shape for an Aside-marked event: wall times in its named zone (or
// current zone when floating), explicit zone/null, and actual epoch milliseconds.
// `allDay` lets the reverse diff ignore the
// time of date-only events; `recurring` tells the MCP the event joined a
// recurring series and must not be touched.
func eventDict(_ ev: EKEvent) -> [String: Any] {
  let evZone = ev.timeZone ?? TimeZone.current
  var dict: [String: Any] = [
    "id": ev.eventIdentifier ?? "",
    "url": ev.url?.absoluteString ?? "",
    "calendar": ev.calendar?.title ?? "",
    "calendar_account": ev.calendar?.source?.title ?? "local",
    "title": ev.title ?? "",
    "start": isoWall(ev.startDate, evZone),
    "end": isoWall(ev.endDate, evZone),
    "allDay": ev.isAllDay,
    "startInstant": ev.startDate.timeIntervalSince1970 * 1000,
    "endInstant": ev.endDate.timeIntervalSince1970 * 1000,
  ]
  if !ev.isAllDay, let zone = ev.timeZone { dict["timezone"] = zone.identifier }
  else { dict["timezone"] = NSNull() }
  if !ev.isAllDay { dict["durationMinutes"] = ev.endDate.timeIntervalSince(ev.startDate) / 60 }
  if isRecurring(ev) { dict["recurring"] = true }
  if let external = ev.calendarItemExternalIdentifier { dict["externalId"] = external }
  if ev.isDetached { dict["detached"] = true }
  if let original = ev.occurrenceDate {
    dict["originalInstant"] = original.timeIntervalSince1970 * 1000
    dict["originalLocal"] = isoWall(original, TimeZone.current)
    if ev.isAllDay { dict["original"] = String(isoWall(original, evZone).prefix(10)) }
    else if ev.timeZone != nil { let formatter = ISO8601DateFormatter(); dict["original"] = formatter.string(from: original) }
    else { dict["original"] = isoWall(original, evZone) }
  }
  if let notes = ev.notes, notes.hasPrefix("Aside occurrence: ") { dict["original"] = String(notes.dropFirst("Aside occurrence: ".count).prefix { $0 != "\n" }) }
  if let rule = ev.recurrenceRules?.first { dict["seriesRule"] = ruleDict(rule) }
  return dict
}

// Aside-marked events (url `aside://…`) in a date range, for the cache-building
// sweep. Hand-made events have no such marker and are never returned.
func listEvents(id: Any?, _ obj: [String: Any]) {
  let zone = TimeZone.current
  guard let startStr = obj["start"] as? String, let endStr = obj["end"] as? String,
    let start = parseWall(startStr, zone), let end = parseWall(endStr, zone)
  else {
    respondError(id: id, "missing/invalid start/end")
    return
  }
  let all = store.calendars(for: .event)
  let names = obj["calendars"] as? [String]
  let cals = (names?.isEmpty == false) ? all.filter { names!.contains($0.title) } : all
  if cals.isEmpty {
    respond(id: id, result: ["events": []])
    return
  }
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: cals)
  let items: [[String: Any]] = store.events(matching: predicate).compactMap { ev in
    guard let url = ev.url?.absoluteString, url.hasPrefix("aside://") else { return nil }
    return eventDict(ev)
  }
  respond(id: id, result: ["events": items])
}

// Re-fetch tracked events by id for the incremental reverse reconcile. Returns
// only those that still exist and are still Aside-marked; a cached id that's
// absent from the result was deleted (or unmarked) in the calendar.
func getEvents(id: Any?, _ obj: [String: Any]) {
  guard let ids = obj["eventIds"] as? [String] else {
    respondError(id: id, "missing eventIds")
    return
  }
  let items: [[String: Any]] = ids.compactMap { eid in
    guard let ev = store.event(withIdentifier: eid),
      let url = ev.url?.absoluteString, url.hasPrefix("aside://")
    else { return nil }
    return eventDict(ev)
  }
  respond(id: id, result: ["events": items])
}

// Fetch physical family items through EventKit's native identifiers, including
// detached items a provider exposes with the same external identifier. Exact
// occurrence reads cover known gestures even when moved far from their origin.
// No discovery horizon is coupled to Aside's projection lookahead.
func getSeries(id: Any?, _ obj: [String: Any]) {
  guard let marker = obj["marker"] as? String, let want = markerIdentity(marker), let start = obj["start"] as? String else { respondError(id: id, "missing series marker/start"); return }
  let zone = (obj["timezone"] as? String).flatMap { TimeZone(identifier: $0) } ?? TimeZone.current
  var events: [String: [String: Any]] = [:]
  var externalIds = Set<String>()
  func add(_ event: EKEvent, head: Bool = false) {
    guard let url = event.url?.absoluteString, markerIdentity(url) == want else { return }
    let key = "\(event.eventIdentifier ?? ""):\((event.occurrenceDate ?? event.startDate).timeIntervalSince1970)"
    var value = eventDict(event)
    if head && !event.isDetached { value["seriesHead"] = true }
    if events[key]?["seriesHead"] as? Bool == true { value["seriesHead"] = true }
    events[key] = value
    if let external = event.calendarItemExternalIdentifier { externalIds.insert(external) }
  }
  func lookup(_ value: String, _ valueZone: TimeZone, byOriginal: Bool = false) {
    let date: Date?
    if value.hasSuffix("Z") { date = ISO8601DateFormatter().date(from: value) }
    else { date = parseWall(value.count == 10 ? value + "T00:00" : value, valueZone, normalizeFloating: true) }
    guard let date = date else { return }
    let predicate = store.predicateForEvents(withStart: date.addingTimeInterval(-86400), end: date.addingTimeInterval(86400), calendars: nil)
    // The date predicate is only a locator. Keep the exact witness, rather
    // than adopting adjacent projections and growing the discovery range on
    // every subsequent change notification.
    for event in store.events(matching: predicate) {
      let candidate = byOriginal ? event.occurrenceDate ?? event.startDate : event.startDate
      if abs(candidate!.timeIntervalSince(date)) < 1 { add(event) }
    }
  }
  lookup(start, zone)
  if let eventId = obj["eventId"] as? String, let event = store.event(withIdentifier: eventId) { add(event, head: true) }
  if let external = obj["externalId"] as? String { externalIds.insert(external) }
  for occurrence in obj["occurrences"] as? [[String: Any]] ?? [] {
    let originalZone = (occurrence["timezone"] as? String).flatMap { TimeZone(identifier: $0) } ?? TimeZone.current
    if let original = occurrence["original"] as? String { lookup(original, originalZone, byOriginal: true) }
    if let moved = occurrence["start"] as? String { lookup(moved, originalZone) }
    if let eventId = occurrence["eventId"] as? String, let event = store.event(withIdentifier: eventId) { add(event, head: !event.isDetached) }
  }
  var searched = Set<String>()
  while let external = externalIds.subtracting(searched).first {
    searched.insert(external)
    for item in store.calendarItems(withExternalIdentifier: external) { if let event = item as? EKEvent { add(event, head: true) } }
  }
  respond(id: id, result: ["events": Array(events.values)])
}

func handle(_ line: String) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return }
  guard let data = trimmed.data(using: .utf8),
    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    respondError(id: nil, "invalid JSON request")
    return
  }
  let id = obj["id"]
  guard let cmd = obj["cmd"] as? String else {
    respondError(id: id, "missing cmd")
    return
  }
  // On the command thread: refresh the store if a change landed since the last
  // command, so reads reflect the calendar's current state, not a stale cache.
  resetStoreIfDirty()
  switch cmd {
  case "auth-status":
    respond(id: id, result: ["status": authStatusString(EKEventStore.authorizationStatus(for: .event))])
  case "request-access":
    requestAccess(id: id)
  case "list-calendars":
    listCalendars(id: id)
  case "upsert-event", "upsert-series", "upsert-occurrence":
    upsertEvent(id: id, obj)
  case "delete-event", "delete-series":
    deleteEvent(id: id, obj)
  case "list-events":
    listEvents(id: id, obj)
  case "get-events":
    getEvents(id: id, obj)
  case "get-series":
    getSeries(id: id, obj)
  default:
    respondError(id: id, "unknown command: \(cmd)")
  }
}

// Push a coarse `changed` signal whenever the calendar store mutates (including
// our own writes — the MCP's compare-before-write drops those). Needs the main
// run loop below to fire. `object: nil` — EKEventStoreChanged isn't reliably
// posted with our store as the notification object, so filtering by it drops
// edits; we have a single store, so there's nothing else to confuse it with.
// `queue: nil` runs the block synchronously on the posting thread (it only takes
// locks and writes stdout, never touches the store), so it doesn't depend on an
// OperationQueue being drained.
NotificationCenter.default.addObserver(
  forName: .EKEventStoreChanged, object: nil, queue: nil
) { _ in
  debugLog("EKEventStoreChanged received")
  markStoreDirty()  // the command thread resets before its next fetch
  emit(["signal": "changed"])
}
debugLog("started; observing EKEventStoreChanged")

// Read and process commands off the main thread so the main run loop is free to
// receive EventKit's change notifications (delivered through it). stdin close ends
// the session. This single serial loop is the ONLY place EventKit is touched — the
// store is not thread-safe, so command handling must stay on one thread (the
// observer above only emits, never calls EventKit). Don't parallelize this.
// Each command runs in its own autoreleasepool: EventKit autoreleases the
// objects it returns, and this thread never drains the pool on its own — a
// long session would otherwise accumulate every fetched event.
DispatchQueue.global(qos: .utility).async {
  while let line = readLine(strippingNewline: true) {
    autoreleasepool { handle(line) }
  }
  exit(0)
}

// Run the main CFRunLoop, NOT dispatchMain(): EventKit delivers EKEventStoreChanged
// through the main run loop, which dispatchMain() does not service — under it the
// change observer never fires, so reverse sync never sees calendar edits. The port
// keeps the loop alive until EventKit attaches its own source (without a source,
// run() would return immediately and the process would exit). stdin close still
// terminates via exit(0) in the command loop above.
RunLoop.main.add(NSMachPort(), forMode: .default)
RunLoop.main.run()
