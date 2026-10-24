import Foundation

extension WorkspaceState {
    /// Active work wins; briefly acknowledge a just-finished task without reviving old results.
    public func avatarTask(botID: String, now: Date = Date()) -> AgentTask? {
        if let active = unfinishedTask(botID: botID) { return active }
        return tasks.filter { task in
            guard task.botID == botID, task.status == "succeeded", let ended = task.endedAt else { return false }
            let age = now.timeIntervalSince(ended)
            return age >= 0 && age < 4
        }.max { ($0.endedAt ?? .distantPast) < ($1.endedAt ?? .distantPast) }
    }
}
