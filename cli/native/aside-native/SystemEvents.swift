import AppKit
import Foundation
import Darwin

enum SystemEventsService {
  private static func emit(_ event: String) {
    let zone = TimeZone.autoupdatingCurrent.identifier
    print("\(event)\t\(zone)")
    fflush(stdout)
  }

  @MainActor
  static func run() {
    let workspace = NSWorkspace.shared.notificationCenter
    workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in emit("sleep") }
    workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in emit("wake") }
    NotificationCenter.default.addObserver(forName: .NSSystemClockDidChange, object: nil, queue: .main) { _ in emit("clock") }
    NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { _ in
      NSTimeZone.resetSystemTimeZone()
      emit("timezone")
    }
    emit("ready")
    // stdin EOF ends this mode, including when its owning daemon exits.
    DispatchQueue.global().async {
      while readLine() != nil {}
      exit(0)
    }
    RunLoop.main.add(NSMachPort(), forMode: .default)
    RunLoop.main.run()
  }
}
