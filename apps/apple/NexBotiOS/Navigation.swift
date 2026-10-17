import SwiftUI
import Observation

/// Tab selection and the 会话 navigation path, shared so they can be driven programmatically.
@MainActor @Observable
final class Navigation {
    enum Tab: Hashable { case chats, approvals, settings }
    var tab: Tab = .chats
    var path: [String] = []
}
