import Foundation
import cmark_gfm

public enum HTMLPreviewPart: Equatable, Sendable {
    case markdown(String)
    case preview(source: String, complete: Bool)
}

/// Explicit top-level fences only, matching shared/html-preview.ts. Model text
/// is never interpolated into the trusted shell or evaluated in its context.
public enum HTMLPreview {
    public static let sourceLimit = 500_000
    public static var shell: String {
        guard let url = Bundle.module.url(forResource: "html-preview", withExtension: "html"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return text
    }

    public static func parts(_ source: String) -> [HTMLPreviewPart] {
        guard source.contains("html-preview") else { return [.markdown(source)] }
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        guard let document = normalized.withCString({ cmark_parse_document($0, normalized.utf8.count, CMARK_OPT_DEFAULT) }) else { return [.markdown(source)] }
        defer { cmark_node_free(document) }
        var parts: [HTMLPreviewPart] = [], cursor = 0, node = cmark_node_first_child(document)
        while let current = node {
            defer { node = cmark_node_next(current) }
            guard cmark_node_get_type(current) == CMARK_NODE_CODE_BLOCK,
                  let info = cmark_node_get_fence_info(current),
                  String(cString: info).trimmingCharacters(in: .whitespaces) == "html-preview" else { continue }
            let start = Int(cmark_node_get_start_line(current)) - 1
            let end = min(lines.count, Int(cmark_node_get_end_line(current)))
            guard start >= cursor, start < end else { continue }
            let opening = lines[start].trimmingCharacters(in: .whitespaces)
            guard let marker = opening.first, marker == "`" || marker == "~" else { continue }
            let count = opening.prefix(while: { $0 == marker }).count
            guard count >= 3, opening.dropFirst(count).trimmingCharacters(in: .whitespaces) == "html-preview" else { continue }
            if start > cursor { parts.append(.markdown(lines[cursor..<start].joined(separator: "\n") + "\n")) }
            let last = lines[end - 1], stripped = last.drop(while: { $0 == " " })
            let closingCount = stripped.prefix(while: { $0 == marker }).count
            let complete = end - start > 1 && last.count - stripped.count <= 3 && closingCount >= count && stripped.dropFirst(closingCount).trimmingCharacters(in: .whitespaces).isEmpty
            let html = cmark_node_get_literal(current).map { String(cString: $0) } ?? ""
            // cmark retains a trailing newline; mdast omits it.
            parts.append(.preview(source: html.hasSuffix("\n") ? String(html.dropLast()) : html, complete: complete))
            cursor = end
        }
        if cursor < lines.count || parts.isEmpty { parts.append(.markdown(lines[cursor...].joined(separator: "\n"))) }
        return parts
    }
}
