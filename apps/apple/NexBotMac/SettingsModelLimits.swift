import SwiftUI
import NexClientKit

/// State of the 模型参数 form for one provider + endpoint + model scope (web `ModelLimitsFields`).
/// `reset(scope:)` starts over when the scope changes; answers of an older scope are dropped, and a field the user
/// already edited is never overwritten by a slow response.
@MainActor @Observable
final class ModelLimitsModel {
    var context = ""
    var output = ""
    var budget = ""
    private(set) var limits: ModelLimitInfo?
    private(set) var loading = false
    private(set) var error = ""
    private(set) var scope = ""
    var retry = 0
    private(set) var generation = 0
    @ObservationIgnored private var editedContext = false
    @ObservationIgnored private var editedOutput = false
    @ObservationIgnored private var editedBudget = false

    var ready: Bool { limits != nil }

    func reset(scope: String) {
        generation += 1
        self.scope = scope
        context = ""; output = ""; budget = ""; limits = nil; loading = false; error = ""; retry = 0
        editedContext = false; editedOutput = false; editedBudget = false
    }
    func userEdited(context: Bool) { if context { editedContext = true } else { editedOutput = true } }
    func userEditedBudget() { editedBudget = true }

    private func apply(_ info: ModelLimitInfo) {
        limits = info
        if !editedContext { context = info.manual.contextWindow.map(String.init) ?? "" }
        if !editedOutput { output = info.manual.maxOutputTokens.map(String.init) ?? "" }
        if !editedBudget { budget = info.manual.contextBudget.map(String.init) ?? "" }
    }

    /// Reads the cached answer, then asks the catalog online unless both values are manual; `retry > 0` forces the lookup.
    func load(workspace: WorkspaceStore, provider: String, endpoint: String, model: String) async {
        let gen = generation, forced = retry > 0
        func current() -> Bool { gen == generation && !Task.isCancelled }
        do {
            let cached = try await workspace.modelLimits(provider: provider, endpoint: endpoint, model: model)
            guard current() else { return }
            apply(cached); error = ""
            if cached.manual.contextWindow != nil, cached.manual.maxOutputTokens != nil, !forced { return }
            loading = true
            let result = try await workspace.refreshModelLimits(provider: provider, endpoint: endpoint, model: model, force: forced)
            guard current() else { return }
            apply(result)
            if result.refreshFailed { error = "联网识别失败，使用缓存或默认值" }
        } catch {
            if current() { self.error = (error as? CoreError)?.message ?? message(of: error) }
        }
        if gen == generation { loading = false }
    }
}

/// The two limit fields with the automatic values as placeholders, their source labels and 联网识别.
struct ModelLimitsFields: View {
    let workspace: WorkspaceStore
    @Bindable var model: ModelLimitsModel
    let provider: String, endpoint: String, name: String
    let onEdit: () -> Void

    private static let number: NumberFormatter = {
        let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_US"); return f
    }()
    private static func format(_ n: Int?) -> String? { n.flatMap { number.string(from: NSNumber(value: $0)) } }

    private var hasModel: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("模型参数").font(.system(size: 13, weight: .semibold))
                Spacer()
                MBButton(title: model.loading ? "识别中…" : "联网识别", enabled: !model.loading && hasModel, action: { model.retry += 1 })
                    .accessibilityIdentifier("limits-lookup")
            }
            HStack(alignment: .top, spacing: 20) {
                field("上下文窗口（Token）", id: "contextWindow", text: Binding(get: { model.context }, set: { model.context = $0; model.userEdited(context: true); onEdit() }),
                      automatic: model.limits?.automatic.contextWindow, source: model.limits?.automatic.source.contextWindow)
                field("最大输出 Token", id: "maxOutputTokens", text: Binding(get: { model.output }, set: { model.output = $0; model.userEdited(context: false); onEdit() }),
                      automatic: model.limits?.automatic.maxOutputTokens, source: model.limits?.automatic.source.maxOutputTokens)
                field("压缩阈值（Token）", id: "contextBudget", text: Binding(get: { model.budget }, set: { model.budget = $0; model.userEditedBudget(); onEdit() }),
                      automatic: model.limits?.automatic.contextBudget, source: model.limits?.automatic.source.contextBudget)
            }
            Text(model.limits?.status.text ?? ModelLimitStatus.matched.text).font(.system(size: 10)).foregroundStyle(Theme.muted)
                .accessibilityIdentifier("limits-status")
            if !model.error.isEmpty {
                Text(model.error).font(.system(size: 10)).foregroundStyle(Theme.danger).textSelection(.enabled).accessibilityIdentifier("limits-error")
            }
        }
        .task(id: "\(model.scope)#\(model.retry)") {
            guard hasModel else { return }
            try? await Task.sleep(for: .milliseconds(model.retry > 0 ? 0 : 400))
            guard !Task.isCancelled else { return }
            await model.load(workspace: workspace, provider: provider, endpoint: endpoint, model: name)
        }
    }

    private func field(_ label: String, id: String, text: Binding<String>, automatic: Int?, source: ModelLimitSource?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            TextField("", text: text, prompt: Text(Self.format(automatic).map { "自动 · \($0)" } ?? "读取中…").foregroundStyle(Theme.muted.opacity(0.7)))
                .textFieldStyle(.plain).font(.system(size: 12)).autocorrectionDisabled()
                .padding(.horizontal, 12).frame(height: 38)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
                .disabled(model.limits == nil)
                .accessibilityLabel(label).accessibilityIdentifier(id)
            Text(text.wrappedValue.isEmpty ? "\(source == .modelsDev ? "models.dev" : "默认") · \(Self.format(automatic) ?? "—")" : "手动配置")
                .font(.system(size: 10)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
