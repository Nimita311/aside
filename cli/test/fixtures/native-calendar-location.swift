import Foundation
import CoreFoundation
import CoreLocation
import EventKit
import ObjectiveC

// All events are unsaved. This store double intercepts every Calendar query
// and write, so running the production command path needs no access grant.
let backing = EKEventStore()
class WritableCalendar: EKCalendar {
  override var allowsContentModifications: Bool { true }
}
class IdentifiedEvent: EKEvent {
  override var eventIdentifier: String! { "fixture-event" }
}
let calendar = EKCalendar(for: .event, eventStore: backing)
object_setClass(calendar, WritableCalendar.self)
calendar.title = "Work"
var selected: EKEvent?
var writes = 0
var errors: [String] = []
var result: [String: Any] = [:]
var savedSpan: EKSpan?
func fixtureEvent() -> EKEvent {
  let event = EKEvent(eventStore: backing)
  object_setClass(event, IdentifiedEvent.self)
  return event
}
struct FakeStore {
  func calendars(for type: EKEntityType) -> [EKCalendar] { [calendar] }
  func event(withIdentifier id: String) -> EKEvent? { id == "fixture-event" ? selected : nil }
  func predicateForEvents(withStart: Date, end: Date, calendars: [EKCalendar]?) -> NSPredicate { NSPredicate(value: true) }
  func events(matching predicate: NSPredicate) -> [EKEvent] { selected.map { [$0] } ?? [] }
  func remove(_ event: EKEvent, span: EKSpan, commit: Bool) throws { fatalError("No test may remove an event.") }
  func save(_ event: EKEvent, span: EKSpan, commit: Bool) throws { selected = event; writes += 1; savedSpan = span }
}
let store = FakeStore()
func respond(id: Any?, result value: [String: Any]) { result = value }
func respondError(id: Any?, _ message: String, code: String? = nil) { errors.append(code ?? message) }

// ASIDE_CALENDAR_FUNCTIONS

let base: [String: Any] = ["cmd": "upsert-event", "calendar": "Work", "marker": "aside://work/action/review",
  "title": "Review", "start": "2026-10-09T09:00", "end": "2026-10-09T09:30", "timezone": "UTC", "durationMinutes": 30]
func request(_ location: Any? = nil, extras: [String: Any] = [:]) {
  var args = base
  args["eventId"] = selected?.eventIdentifier
  if let location = location { args["location"] = location }
  for (key, value) in extras { args[key] = value }
  let previousErrors = errors.count, previousWrites = writes
  upsertEvent(id: "probe", args)
  precondition(errors.count == previousErrors, "Unexpected native error: \(errors)")
  precondition(writes == previousWrites + 1, "The fake store did not receive exactly one save.")
}
func venue() -> [String: Any] { eventDict(selected!)["location"] as! [String: Any] }
func checkPoint(_ value: [String: Any], latitude: Double, longitude: Double) {
  precondition(value["latitude"] as? Double == latitude && value["longitude"] as? Double == longitude)
}

