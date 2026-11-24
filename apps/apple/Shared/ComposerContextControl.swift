import SwiftUI
import NexClientKit

struct ComposerModelLabel: View {
    let workspace: WorkspaceStore
    let bot: Bot?

    var body: some View {
        let choice = bot.flatMap { workspace.agentModelChoice($0.id) }
        let connection = workspace.state?.connections.first { $0.id == choice?.connectionID }
        let model = (choice?.model.isEmpty == false ? choice?.model : connection?.defaultModel) ?? workspace.state?.config?.defaultModel ?? ""
        let name = model.isEmpty ? "未连接模型" : (connection?.displayName(model) ?? model)
        let effort = ReasoningLevel.chatLevel(choice?.reasoning).label
        HStack(spacing: 5) {
            Text(name).lineLimit(1).truncationMode(.tail)
            if !model.isEmpty { Text(effort).foregroundStyle(Theme.muted).fixedSize() }
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
        }
        .font(.system(size: 12))
        .foregroundStyle(Theme.foreground)
        .padding(.horizontal, 8).frame(height: 34)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 9))
        .accessibilityLabel("选择模型")
        .accessibilityValue(model.isEmpty ? name : "\(name) · \(effort)")
    }
}

struct ChatEffortChoices: View {
    let levels: [String]
    let selection: String?
    let label: (String) -> String
    let tint: Color
    let choose: (String) -> Void
    @State private var preview: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selected: Int? { selection.flatMap { levels.firstIndex(of: $0) } }
    private var position: Double { min(Double(max(0, levels.count - 1)), max(0, preview ?? Double(selected ?? 0))) }
    private var active: Int? { preview == nil ? selected : Int(position.rounded()) }
    private var valueLabel: String { active.flatMap { levels.indices.contains($0) ? label(levels[$0]) : nil } ?? "默认" }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("思考强度").foregroundStyle(Theme.muted)
                Spacer()
                Text(valueLabel).fontWeight(.semibold)
            }.font(.caption)
            if levels.count > 1 {
                Slider(value: Binding(get: { position }, set: { preview = $0 }), in: 0...Double(levels.count - 1)) { editing in
                    if !editing, preview != nil { commit(Int(position.rounded())) }
                }
                .tint(tint)
                .accessibilityLabel("思考强度")
                .accessibilityValue(valueLabel)
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: commit((active ?? 0) + 1)
                    case .decrement: commit((active ?? 0) - 1)
                    @unknown default: break
                    }
                }
                .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow], phases: [.down, .repeat]) { press in
                    commit((active ?? 0) + (press.key == .leftArrow || press.key == .downArrow ? -1 : 1))
                    return .handled
                }
            }
            HStack(spacing: 3) {
                ForEach(Array(levels.enumerated()), id: \.element) { index, level in
                    Button { commit(index) } label: {
                        Text(label(level)).font(.caption)
                            .fontWeight(index == active ? .semibold : .regular)
                            .foregroundStyle(index == active ? tint : Theme.muted)
                            .fixedSize(horizontal: true, vertical: false)
                            .frame(maxWidth: .infinity, minHeight: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(index == active ? .isSelected : [])
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func commit(_ index: Int) {
        guard !levels.isEmpty else { return }
        let next = levels[min(levels.count - 1, max(0, index))]
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) {
            preview = nil
            if next != selection { choose(next) }
        }
    }
}

struct ComposerContextControl: View {
    let workspace: WorkspaceStore
    let conversation: ConversationStore
    let bot: Bot?
    @State private var details = false
    @State private var snapshot: ChatContextUsage?
    @State private var snapshotScope: Scope?

    private struct Scope: Hashable {
        let botID: String
        let connectionID: String?
        let model: String?
    }
    private struct Refresh: Hashable {
        let scope: Scope
        let messageID: String?
        let taskStatus: String?
        let version: Int?
        let connected: Bool
        let details: Bool
    }
    private var scope: Scope {
        let choice = workspace.state?.modelChoice(forBot: bot)
        return Scope(botID: conversation.botID, connectionID: workspace.state?.connection(forBot: bot)?.id, model: choice?.model)
    }
    private var refresh: Refresh {
        Refresh(scope: scope, messageID: conversation.messages.last?.id, taskStatus: conversation.activeTask?.status,
                version: workspace.state?.connection(forBot: bot)?.version, connected: workspace.connection == .connected, details: details)
    }
    private var current: ChatContextUsage? { refresh.connected && snapshotScope == scope ? snapshot : nil }
    private var fraction: CGFloat {
        guard let used = current?.usedTokens, let capacity = current?.contextWindow, capacity > 0 else { return 0 }
        return min(1, CGFloat(used) / CGFloat(capacity))
    }
    private var tint: Color { fraction >= 0.85 ? Theme.danger : fraction >= 0.6 ? .orange : .green }

    var body: some View {
        Button { details.toggle() } label: {
            ZStack {
                Circle().strokeBorder(Theme.border, lineWidth: 2)
                Circle().trim(from: 0, to: fraction).stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90)).padding(1)
            }
            .frame(width: 16, height: 16)
            .frame(width: 34, height: 34)
            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("上下文窗口")
        .accessibilityValue("\(current?.usedTokens?.formatted() ?? "—") / \(current?.contextWindow?.formatted() ?? "—") tokens")
        .popover(isPresented: $details, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 7) {
                Text("已使用 / 上下文窗口").font(.footnote)
                HStack(spacing: 0) {
                    Text(current?.usedTokens?.formatted() ?? "—").foregroundStyle(current?.usedTokens == nil ? Theme.muted : tint)
                    Text(" / \(current?.contextWindow?.formatted() ?? "—") tokens").foregroundStyle(Theme.muted)
                }
                .font(.footnote.monospacedDigit())
                ProgressView(value: Double(fraction)).tint(tint).accessibilityHidden(true)
            }
            .padding(13).frame(width: 220)
            #if os(iOS)
            .presentationCompactAdaptation(.popover)
            #endif
        }
        .task(id: refresh) {
            let initial = refresh
            guard initial.connected, bot != nil else { return }
            let result = try? await workspace.client.chatContextUsage(botID: initial.scope.botID)
            guard !Task.isCancelled, initial.scope == scope, let result else { return }
            snapshotScope = initial.scope
            snapshot = result
        }
    }
}
