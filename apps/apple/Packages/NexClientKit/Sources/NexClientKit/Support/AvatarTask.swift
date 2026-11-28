import Foundation

extension WorkspaceState {
    /// Active main-chat work wins; else an active background job; else briefly acknowledge a just-finished
    /// succeeded (4s) or failed (2.4s) main-chat task without reviving old results.
    public func avatarTask(botID: String, now: Date = Date()) -> AgentTask? {
        if let active = unfinishedTask(botID: botID) { return active }
        if let job = jobs.first(where: { $0.botID == botID && $0.isBusy }) {
            let status = job.stage == "approval" ? "awaiting_approval" : (job.stage == "queued" ? "queued" : "running")
            return AgentTask(row: [
                "id": .string("job-\(job.id)"),
                "bot_id": .string(botID),
                "status": .string(status),
                "objective": .string(job.title),
                "origin": .string("job"),
            ])
        }
        return tasks.filter { task in
            guard task.botID == botID, task.origin == "owner", let ended = task.endedAt else { return false }
            let age = now.timeIntervalSince(ended)
            if task.status == "succeeded" { return age >= 0 && age < 4 }
            if task.status == "failed" { return age >= 0 && age < 2.4 }
            return false
        }.max { ($0.endedAt ?? .distantPast) < ($1.endedAt ?? .distantPast) }
    }
}
