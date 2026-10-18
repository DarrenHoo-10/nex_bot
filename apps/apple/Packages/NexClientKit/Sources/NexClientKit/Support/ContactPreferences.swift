import Foundation
import Observation

/// Client-local preferences shared by both apps. Same keys as the web UI's localStorage.
@MainActor @Observable
public final class ContactPreferences {
    public static let pinnedKey = "nexbot.pinnedAgents"
    public static let motionKey = "nexbot.motion"
    public static let selectedKey = "nexbot.selectedAgent"

    @ObservationIgnored private let defaults: UserDefaults
    /// Pinned bot ids in pin order.
    public private(set) var pinnedIDs: [String]
    /// Light animation; on by default. Stored as "0" / "1" like the web.
    public var motionEnabled: Bool { didSet { defaults.set(motionEnabled ? "1" : "0", forKey: Self.motionKey) } }
    /// The last selected agent id.
    public var selectedAgentID: String? {
        didSet { if let id = selectedAgentID { defaults.set(id, forKey: Self.selectedKey) } else { defaults.removeObject(forKey: Self.selectedKey) } }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let raw = defaults.string(forKey: Self.pinnedKey), let data = raw.data(using: .utf8),
           let ids = try? JSONDecoder().decode([String].self, from: data) { pinnedIDs = ids } else { pinnedIDs = [] }
        motionEnabled = defaults.string(forKey: Self.motionKey) != "0"
        selectedAgentID = defaults.string(forKey: Self.selectedKey)
    }

    public func isPinned(_ botID: String) -> Bool { pinnedIDs.contains(botID) }
    public func togglePin(_ botID: String) {
        if let i = pinnedIDs.firstIndex(of: botID) { pinnedIDs.remove(at: i) } else { pinnedIDs.append(botID) }
        if let data = try? JSONEncoder().encode(pinnedIDs), let raw = String(data: data, encoding: .utf8) { defaults.set(raw, forKey: Self.pinnedKey) }
    }

    /// Sidebar grouping: `pinned` (section 置顶) and `rest` (section 我的 Agent), both in server order, filtered by
    /// a case-insensitive match of `name + instructions`.
    public func groups(of bots: [Bot], query: String = "") -> (pinned: [Bot], rest: [Bot]) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let shown = q.isEmpty ? bots : bots.filter { "\($0.name) \($0.instructions)".lowercased().contains(q) }
        return (shown.filter { isPinned($0.id) }, shown.filter { !isPinned($0.id) })
    }
}
