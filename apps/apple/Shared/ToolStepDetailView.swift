import SwiftUI
import NexClientKit

/// One semantic section of a tool step preview (ported from `src/personal/components/ToolStepDetail.tsx`).
struct ToolStepBlock: Identifiable, Hashable {
    let id = UUID()
    let label: String
    let text: String
    let mono: Bool
}

enum ToolStepFormatter {
    private static let resultFields = ["content", "text", "output", "stdout", "value", "message", "result", "error"]
    private static let quietResults: Set<String> = ["memory.write", "memory.core.update"]
    private static let resultLabels: [String: String] = [
        "device.exec": "执行输出",
        "device.read": "文件内容",
        "memory.search": "检索结果",
        "memory.read": "记忆内容",
        "memory.reflect": "综合结果",
        "attachment.read": "附件内容",
        "skill.read": "技能说明",
        "connector.call": "连接器返回",
    ]

    private static func parseJSON(_ raw: String?) -> JSONValue? {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    private static func textOf(_ value: JSONValue?) -> String {
        guard let value else { return "" }
        switch value {
        case .string(let s): return s.trimmingCharacters(in: .whitespacesAndNewlines)
        case .number(let n):
            if n.rounded() == n, abs(n) < 1e15 { return String(Int64(n)) }
            return String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return ""
        case .array, .object: return prettyJSON(value) ?? ""
        }
    }

    private static func resultOf(_ item: PreviewItem) -> (text: String, mono: Bool) {
        let raw = item.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if let parsed = parseJSON(raw) {
            if case .string(let s) = parsed { return (s, false) }
            if case .object(let dict) = parsed {
                for field in resultFields {
                    if case .string(let value) = dict[field], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        return (value.trimmingCharacters(in: .whitespacesAndNewlines), false)
                    }
                }
            }
        }
        return (raw, true)
    }

    /// `memory.core.update` patches read as plain edit lines instead of nested JSON.
    private static func corePatchLines(_ patch: JSONValue?) -> String {
        guard let source = patch?.objectValue else { return "" }
        var lines: [String] = []
        let about = source["about"]?.objectValue ?? [:]
        let topics = source["topics"]?.objectValue ?? [:]
        for entry in about["add"]?.arrayValue ?? [] {
            let line = textOf(entry)
            if !line.isEmpty { lines.append("新增：\(line)") }
        }
        for entry in about["update"]?.arrayValue ?? [] {
            let row = entry.objectValue ?? [:]
            let idx = textOf(row["index"])
            lines.append("更新第 \(idx.isEmpty ? "…" : idx) 条：\(textOf(row["text"]))")
        }
        for entry in about["remove"]?.arrayValue ?? [] {
            lines.append("移除第 \(textOf(entry)) 条")
        }
        for entry in topics["add"]?.arrayValue ?? [] {
            let row = entry.objectValue ?? [:]
            lines.append("新增主题「\(textOf(row["title"]))」：\(textOf(row["line"]))")
        }
        for entry in topics["update"]?.arrayValue ?? [] {
            let row = entry.objectValue ?? [:]
            let key = [textOf(row["title"]), textOf(row["ref"]), textOf(row["index"])].first(where: { !$0.isEmpty }) ?? ""
            let val = [textOf(row["line"]), textOf(row["newRef"])].first(where: { !$0.isEmpty }) ?? ""
            lines.append("更新主题「\(key)」：\(val)")
        }
        for entry in topics["remove"]?.arrayValue ?? [] {
            let row = entry.objectValue ?? [:]
            let key: String
            if !row.isEmpty {
                key = [textOf(row["title"]), textOf(row["ref"]), textOf(row["index"])].first(where: { !$0.isEmpty }) ?? ""
            } else {
                key = textOf(entry)
            }
            lines.append("移除主题「\(key)」")
        }
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    static func blocks(tool: String, item: PreviewItem) -> [ToolStepBlock] {
        let rawArgs = item.row.string("arguments") ?? item.arguments
        let parsedArgs = parseJSON(rawArgs)
        let fields = parsedArgs?.objectValue ?? [:]
        var blocks: [ToolStepBlock] = []
        func push(_ label: String, _ text: String, mono: Bool = false) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { blocks.append(ToolStepBlock(label: label, text: trimmed, mono: mono)) }
        }
        func value(_ key: String) -> String { textOf(fields[key]) }

        if tool == "memory.write" {
            push("记忆标题", value("title"))
            push("写入内容", value("content"))
        } else if tool == "memory.core.update" {
            push("记忆变更", corePatchLines(fields["patch"]))
            push("用户原话", value("quote"))
        } else if tool == "memory.search" {
            let q = value("query")
            push("检索内容", q.isEmpty ? value("text") : q)
        } else if tool == "device.exec" {
            push("执行命令", value("command"), mono: true)
        } else if tool == "device.read" {
            push("读取路径", value("path"), mono: true)
        } else if tool == "image.generate" {
            push("生图提示词", value("prompt"))
        }

        if blocks.isEmpty {
            if let parsedArgs {
                let pretty: String
                if case .string(let s) = parsedArgs { pretty = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                else { pretty = prettyJSON(parsedArgs) ?? "" }
                if !pretty.isEmpty && pretty != "{}" && pretty != "[]" {
                    push("调用参数", pretty, mono: true)
                }
            } else if let rawArgs, !rawArgs.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                push("调用参数", rawArgs, mono: true)
            }
        }

        if !item.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let result = resultOf(item)
            if !(result.mono && item.status != "failed" && quietResults.contains(tool)) {
                push(resultLabels[tool] ?? "执行结果", result.text, mono: result.mono || tool == "device.exec")
            }
        }
        return blocks
    }
}