let name = CommandLine.arguments.dropFirst().first ?? ""
switch name {
case "postal":
  request(["title": "10 Downing Street, London"])
  precondition(selected!.location == "10 Downing Street, London")
  precondition(selected!.structuredLocation!.geoLocation == nil)
  precondition(venue()["title"] as? String == "10 Downing Street, London")
  precondition(venue()["latitude"] == nil && venue()["longitude"] == nil && venue()["altitude"] == nil)
  precondition(selected!.structuredLocation!.radius == 0)
case "point":
  request(["title": "51.5034, -0.1276", "latitude": 51.5034, "longitude": -0.1276])
  checkPoint(venue(), latitude: 51.5034, longitude: -0.1276)
  precondition(venue()["title"] as? String == "51.5034, -0.1276")
  precondition(venue()["altitude"] == nil, "A coordinate-only point must not acquire default zero altitude.")
  request(["title": "Office", "latitude": 51.5034, "longitude": -0.1276, "altitude": -25.5])
  checkPoint(venue(), latitude: 51.5034, longitude: -0.1276)
  precondition(venue()["altitude"] as? Double == -25.5)
  precondition(selected!.location == "Office" && selected!.structuredLocation!.geoLocation!.altitude == -25.5)
  request(["title": "Sea level", "latitude": 0, "longitude": 0, "altitude": 0])
  precondition(venue()["altitude"] as? Double == 0, "Explicit zero altitude must remain distinct from absent altitude.")
case "preserve-clear":
  request(["title": "Office", "latitude": 51.5, "longitude": -0.1])
  let alarm = EKAlarm(relativeOffset: -900)
  selected!.alarms = [alarm]
  request()
  checkPoint(venue(), latitude: 51.5, longitude: -0.1)
  precondition(venue()["title"] as? String == "Office")
  precondition(selected!.alarms?.count == 1 && selected!.alarms!.first!.relativeOffset == -900)
  request(NSNull())
  precondition(selected!.structuredLocation == nil && eventDict(selected!)["location"] is NSNull)
  precondition(selected!.alarms?.count == 1 && selected!.alarms!.first!.relativeOffset == -900)
  request(["title": "Address only"])
  precondition(selected!.structuredLocation!.geoLocation == nil && selected!.location == "Address only")
  precondition(selected!.alarms?.count == 1 && selected!.alarms!.first!.relativeOffset == -900)
case "invalid":
  request(["title": "Original", "latitude": 51.5, "longitude": -0.1])
  let invalid: [Any] = [
    "Office", true, [], [:], ["title": 1], ["title": NSNull()],
    ["title": "Office", "latitude": 1], ["title": "Office", "longitude": 1],
    ["title": "Office", "latitude": true, "longitude": 0],
    ["title": "Office", "latitude": "1", "longitude": 0],
    ["title": "Office", "latitude": 91, "longitude": 0],
    ["title": "Office", "latitude": 0, "longitude": -181],
    ["title": "Office", "latitude": Double.nan, "longitude": 0],
    ["title": "Office", "latitude": 0, "longitude": Double.infinity],
    ["title": "Office", "altitude": 12],
    ["title": "Office", "latitude": 0, "longitude": 0, "altitude": true],
    ["title": "Office", "latitude": 0, "longitude": 0, "altitude": Double.nan],
    ["title": "Office", "latitude": 0, "longitude": 0, "altitude": NSNull()],
    ["title": "Office", "radius": 100],
  ]
  let previousWrites = writes
  for location in invalid {
    var args = base; args["location"] = location
    upsertEvent(id: "invalid", args)
  }
  precondition(writes == previousWrites, "Invalid locations must not reach save.")
  precondition(errors == Array(repeating: "invalid-scheduling", count: invalid.count))
  precondition(venue()["title"] as? String == "Original")
  checkPoint(venue(), latitude: 51.5, longitude: -0.1)
case "recurrence":
  request(["title": "Series office", "latitude": 1, "longitude": 2], extras: ["cmd": "upsert-series", "seriesRule": ["frequency": "daily", "interval": 1]])
  precondition(selected!.hasRecurrenceRules && savedSpan == .futureEvents)
  precondition(venue()["title"] as? String == "Series office")
  request(["title": "Occurrence office", "latitude": 3, "longitude": 4], extras: ["cmd": "upsert-occurrence",
    "original": "2026-10-09T09:00:00Z", "originalTimezone": "UTC", "anchor": "2026-10-09T09:00"])
  precondition(savedSpan == .thisEvent)
  checkPoint(venue(), latitude: 3, longitude: 4)
  precondition(venue()["title"] as? String == "Occurrence office")
case "readback":
  precondition(locationDict(nil) == nil)
  let native = EKStructuredLocation(title: "Calendar address")
  native.geoLocation = CLLocation(coordinate: CLLocationCoordinate2D(latitude: -90, longitude: 180),
    altitude: 43, horizontalAccuracy: 100, verticalAccuracy: -1, timestamp: Date())
  let value = locationDict(native)!
  checkPoint(value, latitude: -90, longitude: 180)
  precondition(value["altitude"] == nil)
  precondition(value["title"] as? String == "Calendar address")
  request(NSNull())
  precondition(eventDict(selected!)["location"] is NSNull)
  selected!.structuredLocation = native
  checkPoint(venue(), latitude: -90, longitude: 180)
  precondition(venue()["title"] as? String == "Calendar address")
  precondition(venue()["altitude"] == nil)
default:
  fatalError("Unknown fixture case: \(name)")
}
print("native Calendar location \(name) passed")
