import SwiftUI
import AppKit
import EngineMenuCore

struct DetailsView: View {
    @ObservedObject var state: AppState
    let retry: () -> Void
    @State private var errors = false
    private var lines: [String] { (errors ? state.logs?.err : state.logs?.out) ?? [] }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(state.fetch.snapshot?.engine?.name ?? L10n.text(.unnamed)).font(.headline)
                        HStack {
                            Circle().fill(state.model.icon == .running ? Color(nsColor: .systemGreen) : state.model.icon == .noCloud ? Color(nsColor: .systemYellow) : state.model.icon == .warning ? Color(nsColor: .systemRed) : Color(nsColor: .systemGray)).frame(width: 8, height: 8).accessibilityHidden(true)
                            Text(state.model.header.text)
                        }
                        if let engine = state.fetch.snapshot?.engine {
                            HStack { Text(String(engine.id.prefix(16))).font(.system(.caption, design: .monospaced)); Button(L10n.text(.copy)) { copyText(engine.id) } }
                        }
                        if let process = state.fetch.snapshot?.process {
                            if let version = process.version, let release = process.releaseTag {
                                Text(L10n.text(.version, version, release)).font(.caption).foregroundStyle(.secondary)
                            } else if let version = process.version {
                                Text(L10n.text(.versionOnly, version)).font(.caption).foregroundStyle(.secondary)
                            } else if let release = process.releaseTag {
                                Text(L10n.text(.releaseOnly, release)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if case .unavailable(let error) = state.fetch {
                            Text(error).textSelection(.enabled)
                            HStack { Button(L10n.text(.copyError)) { copyText(error) }; Button(L10n.text(.retry), action: retry) }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                if let snapshot = state.fetch.snapshot {
                    machine(snapshot)
                    connection(snapshot)
                    GroupBox(L10n.text(.logs)) {
                        VStack(alignment: .leading) {
                            Picker(L10n.text(.logs), selection: $errors) {
                                Text(L10n.text(.output)).tag(false); Text(L10n.text(.errors)).tag(true)
                            }.pickerStyle(.segmented).labelsHidden()
                            ScrollViewReader { reader in
                                ScrollView([.horizontal, .vertical]) {
                                    Text(state.logError ?? (lines.isEmpty ? L10n.text(.emptyLogs) : lines.joined(separator: "\n")))
                                        .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Color.clear.frame(height: 1).id("bottom")
                                }.frame(height: 150)
                                    .onChange(of: lines) { _ in reader.scrollTo("bottom", anchor: .bottom) }
                                    .onAppear { reader.scrollTo("bottom", anchor: .bottom) }
                            }
                            HStack {
                                Button(L10n.text(.copy)) { copyText(lines.joined(separator: "\n")) }
                                Button(L10n.text(.console)) {
                                    let url = URL(fileURLWithPath: errors ? snapshot.logs.err : snapshot.logs.out)
                                    if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Console") {
                                        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
                                    }
                                }
                            }
                        }
                    }
                }
            }.padding(16)
        }.frame(minWidth: 380).background(Color(nsColor: .windowBackgroundColor))
    }
    private func row(_ key: L10n, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) { Text(L10n.text(key)).foregroundStyle(.secondary); Spacer(); Text(value).textSelection(.enabled) }
    }
    private func capacity(_ free: Double?, _ total: Double?, approximate: Bool = false) -> some View {
        VStack(alignment: .leading) {
            if let free, let total, total > 0 {
                Text(L10n.text(approximate ? .approxSpace : .space, Format.gb(free), Format.gb(total)))
                ProgressView(value: min(1, max(0, (total - free) / total)))
            } else { Text(L10n.text(.missing)).foregroundStyle(.secondary) }
        }
    }
    private func machine(_ s: Snapshot) -> some View {
        GroupBox(L10n.text(.machine)) {
            VStack(alignment: .leading, spacing: 8) {
                Text(L10n.text(.disk, s.machine.diskPath)).foregroundStyle(.secondary)
                capacity(s.machine.diskFreeBytes, s.machine.diskTotalBytes)
                Text(L10n.text(.memory)).foregroundStyle(.secondary)
                capacity(s.machine.memFreeBytes, s.machine.memTotalBytes, approximate: true)
                row(.load, Format.number(s.machine.loadAverage1m))
                if let awake = state.model.awake { row(.keepAwake, awake.text) }
            }
        }
    }
    private func connection(_ s: Snapshot) -> some View {
        GroupBox(L10n.text(.connection)) {
            VStack(alignment: .leading, spacing: 8) {
                row(.cloudHost, s.engine.flatMap { URL(string: $0.cloudOrigin)?.host } ?? L10n.text(.missing))
                row(.state, state.model.active ? state.model.header.text : L10n.text(.noConnection))
                if s.overall == "no_cloud", let subtitle = state.model.subtitle { Text(subtitle.text).foregroundStyle(.secondary) }
                if let error = s.link.lastError {
                    row(.lastError, Format.relative(error.at, now: Date()).text + " · " + error.code).help(error.message)
                }
                row(.pending, String(s.link.pendingEvents))
                if s.link.droppedEvents > 0 { row(.dropped, String(s.link.droppedEvents)) }
            }
        }
    }
}
