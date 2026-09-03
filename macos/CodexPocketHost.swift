import AppKit
import Darwin
import Foundation

private struct RuntimeRecord: Decodable {
    let pid: Int32
    let localUrl: String
    let controlUrl: String
}

private struct QuotaWindow: Decodable {
    let label: String
    let remainingPercent: Double
    let resetsAt: Double?
}

private struct QuotaStatus: Decodable {
    let available: Bool
    let stale: Bool
    let windows: [QuotaWindow]
}

private struct HostStatus: Decodable {
    let running: Bool
    let hostName: String
    let localUrl: String
    let phoneUrls: [String]
    let quota: QuotaStatus
}

final class PocketHost: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let fileManager = FileManager.default
    private lazy var projectURL = Bundle.main.bundleURL.deletingLastPathComponent()
    private lazy var runtimeURL = projectURL.appendingPathComponent(".codex-pocket.runtime.json")
    private lazy var quitMarkerURL = projectURL.appendingPathComponent(".codex-pocket.quit")
    private lazy var gatewayURL = projectURL.appendingPathComponent("gateway.ts")
    private lazy var logURL = projectURL.appendingPathComponent(".codex-pocket.log")
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var status: HostStatus?
    private var gatewayProcess: Process?
    private var healthCheckRunning = false
    private var consecutiveFailures = 0
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "local.codex-pocket.launcher")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty {
            NSApp.terminate(nil)
            return
        }

        NSApp.setActivationPolicy(.accessory)
        try? fileManager.removeItem(at: quitMarkerURL)
        installStatusItem()
        ensureGateway()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshStatus()
    }

    private func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "network", accessibilityDescription: "Codex Pocket")
        statusItem.button?.image?.isTemplate = true
        statusItem.button?.toolTip = "Codex Pocket"
        rebuildMenu()
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        menu.addItem(disabledItem("Codex Pocket"))
        menu.addItem(disabledItem(status == nil ? "Starting…" : "Running"))
        menu.addItem(.separator())
        menu.addItem(disabledItem("Quota"))
        if let quota = status?.quota, quota.available, !quota.windows.isEmpty {
            for window in quota.windows {
                let percent = Int(window.remainingPercent.rounded())
                let reset = window.resetsAt.map { " · resets \(formatReset($0))" } ?? ""
                menu.addItem(disabledItem("\(window.label)    \(percent)% left\(reset)"))
            }
            if quota.stale { menu.addItem(disabledItem("Last known values")) }
        } else {
            menu.addItem(disabledItem("Quota unavailable"))
        }
        menu.addItem(.separator())
        menu.addItem(actionItem("Open Pocket", #selector(openPocket), enabled: status != nil))
        menu.addItem(actionItem("Copy Phone URL", #selector(copyPhoneURL), enabled: !(status?.phoneUrls.isEmpty ?? true)))
        menu.addItem(.separator())
        menu.addItem(actionItem("Quit Codex Pocket", #selector(quitPocket), enabled: !quitting))
        statusItem.menu = menu
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func actionItem(_ title: String, _ action: Selector, enabled: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.isEnabled = enabled
        return item
    }

    private func formatReset(_ milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = .current
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "EEE HH:mm"
        return formatter.string(from: date)
    }

    @objc private func openPocket() {
        guard let value = status, let url = URL(string: value.localUrl) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func copyPhoneURL() {
        guard let phoneURL = status?.phoneUrls.first else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(phoneURL, forType: .string)
    }

    @objc private func quitPocket() {
        guard !quitting else { return }
        quitting = true
        rebuildMenu()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let accepted = self.requestGatewayShutdown()
            if accepted {
                self.waitForGatewayExit()
                try? self.fileManager.removeItem(at: self.quitMarkerURL)
                DispatchQueue.main.async { NSApp.terminate(nil) }
            } else {
                DispatchQueue.main.async {
                    self.quitting = false
                    self.rebuildMenu()
                    self.showError("Codex Pocket could not stop its gateway. Check \(self.logURL.path) for details.")
                }
            }
        }
    }

    private func ensureGateway() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if let current = self.fetchHostStatus() {
                DispatchQueue.main.async { self.accept(current) }
                return
            }
            guard self.fileManager.fileExists(atPath: self.gatewayURL.path) else {
                DispatchQueue.main.async { self.failStartup("Could not find gateway.ts beside Codex Pocket.app.") }
                return
            }
            guard let node = self.findNode() else {
                DispatchQueue.main.async { self.failStartup("No usable Node.js runtime was found. Install Node.js 22.6 or newer, or keep ChatGPT/Codex installed.") }
                return
            }
            do {
                try self.startGateway(node: node)
            } catch {
                DispatchQueue.main.async { self.failStartup("Codex Pocket could not start: \(error.localizedDescription)") }
                return
            }
            for _ in 0..<80 {
                if let current = self.fetchHostStatus() {
                    DispatchQueue.main.async { self.accept(current) }
                    return
                }
                usleep(100_000)
            }
            DispatchQueue.main.async { self.failStartup("Codex Pocket could not start. Check \(self.logURL.path) for details.") }
        }
    }

    private func refreshStatus() {
        guard !healthCheckRunning, !quitting else { return }
        healthCheckRunning = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let quitRequested = self.fileManager.fileExists(atPath: self.quitMarkerURL.path)
            let current = self.fetchHostStatus()
            DispatchQueue.main.async {
                self.healthCheckRunning = false
                if quitRequested {
                    self.finishRemoteQuit()
                } else if let current {
                    self.accept(current)
                } else {
                    self.consecutiveFailures += 1
                    if self.consecutiveFailures >= 4 {
                        NSApp.terminate(nil)
                    } else {
                        self.status = nil
                        self.rebuildMenu()
                    }
                }
            }
        }
    }

    private func finishRemoteQuit() {
        guard !quitting else { return }
        quitting = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            self.waitForGatewayExit()
            try? self.fileManager.removeItem(at: self.quitMarkerURL)
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func accept(_ value: HostStatus) {
        guard value.running else { return }
        status = value
        consecutiveFailures = 0
        rebuildMenu()
    }

    private func failStartup(_ message: String) {
        showError(message)
        NSApp.terminate(nil)
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Codex Pocket"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
    }

    private func runtimeRecord() -> RuntimeRecord? {
        guard let data = try? Data(contentsOf: runtimeURL),
              let record = try? JSONDecoder().decode(RuntimeRecord.self, from: data),
              kill(record.pid, 0) == 0 else { return nil }
        return record
    }

    private func fetchHostStatus() -> HostStatus? {
        guard let record = runtimeRecord(),
              let url = URL(string: record.controlUrl + "/host-status") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        let semaphore = DispatchSemaphore(value: 0)
        var result: HostStatus?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data else { return }
            result = try? JSONDecoder().decode(HostStatus.self, from: data)
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1.5)
        return result
    }

    private func requestGatewayShutdown() -> Bool {
        guard let record = runtimeRecord(),
              let url = URL(string: record.controlUrl + "/shutdown") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 2
        let semaphore = DispatchSemaphore(value: 0)
        var accepted = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            accepted = (response as? HTTPURLResponse)?.statusCode == 202
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 2.5)
        return accepted
    }

    private func waitForGatewayExit() {
        for _ in 0..<40 {
            if runtimeRecord() == nil { return }
            usleep(100_000)
        }
    }

    private func startGateway(node: URL) throws {
        fileManager.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        try log.seekToEnd()
        let process = Process()
        process.executableURL = node
        process.arguments = ["--experimental-strip-types", gatewayURL.path]
        process.currentDirectoryURL = projectURL
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (environment["PATH"] ?? "")
        if let codex = findExecutable(paths: [
            "\(NSHomeDirectory())/.local/bin/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
        ]) {
            environment["CODEX_BIN"] = codex.path
        }
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log
        process.standardError = log
        try process.run()
        gatewayProcess = process
        try? log.close()
    }

    private func findNode() -> URL? {
        let pathCandidates = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map { "\($0)/node" }
        let paths = pathCandidates + [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(NSHomeDirectory())/.local/bin/node",
            "/usr/bin/node",
            "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
            "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
        ]
        for path in paths where fileManager.isExecutableFile(atPath: path) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: path)
            process.arguments = ["-e", "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            if (try? process.run()) != nil {
                process.waitUntilExit()
                if process.terminationStatus == 0 { return URL(fileURLWithPath: path) }
            }
        }
        return nil
    }

    private func findExecutable(paths: [String]) -> URL? {
        paths.first(where: fileManager.isExecutableFile(atPath:)).map(URL.init(fileURLWithPath:))
    }
}

let app = NSApplication.shared
let host = PocketHost()
app.delegate = host
app.run()
