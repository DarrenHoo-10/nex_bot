import SwiftUI
import NexClientKit

struct ComposerModelLabel: View {
    let workspace: WorkspaceStore
    let bot: Bot?

    var body: some View {
        let choice = workspace.state?.modelChoice(forBot: bot)
        let model = choice?.model ?? ""
        let name = model.isEmpty ? "未连接模型" : (choice?.connection?.displayName(model) ?? model)
        HStack(spacing: 5) {
            Text(name).lineLimit(1).truncationMode(.tail)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
        }
        .font(.system(size: 12))
        .foregroundStyle(Theme.foreground)
        .padding(.horizontal, 8).frame(height: 34)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 9))
        .accessibilityLabel("选择模型")
        .accessibilityValue(name)
    }
}

struct ChatReasoningSlider: View {
    @Binding var level: Double
    let stops: [String]
    let available: Set<String>?
    let tint: Color
    let commit: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var index: Int { min(stops.count - 1, max(0, Int(level.rounded()))) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                Text("推理强度").foregroundStyle(Theme.muted)
                Spacer()
                Text(ReasoningLevel.label(stops[index])).fontWeight(.semibold)
            }.font(.footnote)
            Slider(value: $level, in: 0...Double(stops.count - 1), step: 1) { editing in
                if !editing { commit() }
            }
            .tint(tint)
            .accessibilityLabel("推理强度").accessibilityValue(ReasoningLevel.label(stops[index]))
            HStack(spacing: 2) {
                ForEach(stops.indices, id: \.self) { stop in
                    Button {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.17)) { level = Double(stop) }
                        commit()
                    } label: {
                        Text(ReasoningLevel.label(stops[stop])).font(.caption2)
                            .foregroundStyle(stop == index ? tint : Theme.muted)
                            .frame(maxWidth: .infinity, minHeight: 25)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .opacity(available?.contains(stops[stop]) == false ? 0.48 : 1)
                    .disabled(available?.contains(stops[stop]) == false)
                    .accessibilityAddTraits(stop == index ? .isSelected : [])
                }
            }
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
