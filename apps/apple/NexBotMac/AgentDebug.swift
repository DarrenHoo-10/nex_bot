#if DEBUG
import SwiftUI
import AppKit
import NexClientKit

/// DEBUG-only automation for the agent dialogs, driven by the file in `NEXBOT_DEBUG_UI_FILE` (consumed line by line).
/// Open dialogs: `newagent`, `editagent`, `avatar`, `policy`, `memoryadd`, `memoryedit`, `closesheets`.
/// Chat: `quote`, `mention`, `actions`, `share`, `previewfile <path>`, `previewstep`, `togglepin`, `welcome`.
/// Direct Core calls: `createagent name|instructions`, `identity name|instructions`, `appearance companion bean plum`,
/// `appearance portrait fox`, `policysave a,b,c`,
/// `memorysave title|content|scope`, `memorydelete`, `recall q`, `reflect q`, `expand q`, `forgetpreview q`, `forgetconfirm q`,
/// `resume`, `archive`.
@MainActor func runAgentDebugCommands(workspace: WorkspaceStore, ui: UIState, preferences: ContactPreferences) async {
    guard let path = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_UI_FILE"] else { return }
    let agentUI = AgentUI.shared
    func log(_ text: String) {
        let line = text + "\n"
        if let handle = FileHandle(forWritingAtPath: path + ".log") { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
        else { try? line.write(toFile: path + ".log", atomically: true, encoding: .utf8) }
    }
    while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(400))
        guard let text = try? String(contentsOfFile: path, encoding: .utf8), !text.isEmpty else { continue }
        try? "".write(toFile: path, atomically: true, encoding: .utf8)
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            let arg = parts.count > 1 ? parts[1] : ""
            let fields = arg.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            guard let id = workspace.selectedBotID else { continue }
            let conv = workspace.conversation(for: id)
            do {
                switch parts.first {
                case "newagent": agentUI.createAgent()
                case "editagent": agentUI.editIdentity(id)
                case "avatar": agentUI.pickAvatar(id)
                case "policy": agentUI.editPolicy(id)
                case "memoryadd": agentUI.editMemory(botID: id)
                case "memoryedit": agentUI.editMemory(botID: id, existing: workspace.state?.memories(botID: id).first)
                case "closesheets":
                    agentUI.editor = nil; agentUI.avatar = nil; agentUI.policy = nil; agentUI.memory = nil
                case "quote":
                    if let m = conv.messages.last(where: { $0.role == "assistant" || $0.role == "user" }) {
                        agentUI.quotes[id] = QuoteDraft(author: senderLabel(m, bot: workspace.bot(id), workspace: workspace), text: m.content)
                    }
                case "mention": conv.draft = arg.isEmpty ? "@" : arg
                case "actions": agentUI.alwaysShowActions.toggle()
                case "share":
                    if let t = workspace.exportTranscript(botID: id) { agentUI.copyToPasteboard(t); log("share copied \(t.count) chars") }
                case "previewfile": agentUI.previewFile(arg, botID: id, workspace: workspace, ui: ui)
                case "previewstep":
                    if let step = conv.messages.reversed().flatMap(\.toolSteps).first { agentUI.previewStep(step, botID: id, workspace: workspace, ui: ui) }
                case "togglepin": preferences.togglePin(id)
                case "createagent":
                    let new = try await workspace.createAgent(name: fields[0], instructions: fields.count > 1 ? fields[1] : "")
                    workspace.select(new); log("created \(new)")
                case "identity": try await workspace.updateIdentity(botID: id, name: fields[0], instructions: fields.count > 1 ? fields[1] : "")
                case "appearance":
                    let w = arg.split(separator: " ").map(String.init)
                    if w.first == "companion", w.count == 3 { try await workspace.updateAppearance(botID: id, .companion(shape: w[1], color: w[2])) }
                    else if w.first == "graphic", w.count == 2, AvatarCatalog.graphic(w[1]) != nil { try await workspace.updateAppearance(botID: id, .graphic(w[1])) }
                    else if w.first == "portrait", w.count == 2 { try await workspace.updateAppearance(botID: id, .portrait(w[1])) }
                case "policysave": try await workspace.updatePolicy(botID: id, tools: arg.split(separator: ",").map(String.init))
                case "memorysave":
                    try await workspace.saveMemory(botID: id, existing: workspace.state?.memories(botID: id).first { $0.title == fields[0] }, title: fields[0], content: fields[1], scope: fields.count > 2 ? fields[2] : "bot")
                case "memorydelete": if let m = workspace.state?.memories(botID: id).first { try await workspace.deleteMemory(m) }
                case "recall": let r = try await workspace.recallMemory(botID: id, query: arg); log("recall \(r.statusText) \(r.facts.count) facts")
                case "reflect": let r = try await workspace.reflectMemory(botID: id, query: arg); log("reflect \(r.statusText) \(r.answers.count)")
                case "forgetpreview": let p = try await workspace.previewForget(botID: id, query: arg); log("forgetpreview \(p.confirmationDetail(botNames: [:]))")
                case "forgetconfirm":
                    let p = try await workspace.previewForget(botID: id, query: arg)
                    let r = try await workspace.forget(botID: id, query: arg, preview: p); log("forget \(r.statusText)")
                case "resume": if let t = workspace.state?.unfinishedTasks(botID: id).first(where: { $0.status == "paused" }) { try await workspace.resumeTask(t.id) }
                case "archive": try await workspace.archiveAgent(botID: id)
                default: break
                }
            } catch { log("ERR \(line): \(message(of: error))") }
        }
    }
}
#endif
