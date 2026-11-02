import AppKit
import Foundation

func emit(_ event: String) {
    let zone = TimeZone.autoupdatingCurrent.identifier
    print("\(event)\t\(zone)")
    fflush(stdout)
}
let workspace = NSWorkspace.shared.notificationCenter
workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in emit("sleep") }
workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in emit("wake") }
NotificationCenter.default.addObserver(forName: .NSSystemClockDidChange, object: nil, queue: .main) { _ in emit("clock") }
NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { _ in
    NSTimeZone.resetSystemTimeZone()
    emit("timezone")
}
emit("ready")
// The daemon owns the helper: stdin EOF ends it, including daemon death.
DispatchQueue.global().async {
    while readLine() != nil {}
    exit(0)
}
RunLoop.main.run()
