import SwiftUI
import NexClientKit

/// 记忆检索 (web `RetrievalSettings.tsx`): the embedding and rerank models of memory retrieval, each saved on its own.
/// Core tests the settings with a real request before it stores them. The API key is write-only: it is never shown or logged.
struct RetrievalSection: View {
    let workspace: WorkspaceStore

    @State private var view: RetrievalView?
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("记忆检索").font(.subheadline.weight(.semibold))
            if !error.isEmpty { InlineBanner(text: error) }
            if let view {
                ForEach(RetrievalKind.allCases, id: \.self) { kind in
                    RetrievalModelForm(workspace: workspace, kind: kind, item: view.item(kind), onSaved: { self.view = $0 })
                }
            }
        }
        .task {
            do {
                let result = try await workspace.retrievalSettings()
                if !Task.isCancelled { view = result; error = "" }
            } catch {
                if !Task.isCancelled { self.error = coreMessage(error) }
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
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(kind.title).font(.footnote.weight(.semibold))
                Spacer()
                StatusChip(text: item.statusText, tone: .neutral)
            }
            FormField(title: "地址") {
                TextField("https://", text: edited($baseURL))
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            FormField(title: "模型") {
                TextField("", text: edited($model)).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            if kind == .embedding {
                FormField(title: "维度") {
                    TextField("", text: edited($dimensions)).keyboardType(.numberPad)
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("格式").font(.footnote.weight(.semibold))
                    Picker("格式", selection: Binding(get: { format }, set: { format = $0; saved = false })) {
                        ForEach(RerankFormat.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
            }
            FormField(title: "API Key") {
                HStack(spacing: 8) {
                    let placeholder = item.custom?.hasKey == true ? "留空保留已保存的 Key" : ""
                    Group {
                        if showKey { TextField(placeholder, text: edited($apiKey)) } else { SecureField(placeholder, text: edited($apiKey)) }
                    }
                    .textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.oneTimeCode)
                    Button { showKey.toggle() } label: {
                        Image(systemName: showKey ? "eye.slash" : "eye").foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(showKey ? "隐藏 API Key" : "显示 API Key")
                }
            }
            Toggle(isOn: edited($enabled)) { Text("启用").font(.footnote.weight(.semibold)) }
            if !error.isEmpty { InlineBanner(text: error) }
            HStack(spacing: 12) {
                PrimaryButton(title: pending ? "测试并保存中…" : "保存", busy: pending, brand: true, action: save).disabled(pending)
                if item.custom != nil {
                    Button("使用默认", action: useDefault).buttonStyle(PillButtonStyle()).disabled(pending).fixedSize()
                }
            }
            if saved { Label("已保存", systemImage: "checkmark").font(.subheadline.weight(.medium)).foregroundStyle(Theme.success) }
        }
        .disabled(pending)
        .padding(14).cardStyle()
        .onChange(of: item.version) { sync() }
        .onDisappear { showKey = false }
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
        catch { self.error = coreMessage(error); saved = false; return }
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
            } catch { self.error = coreMessage(error) }
        }
    }
}
