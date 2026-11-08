import SwiftUI
import NexClientKit

/// The chat model sheet (web `ModelMenu`): the assistant's provider (switch it from a menu), that provider's enabled
/// models, and the 思考强度 slider when the chosen model offers reasoning levels. Every choice saves at once.
struct ChatModelSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    var onError: (String) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var viewedID = ""
    @State private var catalogs: [String: [String]] = [:]
    @State private var loadError = ""
    @State private var query = ""
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
    private var models: [String] {
        guard let viewed else { return [] }
        var seen = Set<String>()
        let listed = viewed.models ?? catalogs[viewed.id] ?? []
        let all = (listed + [viewed.defaultModel] + (viewed.id == current?.id ? [chosenModel] : [])).filter { !$0.isEmpty && seen.insert($0).inserted }
        let terms = query.lowercased().split(separator: " ").map(String.init)
        return all.filter { model in terms.allSatisfy { model.lowercased().contains($0) } }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("选择聊天模型").font(.headline)
                Spacer()
                Button("关闭") { dismiss() }.font(.subheadline).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 10)
            if usable.isEmpty {
                Text("还没有可用的供应商，请在设置 → 模型中添加。").font(.subheadline).foregroundStyle(Theme.muted).padding(16)
                Spacer()
            } else {
                Menu {
                    ForEach(usable) { connection in
                        Button { viewedID = connection.id; query = "" } label: {
                            if connection.id == current?.id { Label("\(connection.name) · \(connection.formatTag)", systemImage: "checkmark") } else { Text("\(connection.name) · \(connection.formatTag)") }
                        }
                    }
                } label: {
                    HStack {
                        Text(viewed?.name ?? "").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.foreground)
                        Text(viewed?.formatTag ?? "").font(.caption2).foregroundStyle(Theme.muted)
                        Spacer()
                        if usable.count > 1 { Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Theme.muted) }
                    }
                    .padding(.horizontal, 14).frame(height: 44)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .disabled(usable.count < 2).padding(.horizontal, 16).accessibilityLabel("供应商：\(viewed?.name ?? "")")
                if models.count > 8 || !query.isEmpty {
                    TextField("搜索模型", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .padding(.horizontal, 16).padding(.top, 10)
                }
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(models, id: \.self) { model in
                            Button { pick(model) } label: {
                                HStack(spacing: 8) {
                                    Text(model).font(.body).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.middle)
                                    if viewed?.options[model]?.imageInput == true { Text("视觉").font(.caption2).foregroundStyle(Theme.muted).padding(.horizontal, 5).padding(.vertical, 1).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 4)) }
                                    Spacer()
                                    if viewed?.id == current?.id && model == chosenModel { Image(systemName: "checkmark").foregroundStyle(Theme.brand) }
                                }
                                .padding(.horizontal, 16).frame(minHeight: 46).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        if !loadError.isEmpty { Text(loadError).font(.footnote).foregroundStyle(Theme.danger).padding(16) }
                        if models.isEmpty && loadError.isEmpty { ProgressView().padding(20) }
                    }
                    .padding(.top, 6)
                }
                if !offered.isEmpty && viewed?.id == current?.id { effort }
            }
        }
        .background(Theme.background)
        .onAppear { viewedID = current?.id ?? ""; level = Double(stops.firstIndex(of: resolved) ?? 0) }
        .task(id: viewed?.id) { await loadCatalog() }
    }

    private var effort: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack(spacing: 8) {
                Text("思考强度").font(.subheadline).foregroundStyle(Theme.muted)
                Text(ReasoningLevel.label(stops[Int(level.rounded())])).font(.subheadline.weight(.semibold))
            }
            Slider(value: $level, in: 0...Double(max(1, stops.count - 1)), step: 1) { editing in if !editing { commitLevel() } }
                .tint(Theme.brand).accessibilityLabel("思考强度").accessibilityValue(ReasoningLevel.label(stops[Int(level.rounded())]))
            HStack { ForEach(stops, id: \.self) { stop in Text(ReasoningLevel.label(stop)).font(.caption2).foregroundStyle(Theme.muted); if stop != stops.last { Spacer() } } }
        }
        .padding(.horizontal, 16).padding(.bottom, 16)
    }

    private func loadCatalog() async {
        guard let viewed, viewed.models == nil, catalogs[viewed.id] == nil else { return }
        loadError = ""
        do { catalogs[viewed.id] = try await workspace.listModels(connectionID: viewed.id).models }
        catch { loadError = (error as? CoreError)?.message ?? error.localizedDescription }
    }

    private func pick(_ model: String) {
        guard let viewed else { return }
        dismiss()
        if viewed.id == current?.id && model == chosenModel { return }
        Task {
            do { try await workspace.setAgentModel(botID: botID, connectionID: viewed.id, model: model, reasoning: nil) }
            catch { onError((error as? CoreError)?.message ?? error.localizedDescription) }
        }
    }

    private func commitLevel() {
        let next = stops[min(stops.count - 1, max(0, Int(level.rounded())))]
        guard next != resolved, let current else { return }
        Task {
            do { try await workspace.setAgentModel(botID: botID, connectionID: current.id, model: bot?.selectedModel ?? "", reasoning: next) }
            catch { onError((error as? CoreError)?.message ?? error.localizedDescription) }
        }
    }
}
