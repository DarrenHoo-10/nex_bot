import SwiftUI
import NexClientKit

@main
struct NexBotApp: App {
    @State private var model = AppModel()
    @AppStorage(AppearanceMode.key) private var appearance = AppearanceMode.system.rawValue
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .tint(Theme.foreground)
                .preferredColorScheme(AppearanceMode(rawValue: appearance)?.scheme)
                .task { await model.start() }
                .onChange(of: scenePhase) { _, phase in model.setForeground(phase == .active) }
        }
    }
}

/// Switches between launch, login and the connected app.
struct RootView: View {
    let model: AppModel

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            content
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .launching:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .resuming, .loggedOut:
            LoginView(model: model)
        case .connected:
            if let workspace = model.workspace {
                ConnectedView(model: model, workspace: workspace)
            }
        }
    }
}

/// Shows a Core error text as an alert.
extension View {
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert("操作失败", isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
            Button("好", role: .cancel) {}
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}
