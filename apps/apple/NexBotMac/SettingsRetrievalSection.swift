import SwiftUI
import NexClientKit

/// 记忆检索 (web `RetrievalSettings.tsx`): the embedding and rerank models of memory retrieval, each saved on its own.
/// Core tests the settings with a real request before it stores them. The API key is write-only: it is never shown or logged.
struct RetrievalSection: View {
    let workspace: WorkspaceStore
    /// The 模型 category is showing: the settings are read on every show.
    let active: Bool

    @State private var view: RetrievalView?
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("记忆检索").font(.system(size: 13, weight: .semibold))
            if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 12) }
            if let view {
                ForEach(RetrievalKind.allCases, id: \.self) { kind in
                    RetrievalModelForm(workspace: workspace, kind: kind, item: view.item(kind), onSaved: { self.view = $0 }).padding(.top, 22)
                }
            }
        }
        .task(id: active) {
            guard active else { return }
            do {
                let result = try await workspace.retrievalSettings()
                if !Task.isCancelled { view = result; error = "" }
            } catch {
                if !Task.isCancelled { self.error = mbFallbackMessage(error) }
            }
        }
    }
}

private struct RetrievalModelForm: View {
    let workspace: WorkspaceStore
    let kind: RetrievalKind
    let item: RetrievalItem
    let onSaved: (RetrievalView) -> Void

    @State private var enabled: Bool
    @State private var baseURL: String
    @State private var model: String
    @State private var dimensions: String
    @State private var format: RerankFormat
    @State private var apiKey = ""
    @State private var showKey = false
    @State private var pending = false
    @State private var saved = false
    @State private var error = ""

    init(workspace: WorkspaceStore, kind: RetrievalKind, item: RetrievalItem, onSaved: @escaping (RetrievalView) -> Void) {
        self.workspace = workspace; self.kind = kind; self.item = item; self.onSaved = onSaved
        _enabled = State(initialValue: item.custom?.enabled ?? true)
        _baseURL = State(initialValue: item.custom?.baseURL ?? "")
        _model = State(initialValue: item.custom?.model ?? "")
        _dimensions = State(initialValue: item.custom?.dimensions.map(String.init) ?? "")
        _format = State(initialValue: item.custom?.format ?? .cohere)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(kind.title).font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(item.statusText).font(.system(size: 10)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
                    .accessibilityIdentifier("\(kind.rawValue)-status")
            }
            VStack(alignment: .leading, spacing: 20) {
                MBInput(label: "地址", text: edited($baseURL), placeholder: "https://", identifier: "\(kind.rawValue)-baseURL")
                MBInput(label: "模型", text: edited($model), identifier: "\(kind.rawValue)-model")
                if kind == .embedding {
                    MBInput(label: "维度", text: edited($dimensions), identifier: "\(kind.rawValue)-dimensions")
                } else {
                    MBSelect(label: "格式", selection: Binding(get: { format.rawValue }, set: { format = RerankFormat(rawValue: $0) ?? .cohere; saved = false }),
                             options: RerankFormat.allCases.map { ($0.rawValue, $0.title) })
                }
                keyField
                HStack {
                    Text("启用").font(.system(size: 12, weight: .medium))
                    Spacer()
                    Toggle("启用", isOn: edited($enabled)).labelsHidden().toggleStyle(.switch).controlSize(.small)
                        .accessibilityIdentifier("\(kind.rawValue)-enabled")
                }
            }
            .disabled(pending)
            .padding(.top, 16)
            if !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).padding(.top, 12) }
            HStack(spacing: 14) {
                MBButton(title: pending ? "测试并保存中…" : "保存", kind: .brand, busy: pending, action: save)
                if item.custom != nil { MBButton(title: "使用默认", enabled: !pending, action: useDefault) }
                if saved {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark").font(.system(size: 11)); Text("已保存").font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.muted)
                }
            }
            .padding(.top, 18)
        }
        .onChange(of: item.version) { sync() }
    }

    private var keyField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("API Key").font(.system(size: 12, weight: .medium))
            HStack(spacing: 6) {
                Group {
                    let prompt = Text(item.custom?.hasKey == true ? "留空保留已保存的 Key" : "").foregroundStyle(Theme.muted.opacity(0.7))
                    if showKey { TextField("", text: edited($apiKey), prompt: prompt) } else { SecureField("", text: edited($apiKey), prompt: prompt) }
                }
                .textFieldStyle(.plain).font(.system(size: 12)).autocorrectionDisabled()
                .accessibilityLabel("API Key").accessibilityIdentifier("\(kind.rawValue)-apiKey")
                Button { showKey.toggle() } label: {
                    Image(systemName: showKey ? "eye.slash" : "eye").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(showKey ? "隐藏 API Key" : "显示 API Key").accessibilityLabel(showKey ? "隐藏 API Key" : "显示 API Key")
            }
            .padding(.leading, 12).padding(.trailing, 6).frame(height: 38)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
        }
    }

    /// Binding that hides 已保存 once the form is edited.
    private func edited<T>(_ binding: Binding<T>) -> Binding<T> {
        Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = $0; saved = false })
    }

    /// The form shows what Core stored; a typed key is dropped.
    private func sync() {
        enabled = item.custom?.enabled ?? true
        baseURL = item.custom?.baseURL ?? ""
        model = item.custom?.model ?? ""
        dimensions = item.custom?.dimensions.map(String.init) ?? ""
        format = item.custom?.format ?? .cohere
        apiKey = ""; showKey = false
    }

    private func save() {
        let size: Int?
        do { size = try kind == .embedding ? RetrievalSaveRequest.dimensions(from: dimensions) : nil }
        catch { self.error = mbFallbackMessage(error); saved = false; return }
        submit(.save(kind: kind, version: item.version, enabled: enabled, baseURL: baseURL, model: model, dimensions: size, format: format, apiKey: apiKey))
    }

    private func useDefault() { submit(.useDefault(kind: kind, version: item.version)) }

    private func submit(_ request: RetrievalSaveRequest) {
        guard !pending else { return }
        pending = true; saved = false; error = ""
        Task {
            defer { pending = false }
            do {
                let result = try await workspace.saveRetrieval(request)
                apiKey = ""; showKey = false; saved = true
                onSaved(result)
            } catch { self.error = mbFallbackMessage(error) }
        }
    }
}
