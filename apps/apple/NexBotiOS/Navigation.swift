import SwiftUI
import Observation

/// Navigation of the connected app, shared so it can be driven programmatically.
/// Root is the contacts list; chats, the approvals list and settings are pushed on top.
@MainActor @Observable
final class Navigation {
    enum Route: Hashable { case chat(String), approvals, settings }
    var path: [Route] = []
    /// The account menu sheet.
    var showMenu = false

    /// The agent of the chat on top of the stack.
    var currentBotID: String? {
        if case .chat(let id)? = path.last { return id }
        return nil
    }
}
