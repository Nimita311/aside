// One executable, independent per-mode lifetimes and stdout protocols.
import Foundation
import Darwin

@main
private enum AsideNative {
  @MainActor
  static func main() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let mode = arguments.first else { usage() }
    switch mode {
    case "calendar":
      guard arguments.count == 1 else { usage() }
      runCalendar()
    case "system-events":
      guard arguments.count == 1 else { usage() }
      SystemEventsService.run()
    case "geocode":
      guard arguments.count == 1 else { usage() }
      Task { @MainActor in
        await GeocodingService.run()
        exit(0)
      }
      // Service the main actor while its one-shot native request is pending.
      RunLoop.main.add(NSMachPort(), forMode: .default)
      RunLoop.main.run()
    case "pick-instance":
      guard arguments.count == 2, ["directory", "manifest"].contains(arguments[1]) else { usage() }
      DesktopService.pickInstance(kind: arguments[1])
    case "default-browser":
      guard arguments.count == 1 else { usage() }
      DesktopService.defaultBrowser()
    default:
      usage()
    }
  }

  private static func usage() -> Never {
    FileHandle.standardError.write(Data("Usage: aside-native calendar|geocode|system-events|pick-instance directory|manifest|default-browser\n".utf8))
    exit(64)
  }
}
