import SwiftUI
import AppKit
import EngineMenuCore

/// The 480 pt setup windows: a, r, r2, r3, b, c, d, e, f, s2 and s3. System colors and fonts, text next to every
/// colored mark, no animation.
struct SetupView: View {
    @ObservedObject var flow: SetupFlow

    private struct Action: Identifiable {
        enum Kind { case plain, primary, cancel, leading }
        let id: String
        let title: String
        let kind: Kind
        let run: () -> Void
    }
    private struct Panel {
        var title: String
        var body: String?
        var bullets: [String] = []
        var requirements: [String] = []
        var steps: [StepRow] = []
        /// An active status line for a wait that is not an install step (tools, approval).
        var waiting: String?
        var note: String?
        var error: String?
        var actions: [Action] = []
    }

    private func action(_ key: L10n, _ kind: Action.Kind = .plain, _ run: @escaping () -> Void) -> Action {
        Action(id: key.rawValue, title: L10n.text(key), kind: kind, run: run)
    }
    private func panel() -> Panel {
        let close = { flow.closeWindow() }
        switch flow.screen {
        case .welcome:
            return Panel(title: L10n.text(.welcomeTitle), body: L10n.text(.welcomeBody),
                         bullets: [L10n.text(.welcomeLogin), L10n.text(.welcomeQuit)] + (Updates.identity.canSelfUpdate ? [L10n.text(.welcomeUpdate)] : []), note: L10n.text(.welcomeApproval),
                         actions: [action(.notNow, .cancel) { flow.dismiss() }, action(.installButton, .primary) { flow.install() }])
        case .missingTools(let waiting):
            if waiting {
                return Panel(title: L10n.text(.missingTitle), body: L10n.text(.missingIntro),
                             requirements: [Prerequisite.commandLineTools.text], waiting: L10n.text(.waitingTools),
                             note: L10n.text(.waitingToolsNote),
                             actions: [action(.notNow, .cancel) { flow.dismiss() }])
            }
            return Panel(title: L10n.text(.missingTitle), body: L10n.text(.missingIntro), requirements: [Prerequisite.commandLineTools.text],
                         note: L10n.text(.missingNote),
                         actions: [action(.notNow, .cancel) { flow.dismiss() }, action(.installTools, .primary) { flow.installTools() }])
        case .unsupported(let report):
            return Panel(title: L10n.text(.unsupportedTitle), body: L10n.text(.unsupportedBody), requirements: report.unsupported.map { $0.text },
                         actions: [action(.quit, .primary) { NSApp.terminate(nil) }])
        case .installing(let list):
            return Panel(title: L10n.text(.installing), steps: list.rows, note: L10n.text(.installingNote),
                         actions: [action(.close, .cancel, close)])
        case .approval:
            return Panel(title: L10n.text(.approvalTitle), body: L10n.text(.approvalBody),
                         waiting: L10n.text(.approvalWaiting), note: L10n.text(.approvalNote),
                         actions: [action(.later, .cancel, close), action(.openSettings, .primary) { flow.openLoginItems() }])
        case .failed(let list, let message):
            return Panel(title: L10n.text(.installFailedTitle), steps: list.reached, note: L10n.text(.installFailedNote), error: message,
                         actions: [action(.copyError, .leading) { flow.copyError() }, action(.close, .cancel, close), action(.retry, .primary) { flow.install() }])
        case .awaitingSetup:
            return Panel(title: L10n.text(.setupTitle), body: L10n.text(.setupBody), actions: [action(.close, .primary, close)])
        case .running:
            return Panel(title: L10n.text(.runningTitle), body: L10n.text(.runningBody), actions: [action(.done, .primary, close)])
        case .removed:
            return Panel(title: L10n.text(.removedTitle), body: L10n.text(.removedBody),
                         actions: [action(.close, .cancel, close), action(.quit, .primary) { NSApp.terminate(nil) }])
        case .removalFailed(let message):
            return Panel(title: L10n.text(.removeFailedTitle), body: L10n.text(.removeFailedBody), error: message,
                         actions: [action(.copyError, .leading) { flow.copyError() }, action(.close, .cancel, close), action(.retry, .primary) { flow.removeEngine() }])
        }
    }

    var body: some View {
        let content = panel()
        VStack(alignment: .leading, spacing: 14) {
            Text(content.title).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let text = content.body { Text(text).fixedSize(horizontal: false, vertical: true) }
            if !content.requirements.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(content.requirements, id: \.self) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "xmark.circle.fill").foregroundColor(Color(nsColor: .systemRed)).accessibilityHidden(true)
                            Text(line)
                        }
                    }
                }
            }
            if !content.bullets.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(content.bullets, id: \.self) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "checkmark").foregroundColor(Color(nsColor: .systemGreen)).accessibilityHidden(true)
                            Text(line).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            if !content.steps.isEmpty { stepList(content.steps) }
            if let waiting = content.waiting { waitingLine(waiting) }
            if let error = content.error {
                Text(error).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .textBackgroundColor))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(nsColor: .separatorColor)))
            }
            if let note = content.note { Text(note).font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true) }
            HStack {
                ForEach(content.actions.filter { $0.kind == .leading }) { item in button(item) }
                Spacer()
                ForEach(content.actions.filter { $0.kind != .leading }) { item in button(item) }
            }
        }
        .padding(24).frame(width: 480).background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    private func button(_ item: Action) -> some View {
        switch item.kind {
        case .primary: Button(item.title, action: item.run).keyboardShortcut(.defaultAction)
        case .cancel: Button(item.title, action: item.run).keyboardShortcut(.cancelAction)
        case .plain, .leading: Button(item.title, action: item.run)
        }
    }

    /// The same look as an active step, announced as a live region.
    private func waitingLine(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            mark(.active).accessibilityHidden(true)
            Text(text).fontWeight(.semibold)
            if let word = stateWord(.active) { Text(word).font(.caption).foregroundColor(.secondary) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// A live region: VoiceOver announces the step that changes.
    private func stepList(_ rows: [StepRow]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(rows, id: \.step) { row in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    mark(row.state).accessibilityHidden(true)
                    Text(L10n.text(row.title)).fontWeight(row.state == .active ? .semibold : .regular)
                    if let word = stateWord(row.state) { Text(word).font(.caption).foregroundColor(.secondary) }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.updatesFrequently)
    }
    private func stateWord(_ state: StepState) -> String? {
        switch state {
        case .pending: return nil
        case .active: return L10n.text(.stateActive)
        case .done: return L10n.text(.stateDone)
        case .failed: return L10n.text(.stateFailed)
        }
    }
    @ViewBuilder
    private func mark(_ state: StepState) -> some View {
        switch state {
        case .pending: Image(systemName: "circle").foregroundColor(.secondary)
        case .active: Image(systemName: "arrow.right.circle").foregroundColor(Color(nsColor: .controlAccentColor))
        case .done: Image(systemName: "checkmark.circle.fill").foregroundColor(Color(nsColor: .systemGreen))
        case .failed: Image(systemName: "xmark.circle.fill").foregroundColor(Color(nsColor: .systemRed))
        }
    }
}
