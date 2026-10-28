import Foundation

/// Which consecutive assistant replies read as one group (web `sameGroup`): same agent, no agent-to-agent
/// marker, no more than five minutes apart and on the same day. A group shows the avatar and the time once, on its last message.
public enum MessageGrouping {
    public static let window: TimeInterval = 5 * 60

    public static func joins(_ previous: AgentMessage?, _ message: AgentMessage, timeZone: TimeZone = .current) -> Bool {
        guard let previous, plain(previous), plain(message),
              (previous.senderBotID ?? "") == (message.senderBotID ?? ""),
              let before = previous.createdAt, let at = message.createdAt else { return false }
        let gap = at.timeIntervalSince(before)
        guard gap >= 0, gap <= window else { return false }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        return calendar.isDate(before, inSameDayAs: at)
    }

    /// True when the next message does not continue this one's group.
    public static func ends(_ message: AgentMessage, next: AgentMessage?, timeZone: TimeZone = .current) -> Bool {
        guard let next else { return true }
        return !joins(message, next, timeZone: timeZone)
    }

    private static func plain(_ message: AgentMessage) -> Bool {
        message.role == "assistant" && (message.a2aDirection ?? "").isEmpty
    }
}

/// The tool-activity capsule: up to three kinds of tool as icons, the step count and how many steps failed.
public enum ToolActivity {
    public struct Summary: Equatable, Sendable {
        /// SF Symbol names, one per distinct kind, in order of first use (at most three).
        public var symbols: [String]
        public var count: Int
        /// Steps whose status is `failed`.
        public var failed: Int
    }

    public static func summary(_ steps: [ToolStep]) -> Summary {
        var symbols: [String] = []
        for step in steps { let symbol = symbol(for: step.toolName); if !symbols.contains(symbol) { symbols.append(symbol) } }
        return Summary(symbols: Array(symbols.prefix(3)), count: steps.count, failed: steps.filter { $0.status == "failed" }.count)
    }

    /// Same kinds as the web capsule, in the same order of precedence.
    public static func symbol(for tool: String) -> String {
        if tool.hasPrefix("memory.") { return "brain" }
        if tool == "device.exec" { return "terminal" }
        if tool == "device.computer" { return "display" }
        if tool.hasPrefix("device.") { return "folder" }
        if tool.hasPrefix("connector.") { return "powerplug" }
        if tool.hasPrefix("agent.") { return "person.2" }
        if tool.hasPrefix("routine.") { return "clock" }
        if tool.hasPrefix("image.") { return "photo" }
        if tool.hasPrefix("html.") { return "chevron.left.forwardslash.chevron.right" }
        if tool.hasPrefix("skill.") { return "book" }
        if tool.hasPrefix("attachment.") { return "paperclip" }
        return "wrench"
    }
}

extension TimeFormat {
    /// "09:05": the clock time of a journal row.
    public static func formatClock(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
}
