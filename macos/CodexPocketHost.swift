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
    let updatedAt: Double?
}

private struct HostStatus: Decodable {
    let running: Bool
    let hostName: String
    let localUrl: String
    let phoneUrls: [String]
    let quota: QuotaStatus
}

private func pocketStatusImage() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        NSColor.black.setStroke()
        let pocket = NSBezierPath()
        pocket.lineWidth = 1.55
        pocket.lineCapStyle = .round
        pocket.lineJoinStyle = .round
        pocket.move(to: NSPoint(x: 3, y: 15))
        pocket.line(to: NSPoint(x: 15, y: 15))
        pocket.line(to: NSPoint(x: 15, y: 8))
        pocket.curve(to: NSPoint(x: 9, y: 2), controlPoint1: NSPoint(x: 15, y: 4.2), controlPoint2: NSPoint(x: 12.6, y: 2))
        pocket.curve(to: NSPoint(x: 3, y: 8), controlPoint1: NSPoint(x: 5.4, y: 2), controlPoint2: NSPoint(x: 3, y: 4.2))
        pocket.close()
        pocket.stroke()
        let prompt = NSBezierPath()
        prompt.lineWidth = 1.55
        prompt.lineCapStyle = .round
        prompt.lineJoinStyle = .round
        prompt.move(to: NSPoint(x: 5.7, y: 11.2))
        prompt.line(to: NSPoint(x: 8.3, y: 8.8))
        prompt.line(to: NSPoint(x: 5.7, y: 6.4))
        prompt.move(to: NSPoint(x: 10.1, y: 6.4))
        prompt.line(to: NSPoint(x: 13.2, y: 6.4))
        prompt.stroke()
        return true
    }
    image.isTemplate = true
    return image
}

private final class StatusMenuView: NSView {
    private let powerSwitch = NSSwitch()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Codex Pocket")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.translatesAutoresizingMaskIntoConstraints = false
        powerSwitch.translatesAutoresizingMaskIntoConstraints = false
        powerSwitch.controlSize = .small
        powerSwitch.setAccessibilityLabel("Pocket On")
        addSubview(title)
        addSubview(powerSwitch)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 260),
            heightAnchor.constraint(equalToConstant: 32),
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            powerSwitch.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            powerSwitch.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        update(isOn: true, enabled: true)
    }

    required init?(coder: NSCoder) { nil }

    func configure(target: AnyObject, action: Selector) {
        powerSwitch.target = target
        powerSwitch.action = action
    }

    func update(isOn: Bool, enabled: Bool) {
        powerSwitch.state = isOn ? .on : .off
        powerSwitch.isEnabled = enabled
        powerSwitch.setAccessibilityValue(isOn ? "On" : "Off")
    }
}

private final class SectionMenuView: NSView {
    init(title: String) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 260),
            heightAnchor.constraint(equalToConstant: 24),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }
}

private final class QuotaMenuView: NSView {
    private let windowLabel = NSTextField(labelWithString: "")
    private let percentLabel = NSTextField(labelWithString: "")
    private let progress = NSProgressIndicator()
    private let resetLabel = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        windowLabel.font = .systemFont(ofSize: 12, weight: .medium)
        percentLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        percentLabel.alignment = .right
        resetLabel.font = .systemFont(ofSize: 10)
        resetLabel.textColor = .secondaryLabelColor
        progress.style = .bar
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = 100
        for view in [windowLabel, percentLabel, progress, resetLabel] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 260),
            heightAnchor.constraint(equalToConstant: 52),
            windowLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            windowLabel.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            percentLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            percentLabel.centerYAnchor.constraint(equalTo: windowLabel.centerYAnchor),
            progress.leadingAnchor.constraint(equalTo: windowLabel.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: percentLabel.trailingAnchor),
            progress.topAnchor.constraint(equalTo: windowLabel.bottomAnchor, constant: 5),
            progress.heightAnchor.constraint(equalToConstant: 4),
            resetLabel.leadingAnchor.constraint(equalTo: windowLabel.leadingAnchor),
            resetLabel.trailingAnchor.constraint(equalTo: percentLabel.trailingAnchor),
            resetLabel.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 4),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func update(window: QuotaWindow, stale: Bool, reset: String?, updated: String?) {
        let percent = min(100, max(0, Int(window.remainingPercent.rounded())))
        windowLabel.stringValue = window.label
        percentLabel.stringValue = "\(percent)% left"
        progress.doubleValue = Double(percent)
        if stale {
            resetLabel.stringValue = updated.map { "Last known · updated \($0)" } ?? "Last known"
            toolTip = reset.map { "Resets \($0)" }
        } else {
            resetLabel.stringValue = reset.map { "Resets \($0)" } ?? "Reset time unavailable"
            toolTip = nil
        }
    }
}

private final class MessageMenuView: NSView {
    private let label = NSTextField(labelWithString: "")

    init(message: String) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        label.stringValue = message
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 260),
            heightAnchor.constraint(equalToConstant: 28),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }
}

