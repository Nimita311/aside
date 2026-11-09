import Foundation
import CoreLocation
import MapKit
import Darwin

private struct PolicyFailure: Error, CustomStringConvertible {
  let description: String
}

@main
private enum NativeGeocodingPolicyTests {
  @MainActor
  static func main() async {
    // Only invalid requests use the production decoder. All searches in the
    // policy checks below are injected closures, with no provider network use.
    if CommandLine.arguments.dropFirst().first == "request" {
      await GeocodingService.run()
      return
    }
    do {
      try await policy()
      print("native geocoding policy passed")
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      exit(1)
    }
  }

  private static func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw PolicyFailure(description: message) }
  }

  @MainActor
  private static func policy() async throws {
    let text = "Tartine Bakery, 600 Guerrero St, San Francisco"
    let hint = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 37.76, longitude: -122.42),
                                  span: MKCoordinateSpan(latitudeDelta: 0.1, longitudeDelta: 0.2))
    let native = GeocodeLookup.searchRequest(query: text, region: hint)
    try require(native.naturalLanguageQuery == text, "The native request changed the query text.")
    try require(native.resultTypes == [.address, .pointOfInterest], "One search must include both addresses and POIs.")
    try require(native.region.center.latitude == hint.center.latitude
      && native.region.center.longitude == hint.center.longitude
      && native.region.span.latitudeDelta == hint.span.latitudeDelta
      && native.region.span.longitudeDelta == hint.span.longitudeDelta, "The native request changed the region hint.")
    let unhinted = GeocodeLookup.searchRequest(query: "10 Downing Street, London")
    try require(unhinted.resultTypes == [.address, .pointOfInterest], "Unhinted queries must also search both result types.")

    let ordered = ["first candidate", "second candidate", "third candidate"]
    var calls: [String] = []
    let result: [String] = try await GeocodeLookup.resolve(query: " \(text) \n", search: { query in
      calls.append(query)
      return ordered
    })
    try require(result == ordered && calls == [text], "A search must receive trimmed text once and retain every candidate in order.")

    calls = []
    let empty: [String] = try await GeocodeLookup.resolve(query: text, search: { query in
      calls.append(query)
      return []
    })
    try require(empty.isEmpty && calls == [text], "Empty results must not start another lookup.")

    let failures: [Error] = [
      NSError(domain: MKError.errorDomain, code: Int(MKError.Code.placemarkNotFound.rawValue)),
      NSError(domain: MKError.errorDomain, code: Int(MKError.Code.serverFailure.rawValue)),
      NSError(domain: MKError.errorDomain, code: Int(MKError.Code.loadingThrottled.rawValue)),
      NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost),
      NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled),
      CancellationError(),
    ]
    for failure in failures {
      calls = []
      do {
        let _: [String] = try await GeocodeLookup.resolve(query: text, search: { query in
          calls.append(query)
          throw failure
        })
        throw PolicyFailure(description: "Search failures must propagate.")
      } catch {
        let actual = error as NSError, expected = failure as NSError
        try require(actual.domain == expected.domain && actual.code == expected.code, "The native search error was replaced.")
      }
      try require(calls == [text], "Not-found, network, throttling and cancellation must never retry.")
    }

    calls = []
    let cancelled = Task { @MainActor () throws -> [String] in
      try await GeocodeLookup.resolve(query: text, search: { query in
        calls.append(query)
        return ordered
      })
    }
    cancelled.cancel()
    do {
      _ = try await cancelled.value
      throw PolicyFailure(description: "Already-cancelled work must stop.")
    } catch is CancellationError {}
    try require(calls.isEmpty, "Already-cancelled work invoked search.")

    calls = []
    let cancelledDuring = Task { @MainActor () throws -> [String] in
      try await GeocodeLookup.resolve(query: text, search: { query in
        calls.append(query)
        withUnsafeCurrentTask { $0?.cancel() }
        return ordered
      })
    }
    do {
      _ = try await cancelledDuring.value
      throw PolicyFailure(description: "Cancelled work must not return candidate data.")
    } catch is CancellationError {}
    try require(calls == [text], "Cancellation started another lookup.")

    for invalid in ["", " \n\t ", "a\0b", String(repeating: "x", count: 4097)] {
      var rejected = false
      var searched = false
      do {
        let _: [String] = try await GeocodeLookup.resolve(query: invalid, search: { _ in
          searched = true
          return []
        })
      } catch { rejected = true }
      try require(rejected && !searched, "Invalid query text reached search.")
    }
    try require(GeocodeLookup.isNoResults(NSError(domain: MKError.errorDomain, code: Int(MKError.Code.placemarkNotFound.rawValue))),
                "MapKit not-found must retain its no-results classification.")
    try require(!GeocodeLookup.isNoResults(NSError(domain: MKError.errorDomain, code: Int(MKError.Code.serverFailure.rawValue))),
                "Server failures must not become no-results responses.")
  }
}
