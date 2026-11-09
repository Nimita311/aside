// aside-native geocode — one key-free Apple location lookup over JSON stdin.
// The caller owns request timeouts and retry policy. This helper never asks for
// the device's location, writes records, or chooses between native candidates.

import Contacts
import CoreLocation
import Foundation
import MapKit

private struct RegionHint: Decodable {
  let latitude: Double
  let longitude: Double
  let radiusMeters: Double

  func validate() throws {
    guard latitude.isFinite, (-90...90).contains(latitude),
          longitude.isFinite, (-180...180).contains(longitude),
          radiusMeters.isFinite, radiusMeters > 0, radiusMeters <= 20_000_000 else {
      throw RequestError.invalid("Region requires valid latitude/longitude and a radius greater than 0 and at most 20000000 meters.")
    }
  }

  var center: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
  }

  var mapRegion: MKCoordinateRegion {
    // The API accepts a rectangular search region. Bound its span for large
    // radii and polar centers; this is a search hint, not a result filter.
    var region = MKCoordinateRegion(center: center,
                                    latitudinalMeters: radiusMeters * 2,
                                    longitudinalMeters: radiusMeters * 2)
    region.span.latitudeDelta = region.span.latitudeDelta.isFinite
      ? min(180, max(0, region.span.latitudeDelta)) : 180
    region.span.longitudeDelta = region.span.longitudeDelta.isFinite
      ? min(360, max(0, region.span.longitudeDelta)) : 360
    return region
  }
}

private struct GeocodeRequest: Decodable {
  let query: String
  let region: RegionHint?

  func validated() throws -> GeocodeRequest {
    let query = try GeocodeLookup.normalizedQuery(query)
    try region?.validate()
    return GeocodeRequest(query: query, region: region)
  }
}

private enum RequestError: Error {
  case invalid(String)
}

private struct Candidate: Encodable {
  let latitude: Double
  let longitude: Double
  let formattedAddress: String?
  let name: String?
  let countryCode: String?

  init?(coordinate: CLLocationCoordinate2D, formattedAddress: String?, name: String?, countryCode: String?) {
    guard coordinate.latitude.isFinite, (-90...90).contains(coordinate.latitude),
          coordinate.longitude.isFinite, (-180...180).contains(coordinate.longitude) else { return nil }
    latitude = coordinate.latitude
    longitude = coordinate.longitude
    self.formattedAddress = Self.nonempty(formattedAddress)
    self.name = Self.nonempty(name)
    self.countryCode = Self.nonempty(countryCode)
  }

  private static func nonempty(_ text: String?) -> String? {
    guard let value = text?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    return value
  }
}

private struct Response: Encodable {
  let status: String
  let candidates: [Candidate]
  let error: String?
}

// Validate and configure the single search path separately from network access.
// Tests can exercise real request configuration and inject only the transport.
enum GeocodeLookup {
  static func normalizedQuery(_ query: String) throws -> String {
    let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.count <= 4096,
          !text.unicodeScalars.contains(where: { $0.value == 0 }) else {
      throw RequestError.invalid("Query must contain 1 through 4096 characters and no NUL character.")
    }
    return text
  }

  static func isNoResults(_ error: Error) -> Bool {
    let native = error as NSError
    return native.domain == MKError.errorDomain && native.code == MKError.Code.placemarkNotFound.rawValue
  }

  @MainActor
  static func searchRequest(query: String, region: MKCoordinateRegion? = nil) -> MKLocalSearch.Request {
    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = query
    request.resultTypes = [.address, .pointOfInterest]
    if let region { request.region = region }
    // Region remains a hint. MapKit provides no per-request locale control.
    return request
  }

  @MainActor
  static func resolve<Value>(query: String,
                             search: (_ text: String) async throws -> [Value]) async throws -> [Value] {
    let text = try normalizedQuery(query)
    try Task.checkCancellation()
    let candidates = try await search(text)
    try Task.checkCancellation()
    return candidates
  }
}

enum GeocodingService {
  @MainActor
  static func run() async {
    do {
      let request = try readRequest()
      let candidates = try await GeocodeLookup.resolve(query: request.query,
        search: { text in try await localSearch(text, region: request.region?.mapRegion) })
      emit(Response(status: candidates.isEmpty ? "NO_RESULTS" : "SUCCESS", candidates: candidates, error: nil))
    } catch RequestError.invalid(let message) {
      emit(Response(status: "FAILED", candidates: [], error: message))
    } catch {
      let native = error as NSError
      if GeocodeLookup.isNoResults(error) {
        emit(Response(status: "NO_RESULTS", candidates: [], error: nil))
      } else {
        // Native descriptions/userInfo may include the searched address. Keep
        // the protocol useful without reflecting private query text in errors.
        emit(Response(status: "FAILED", candidates: [], error: "Apple geocoding failed (\(native.domain), code \(native.code))."))
      }
    }
  }

  private static func readRequest() throws -> GeocodeRequest {
    var input = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
      input.append(chunk)
      guard input.count <= 65_536 else { throw RequestError.invalid("Request JSON exceeds 65536 bytes.") }
    }
    guard let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
          object.keys.allSatisfy({ ["query", "region"].contains($0) }),
          let request = try? JSONDecoder().decode(GeocodeRequest.self, from: input) else {
      throw RequestError.invalid("Expected one JSON object with a query string and optional region.")
    }
    return try request.validated()
  }

  @MainActor
  private static func localSearch(_ query: String, region: MKCoordinateRegion?) async throws -> [Candidate] {
    let request = GeocodeLookup.searchRequest(query: query, region: region)
    let search = MKLocalSearch(request: request)
    let response = try await search.start()
    return response.mapItems.compactMap { candidate(for: $0) }
  }

  @MainActor
  private static func candidate(for item: MKMapItem) -> Candidate? {
    #if ASIDE_MAPKIT_ADDRESS_FORMATTING
    if #available(macOS 26.0, *) {
      return Candidate(coordinate: item.location.coordinate,
                       formattedAddress: item.address?.fullAddress,
                       name: item.name,
                       countryCode: item.addressRepresentations?.region?.identifier)
    }
    #endif
    return candidate(for: item.placemark, name: item.name)
  }

  private static func candidate(for placemark: CLPlacemark, name: String?) -> Candidate? {
    guard let coordinate = placemark.location?.coordinate else { return nil }
    let address = placemark.postalAddress.map {
      CNPostalAddressFormatter.string(from: $0, style: .mailingAddress)
    }
    return Candidate(coordinate: coordinate, formattedAddress: address,
                     name: name, countryCode: placemark.isoCountryCode)
  }

  private static func emit(_ response: Response) {
    guard var data = try? JSONEncoder().encode(response) else {
      FileHandle.standardOutput.write(Data("{\"status\":\"FAILED\",\"candidates\":[],\"error\":\"Could not encode geocoding response.\"}\n".utf8))
      return
    }
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
  }
}
