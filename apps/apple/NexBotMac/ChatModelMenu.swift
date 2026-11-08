import SwiftUI
import NexClientKit

/// The chat model menu (web `ModelMenu`): the assistant's provider on top (switch it in a sub-list), that provider's
/// enabled models, and the 思考强度 slider when the chosen model offers reasoning levels. Every choice saves at once.
struct ChatModelMenu: View {
    let workspace: WorkspaceStore
    let botID: String
    let close: () -> Void
    var onError: (String) -> Void = { _ in }

    @State private var viewedID = ""
    @State private var picking = false
    @State private var catalogs: [String: [String]] = [:]
    @State private var loadError = ""
    @State private var level = 0.0

    private var state: WorkspaceState? { workspace.state }
    private var bot: Bot? { workspace.bot(botID) }
    private var usable: [ModelConnection] { (state?.connections ?? []).filter(\.usable) }
    private var current: ModelConnection? { state?.connection(forBot: bot) }
    private var viewed: ModelConnection? { usable.first { $0.id == viewedID } ?? current }
    private var chosenModel: String { state?.modelChoice(forBot: bot).model ?? "" }
    private var offered: [ReasoningLevel] { current?.options[chosenModel]?.reasoning ?? [] }
    private var stops: [String] { ["off"] + offered.map(\.rawValue) }
    private var resolved: String { ReasoningLevel.resolve(bot?.selectedReasoning, offered: offered) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if usable.isEmpty {
                Text("还没有可用的供应商，请在设置 → 模型中添加。").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(12)
            } else if picking {
                providerButton(title: "供应商", back: true) { picking = false }
                ForEach(usable) { connection in
                    Button { viewedID = connection.id; picking = false } label: {
                        HStack(spacing: 8) {
                            Text(connection.name).font(.system(size: 12.5)).lineLimit(1)
                            tag(connection.formatTag)
                            Spacer()
                            if connection.id == current?.id { Image(systemName: "checkmark").font(.system(size: 11)).foregroundStyle(Theme.brand) }
                        }
                        .padding(.horizontal, 12).frame(height: 34).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel(connection.name)
                }
            } else {
                providerButton(title: viewed?.name ?? "", tag: viewed?.formatTag, chevron: usable.count > 1) { if usable.count > 1 { picking = true } }
                Text("模型").font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)
                ModelListView(models: models, value: viewed?.id == current?.id ? chosenModel : "", emptyLabel: nil, allowCustom: false, debugPrefix: "cm",
                              onSelect: { pick($0) }, onEscape: close)
                if !loadError.isEmpty { Text(loadError).font(.system(size: 11)).foregroundStyle(Theme.danger).padding(.horizontal, 12).padding(.vertical, 6) }
                if !offered.isEmpty && viewed?.id == current?.id { effort }
            }
        }
        .frame(width: 320).padding(.vertical, 4)
        .accessibilityElement(children: .contain).accessibilityLabel("选择聊天模型")
        .onAppear { viewedID = current?.id ?? ""; level = Double(stops.firstIndex(of: resolved) ?? 0) }
        .task(id: viewed?.id) { await loadCatalog() }
    }

    /// The viewed provider's enabled models; a provider showing every model lists them from the service.
    private var models: [String] {
        guard let viewed else { return [] }
        var seen = Set<String>()
        let listed = viewed.models ?? catalogs[viewed.id] ?? []
        return (listed + [viewed.defaultModel] + (viewed.id == current?.id ? [chosenModel] : [])).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private var effort: some View {
        VStack(alignment: .leading, spacing: 6) {
            Hairline().padding(.bottom, 4)
            HStack(spacing: 8) {
                Text("思考强度").font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                Text(ReasoningLevel.label(stops[Int(level.rounded())])).font(.system(size: 12.5, weight: .semibold))
            }
            Slider(value: $level, in: 0...Double(max(1, stops.count - 1)), step: 1) { editing in if !editing { commitLevel() } }
                .tint(Theme.brand).accessibilityLabel("思考强度").accessibilityValue(ReasoningLevel.label(stops[Int(level.rounded())]))
            HStack { ForEach(stops, id: \.self) { stop in Text(ReasoningLevel.label(stop)).font(.system(size: 9.5)).foregroundStyle(Theme.muted); if stop != stops.last { Spacer() } } }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func providerButton(title: String, tag text: String? = nil, chevron: Bool = false, back: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if back { Image(systemName: "chevron.left").font(.system(size: 11)) }
                Text(title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                if let text { tag(text) }
                Spacer()
                if chevron { Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 10).frame(height: 34)
            .background(Theme.wash, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).padding(.horizontal, 6).padding(.top, 2)
        .accessibilityLabel(back ? "返回" : "切换供应商，当前：\(title)")
    }

    private func tag(_ text: String) -> some View {
        Text(text).font(.system(size: 9.5)).foregroundStyle(Theme.muted).padding(.horizontal, 5).padding(.vertical, 1).background(Theme.wash, in: RoundedRectangle(cornerRadius: 4))
    }

    private func loadCatalog() async {
        guard let viewed, viewed.models == nil, catalogs[viewed.id] == nil else { return }
        loadError = ""
        do { catalogs[viewed.id] = try await workspace.listModels(connectionID: viewed.id).models }
        catch { loadError = mbFallbackMessage(error) }
    }

    private func pick(_ model: String) {
        guard let viewed else { return }
        close()
        if viewed.id == current?.id && model == chosenModel { return }
        // The effort stays as stored for that provider (nil keeps it).
        Task { do { try await workspace.setAgentModel(botID: botID, connectionID: viewed.id, model: model, reasoning: nil) } catch { onError(mbFallbackMessage(error)) } }
    }

    private func commitLevel() {
        let next = stops[min(stops.count - 1, max(0, Int(level.rounded())))]
        guard next != resolved, let current else { return }
        Task { do { try await workspace.setAgentModel(botID: botID, connectionID: current.id, model: bot?.selectedModel ?? "", reasoning: next) } catch { onError(mbFallbackMessage(error)) } }
    }
}