private final class SwitchMenuView: NSView {
    private let toggle = NSSwitch()

    init(title: String) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13)
        label.translatesAutoresizingMaskIntoConstraints = false
        toggle.translatesAutoresizingMaskIntoConstraints = false
        toggle.controlSize = .small
        toggle.setAccessibilityLabel(title)
        addSubview(label)
        addSubview(toggle)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 260),
            heightAnchor.constraint(equalToConstant: 34),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            toggle.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            toggle.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func configure(target: AnyObject, action: Selector) {
        toggle.target = target
        toggle.action = action
    }

    func update(isOn: Bool, enabled: Bool) {
        toggle.state = isOn ? .on : .off
        toggle.isEnabled = enabled
        toggle.setAccessibilityValue(isOn ? "On" : "Off")
    }
}

final class PocketHost: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private static let keepAwakeDefaultsKey = "keepMacAwake"
    private let fileManager = FileManager.default
    private lazy var projectURL = Bundle.main.bundleURL.deletingLastPathComponent()
    private lazy var runtimeURL = projectURL.appendingPathComponent(".codex-pocket.runtime.json")
    private lazy var quitMarkerURL = projectURL.appendingPathComponent(".codex-pocket.quit")
    private lazy var gatewayURL = projectURL.appendingPathComponent("gateway.ts")
    private lazy var logURL = projectURL.appendingPathComponent(".codex-pocket.log")
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let headerView = StatusMenuView()
    private let keepAwakeView = SwitchMenuView(title: "Keep Mac Awake")
    private let quotaViews = [QuotaMenuView(), QuotaMenuView()]
    private let quotaItems = [NSMenuItem(), NSMenuItem()]
    private let quotaUnavailableItem = NSMenuItem()
    private var openItem: NSMenuItem!
    private var copyItem: NSMenuItem!
    private var quitItem: NSMenuItem!
    private var sleepActivity: NSObjectProtocol?
    private var timer: Timer?
    private var status: HostStatus?
    private var gatewayProcess: Process?
    private var healthCheckRunning = false
    private var consecutiveFailures = 0
    private var quitting = false
    private var pocketEnabled = true
    private var powerTransition = false

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
        restoreKeepAwakePreference()
        ensureGateway(fatal: true)
        timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        releaseKeepAwakeActivity()
    }

    func menuWillOpen(_ menu: NSMenu) {
        if pocketEnabled { refreshStatus() }
    }

    private func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = pocketStatusImage()
        statusItem.button?.image?.accessibilityDescription = "Codex Pocket"
        statusItem.button?.toolTip = "Codex Pocket"
        headerView.configure(target: self, action: #selector(togglePocketPower))
        keepAwakeView.configure(target: self, action: #selector(toggleKeepAwake))
        menu.delegate = self
        menu.autoenablesItems = false
        let headerItem = NSMenuItem()
        headerItem.view = headerView
        menu.addItem(headerItem)
        menu.addItem(.separator())
        let quotaHeadingItem = NSMenuItem()
        quotaHeadingItem.view = SectionMenuView(title: "Quota")
        menu.addItem(quotaHeadingItem)
        for (item, view) in zip(quotaItems, quotaViews) {
            item.view = view
            menu.addItem(item)
        }
        quotaUnavailableItem.view = MessageMenuView(message: "Quota unavailable")
        menu.addItem(quotaUnavailableItem)
        menu.addItem(.separator())
        openItem = actionItem("Open Pocket", #selector(openPocket), enabled: false)
        copyItem = actionItem("Copy Phone URL", #selector(copyPhoneURL), enabled: false)
        menu.addItem(openItem)
        menu.addItem(copyItem)
        let keepAwakeItem = NSMenuItem()
        keepAwakeItem.view = keepAwakeView
        menu.addItem(keepAwakeItem)
        menu.addItem(.separator())
        quitItem = actionItem("Quit Codex Pocket", #selector(quitPocket), enabled: true)
        menu.addItem(quitItem)
        statusItem.menu = menu
        updateMenu()
    }

    private func updateMenu() {
        headerView.update(isOn: pocketEnabled, enabled: !quitting && !powerTransition)
        if let quota = status?.quota, quota.available, !quota.windows.isEmpty {
            for (index, view) in quotaViews.enumerated() {
                guard index < quota.windows.count else {
                    quotaItems[index].isHidden = true
                    continue
                }
                let window = quota.windows[index]
                view.update(
                    window: window,
                    stale: quota.stale || !pocketEnabled,
                    reset: window.resetsAt.map(formatReset),
                    updated: quota.updatedAt.map(formatReset)
                )
                quotaItems[index].isHidden = false
            }
            quotaUnavailableItem.isHidden = true
        } else {
            for item in quotaItems { item.isHidden = true }
            quotaUnavailableItem.isHidden = false
        }
        openItem.isEnabled = pocketEnabled && !powerTransition && status != nil
        copyItem.isEnabled = pocketEnabled && !powerTransition && !(status?.phoneUrls.isEmpty ?? true)
        keepAwakeView.update(
            isOn: UserDefaults.standard.bool(forKey: Self.keepAwakeDefaultsKey),
            enabled: !quitting && !powerTransition
        )
        quitItem.isEnabled = !quitting
        menu.update()
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

    @objc private func togglePocketPower() {
        guard !quitting, !powerTransition else { return }
        powerTransition = true
        updateMenu()
        if pocketEnabled {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                let stopped = self.runtimeRecord() == nil || self.requestGatewayStop()
                if stopped { self.waitForGatewayExit() }
                DispatchQueue.main.async {
                    self.powerTransition = false
                    guard stopped else {
                        self.updateMenu()
                        self.showError("Codex Pocket could not stop its gateway. Check \(self.logURL.path) for details.")
                        return
                    }
                    self.pocketEnabled = false
                    self.consecutiveFailures = 0
                    self.reconcileKeepAwakeActivity()
                    self.updateMenu()
                }
            }
        } else {
            pocketEnabled = true
            reconcileKeepAwakeActivity()
            updateMenu()
            ensureGateway(fatal: false)
        }
    }

    @objc private func toggleKeepAwake() {
        let enabled = !UserDefaults.standard.bool(forKey: Self.keepAwakeDefaultsKey)
        UserDefaults.standard.set(enabled, forKey: Self.keepAwakeDefaultsKey)
        reconcileKeepAwakeActivity()
        updateMenu()
    }

    private func restoreKeepAwakePreference() {
        reconcileKeepAwakeActivity()
        updateMenu()
    }

    private func reconcileKeepAwakeActivity() {
        let shouldPreventSleep = pocketEnabled && UserDefaults.standard.bool(forKey: Self.keepAwakeDefaultsKey)
        if shouldPreventSleep && !beginKeepAwakeActivity() {
            UserDefaults.standard.set(false, forKey: Self.keepAwakeDefaultsKey)
        } else if !shouldPreventSleep {
            releaseKeepAwakeActivity()
        }
    }

    @discardableResult
    private func beginKeepAwakeActivity() -> Bool {
        guard sleepActivity == nil else { return true }
        let activity = ProcessInfo.processInfo.beginActivity(
            options: [.idleSystemSleepDisabled],
            reason: "Codex Pocket remote access"
        )
        sleepActivity = activity
        return sleepActivity != nil
    }

    private func releaseKeepAwakeActivity() {
        guard let activity = sleepActivity else { return }
        ProcessInfo.processInfo.endActivity(activity)
        sleepActivity = nil
    }

    @objc private func quitPocket() {
        guard !quitting else { return }
        quitting = true
        updateMenu()
        if !pocketEnabled || runtimeRecord() == nil {
            NSApp.terminate(nil)
            return
        }
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
                    self.updateMenu()
                    self.showError("Codex Pocket could not stop its gateway. Check \(self.logURL.path) for details.")
                }
            }
        }
    }

    private func ensureGateway(fatal: Bool) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if let current = self.fetchHostStatus() {
                DispatchQueue.main.async { self.accept(current) }
                return
            }
            guard self.fileManager.fileExists(atPath: self.gatewayURL.path) else {
                DispatchQueue.main.async { self.gatewayStartFailed("Could not find gateway.ts beside Codex Pocket.app.", fatal: fatal) }
                return
            }
            guard let node = self.findNode() else {
                DispatchQueue.main.async { self.gatewayStartFailed("No usable Node.js runtime was found. Install Node.js 22.6 or newer, or keep ChatGPT/Codex installed.", fatal: fatal) }
                return
            }
            do {
                try self.startGateway(node: node)
            } catch {
                DispatchQueue.main.async { self.gatewayStartFailed("Codex Pocket could not start: \(error.localizedDescription)", fatal: fatal) }
                return
            }
            for _ in 0..<80 {
                if let current = self.fetchHostStatus() {
                    DispatchQueue.main.async { self.accept(current) }
                    return
                }
                usleep(100_000)
            }
            DispatchQueue.main.async { self.gatewayStartFailed("Codex Pocket could not start. Check \(self.logURL.path) for details.", fatal: fatal) }
        }
    }

    private func refreshStatus() {
        guard pocketEnabled, !powerTransition, !healthCheckRunning, !quitting else { return }
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
                        self.updateMenu()
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
        powerTransition = false
        reconcileKeepAwakeActivity()
        updateMenu()
    }

    private func gatewayStartFailed(_ message: String, fatal: Bool) {
        powerTransition = false
        if fatal {
            failStartup(message)
            return
        }
        pocketEnabled = false
        reconcileKeepAwakeActivity()
        updateMenu()
        showError(message)
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
        requestGatewayControl(path: "/shutdown")
    }

    private func requestGatewayStop() -> Bool {
        requestGatewayControl(path: "/stop")
    }

    private func requestGatewayControl(path: String) -> Bool {
        guard let record = runtimeRecord(),
              let url = URL(string: record.controlUrl + path) else { return false }
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
            "\(NSHomeDirectory())/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node",
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
