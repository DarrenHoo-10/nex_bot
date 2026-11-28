import SwiftUI
import NexClientKit

struct ChatModelSheet: View {
    let workspace: WorkspaceStore
    let botID: String
    var onError: (String) -> Void = { _ in }
    var composer = false
    @Environment(\.dismiss) private var dismiss
    @State private var viewedID = ""
    @State private var catalogs: [String: [String]] = [:]
    @State private var loadingCatalog = false
    @State private var loadError = ""
    @State private var query = ""

    private var state: WorkspaceState? { workspace.state }
    private var choice: AgentModelChoice? { workspace.agentModelChoice(botID) }
    private var usable: [ModelConnection] { (state?.connections ?? []).filter(\.usable) }
    private var current: ModelConnection? { usable.first { $0.id == choice?.connectionID } ?? usable.first(where: \.isDefault) ?? usable.first }
    private var viewed: ModelConnection? { usable.first { $0.id == viewedID } ?? current }
    private var chosenModel: String {
        if let model = choice?.model, !model.isEmpty { return model }
        return current?.defaultModel ?? ""
    }
    private var offered: [ReasoningLevel] { chosenModel.isEmpty ? [] : ReasoningLevel.defaults }
    private var resolved: String { ReasoningLevel.chatLevel(choice?.reasoning).rawValue }
    private var models: [String] {
        guard let viewed else { return [] }
        var seen = Set<String>()
        let listed = viewed.models ?? catalogs[viewed.id] ?? []
        let all = (listed + [viewed.defaultModel] + (viewed.id == current?.id ? [chosenModel] : [])).filter { !$0.isEmpty && seen.insert($0).inserted }
        let terms = query.lowercased().split(separator: " ").map(String.init)
        return all.filter { model in terms.allSatisfy { (model + " " + viewed.displayName(model)).lowercased().contains($0) } }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("模型").font(.headline)
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
                if !offered.isEmpty && viewed?.id == current?.id { effort }
                if composer || models.count > 8 || !query.isEmpty {
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
                                    Text(viewed?.displayName(model) ?? model).font(.body).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.middle)
                                    if viewed?.options[model]?.imageInput == true { Text("视觉").font(.caption2).foregroundStyle(Theme.muted).padding(.horizontal, 5).padding(.vertical, 1).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 4)) }
                                    Spacer()
                                    if viewed?.id == current?.id && model == chosenModel { Image(systemName: "checkmark").foregroundStyle(Theme.brand) }
                                }
                                .padding(.horizontal, 16).frame(minHeight: 46).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        if !loadError.isEmpty { Text(loadError).font(.footnote).foregroundStyle(Theme.danger).padding(16) }
                        if loadingCatalog && models.isEmpty { ProgressView().padding(20) }
                        else if models.isEmpty && loadError.isEmpty {
                            Text(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "暂无可用模型" : "没有匹配的模型")
                                .font(.footnote).foregroundStyle(Theme.muted).padding(20)
                        }
                    }
                    .padding(.top, 6)
                }
            }
        }
        .background(Theme.background)
        .onAppear { viewedID = current?.id ?? "" }
        .task(id: viewed?.id) { await loadCatalog() }
    }

    private var effort: some View {
        ChatEffortChoices(levels: offered.map(\.rawValue), selection: resolved,
                          label: ReasoningLevel.label, tint: composer ? .blue : Theme.brand, choose: commitLevel)
            .padding(.horizontal, 16).padding(.vertical, 6)
    }

    private func loadCatalog() async {
        guard let viewed, viewed.models == nil, catalogs[viewed.id] == nil else { return }
        loadingCatalog = true
        loadError = ""
        defer { loadingCatalog = false }
        do { catalogs[viewed.id] = try await workspace.listModels(connectionID: viewed.id).models }
        catch { loadError = (error as? CoreError)?.message ?? error.localizedDescription }
    }

    private func pick(_ model: String) {
        guard let viewed else { return }
        if !composer { dismiss() }
        if viewed.id == current?.id && model == chosenModel { return }
        workspace.chooseAgentModel(botID, .init(connectionID: viewed.id, model: model,
                                                 reasoning: viewed.id == current?.id ? choice?.reasoning : nil), onError: onError)
    }

    private func commitLevel(_ next: String) {
        guard let current, next != resolved else { return }
        workspace.chooseAgentModel(botID, .init(connectionID: current.id, model: choice?.model ?? "", reasoning: next), onError: onError)
    }
}
