import AppKit
import Foundation
import Darwin

enum DesktopService {
  @MainActor
  static func pickInstance(kind: String) {
    // The dispatcher validates kind before this mode creates any UI objects.
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.canChooseDirectories = kind == "directory"
    panel.canChooseFiles = kind == "manifest"
    panel.title = kind == "directory" ? "Choose your Aside instance folder" : "Choose an existing aside.md manifest"
    panel.prompt = "Choose"
    application.activate(ignoringOtherApps: true)
    guard panel.runModal() == .OK else { return }
    guard let selected = panel.url, selected.isFileURL else {
      fail("The native picker did not return a file path.")
    }
    // Registration and exact aside.md validation stay with the caller.
    print(selected.path)
  }

  @MainActor
  static func defaultBrowser() {
    // Resolve the HTTP handler even when the caller will open a private HTML
    // handoff, because .html files may be associated with an editor.
    guard let probe = URL(string: "http://localhost"),
          let application = NSWorkspace.shared.urlForApplication(toOpen: probe),
          application.isFileURL,
          application.path.hasSuffix(".app") else {
      fail("No application is registered as the default HTTP browser.")
    }
    print(application.path)
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
  }
}