/// Semantic formatted view of one tool call's arguments and result (matches Web `ToolStepDetail.tsx`).
struct ToolStepDetailView: View {
    let tool: String
    let item: PreviewItem?
    var loading = false
    var error: String? = nil
    var fallback: String? = nil

    var body: some View {
        if loading {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("正在加载…").font(.caption).foregroundStyle(Theme.muted)
            }
            .padding(.vertical, 4)
        } else {
            let blocks = item.map { ToolStepFormatter.blocks(tool: tool, item: $0) } ?? []
            if blocks.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    if let error, !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled)
                    }
                    let text = fallback?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    Text(text.isEmpty ? "暂无输出内容" : text)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .textSelection(.enabled)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    if let error, !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(Theme.danger).textSelection(.enabled)
                    }
                    ForEach(blocks) { block in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(block.label)
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(Theme.muted)
                            if block.mono {
                                ToolCodeBlock(text: block.text, maxHeight: 180)
                                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            } else {
                                Text(block.text)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.foreground)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Flat inline tool steps list (shown directly inside `MoreContent`, removing double-collapse)
/// with per-step expandable semantic `ToolStepDetailView`.
struct InlineToolStepsList: View {
    let workspace: WorkspaceStore
    let steps: [ToolStep]
    var onPreviewFile: ((String) -> Void)? = nil
    @State private var expandedID: String?
    @State private var previews: [String: PreviewItem] = [:]
    @State private var loadingIDs: Set<String> = []
    @State private var errors: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(steps) { step in
                let isOpen = expandedID == step.id
                VStack(alignment: .leading, spacing: 6) {
                    Button { toggle(step) } label: {
                        HStack(alignment: .center, spacing: 7) {
                            Circle().fill(dotColor(step.status)).frame(width: 6, height: 6)
                            Text(step.label)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Theme.foreground)
                            if !step.summary.isEmpty {
                                Text(step.summary)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(Theme.muted)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                            }
                            Spacer(minLength: 4)
                            Text(ToolLabels.statusText(step.status))
                                .font(.system(size: 11))
                                .foregroundStyle(statusInk(step.status))
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(Theme.muted.opacity(0.7))
                                .rotationEffect(.degrees(isOpen ? 90 : 0))
                        }
                        .padding(.vertical, 5).padding(.horizontal, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(isOpen ? "点击收起" : "点击展开详情")

                    if isOpen {
                        ToolStepDetailView(
                            tool: step.toolName,
                            item: previews[step.id],
                            loading: loadingIDs.contains(step.id),
                            error: errors[step.id],
                            fallback: step.preview
                        )
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border))
                        .padding(.horizontal, 4).padding(.bottom, 4)
                    }
                }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: 560, alignment: .leading)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
    }

    private func toggle(_ step: ToolStep) {
        if step.toolName == "device.read", !step.summary.isEmpty, let onPreviewFile {
            onPreviewFile(step.summary)
            return
        }
        if expandedID == step.id {
            withAnimation(.easeOut(duration: 0.14)) { expandedID = nil }
            return
        }
        withAnimation(.easeOut(duration: 0.14)) { expandedID = step.id }
        guard previews[step.id] == nil, !loadingIDs.contains(step.id) else { return }
        loadingIDs.insert(step.id)
        errors[step.id] = nil
        Task {
            defer { loadingIDs.remove(step.id) }
            do {
                previews[step.id] = try await workspace.previewTool(callID: step.id)
            } catch {
                previews[step.id] = .fallback(step: step)
                errors[step.id] = nil
            }
        }
    }

    private func dotColor(_ status: String) -> Color {
        switch status {
        case "succeeded": Theme.success
        case "failed", "rejected": Theme.danger
        case "running", "pending", "queued", "awaiting_approval": Theme.approval
        default: Theme.muted
        }
    }

    private func statusInk(_ status: String) -> Color {
        switch status {
        case "failed", "rejected": Theme.danger
        case "running", "pending", "queued", "awaiting_approval": Theme.approval
        default: Theme.muted
        }
    }
}
