import SwiftUI
import Observation
import NexClientKit

/// Categories of the Settings screen (chips at the top).
enum SettingsCategory: String, CaseIterable {
    case account = "账号与登录设备", model = "模型", memory = "长期记忆", connectors = "连接器", devices = "设备"
    var icon: String {
        switch self { case .account: "person"; case .model: "key"; case .memory: "sparkles"; case .connectors: "powerplug"; case .devices: "cpu" }
    }
}

/// Tabs of the agent detail screen.
enum AgentDetailTab: String, CaseIterable { case work = "工作", settings = "设置" }

/// Navigation of the connected app, shared (as an environment object) so any view can drive it.
/// Root is the contacts list; chats, the approvals list, settings and the other pages are pushed on top.
@MainActor @Observable
final class Navigation {
    enum Route: Hashable { case chat(String), approvals, settings, agentDetail(String) }
    var path: [Route] = []
    /// The account menu sheet.
    var showMenu = false
    /// The category Settings shows.
    var settingsCategory = SettingsCategory.account
    /// The tab AgentDetailView shows.
    var detailTab = AgentDetailTab.work

    /// The agent of the chat (or its detail screen) on top of the stack.
    var currentBotID: String? {
        switch path.last {
        case .chat(let id)?, .agentDetail(let id)?: id
        default: nil
        }
    }

    // MARK: Router

    /// Pushes a route unless it is already on top.
    func push(_ route: Route) { showMenu = false; if path.last != route { path.append(route) } }
    func openChat(_ botID: String) { showMenu = false; path = [.chat(botID)] }
    /// Connectors and devices are Settings categories, not pages of their own.
    func openConnectors() { openSettings(.connectors) }
    func openDevices() { openSettings(.devices) }
    /// Pushes the agent detail screen, optionally at a tab (e.g. 工作 for a file preview).
    func openAgentDetail(_ botID: String, tab: AgentDetailTab = .work) { detailTab = tab; push(.agentDetail(botID)) }
    /// Pushes Settings at a category (e.g. 模型 from 配置 API Key).
    func openSettings(_ category: SettingsCategory = .account) {
        settingsCategory = category
        if case .settings? = path.last { showMenu = false } else { push(.settings) }
    }

    /// The screen for a route. Kept here so the route table has one owner.
    @ViewBuilder
    func destination(for route: Route, model: AppModel, workspace: WorkspaceStore) -> some View {
        switch route {
        case .chat(let id): ChatView(workspace: workspace, botID: id)
        case .approvals: ApprovalsView(workspace: workspace)
        case .settings: SettingsView(model: model, workspace: workspace)
        case .agentDetail(let id): AgentDetailView(workspace: workspace, botID: id)
        }
    }
}
