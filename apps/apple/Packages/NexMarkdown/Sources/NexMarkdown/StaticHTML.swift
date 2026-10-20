import Foundation
import SwiftSoup

/// Static message markup only. Keep tags/styles aligned with src/personal/static-html.ts.
public enum StaticHTML {
    /// Generated from the exact TypeScript renderer used by the web clients.
    public static let chartScript: String = {
        guard let url = Bundle.module.url(forResource: "chat-charts", withExtension: "js"),
              let value = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return value
    }()
    public static let tags = "a b strong i em s del u mark small sub sup span div p br hr h1 h2 h3 h4 h5 h6 blockquote pre code kbd ul ol li dl dt dd table caption thead tbody tfoot tr th td".split(separator: " ").map(String.init)
    private static let blocked = "script style iframe frame frameset object embed svg math template noscript form textarea select option button audio video canvas link meta base"

    public static func safeLink(_ value: String) -> Bool {
        guard value.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil,
              value.range(of: "[\\x00-\\x20\\x7f\\\\]", options: .regularExpression) == nil,
              let url = URL(string: value), url.host?.isEmpty == false, url.user == nil, url.password == nil else { return false }
        return true
    }

    public static func style(_ source: String) -> String {
        source.split(separator: ";").compactMap { declaration -> String? in
            let parts = declaration.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { return nil }
            let name = parts[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let pattern: String
            switch name {
            case "color", "background-color": pattern = "^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]{1,20}|rgba?\\([0-9.,%\\s]+\\))$"
            case "text-align": pattern = "^(left|center|right|justify)$"
            case "font-weight": pattern = "^(normal|bold|bolder|lighter|[1-9]00)$"
            case "font-style": pattern = "^(normal|italic|oblique)$"
            case "text-decoration": pattern = "^(none|underline|line-through)$"
            case "font-size": pattern = "^(1[0-9]|2[0-9]|3[0-2])px$"
            case "white-space": pattern = "^(normal|pre|pre-wrap|pre-line)$"
            case "border-collapse": pattern = "^(collapse|separate)$"
            default: return nil
            }
            return value.range(of: pattern, options: .regularExpression) != nil ? "\(name):\(value)" : nil
        }.joined(separator: ";")
    }

    public static func sanitize(_ source: String) -> String {
        do {
            let document = try SwiftSoup.parseBodyFragment(source)
            try document.select(blocked.split(separator: " ").joined(separator: ",")).remove()
            for element in try document.getAllElements() {
                if element.hasAttr("class") {
                    if element.tagName() == "code", try element.classNames().contains("language-chart") {
                        try element.attr("class", "language-chart")
                    } else { try element.removeAttr("class") }
                }
                if element.hasAttr("style") { try element.attr("style", style(element.attr("style"))) }
                if element.hasAttr("href"), !safeLink(try element.attr("href")) { try element.removeAttr("href") }
                if element.tagName() == "input" {
                    if try element.attr("type").lowercased() != "checkbox" { try element.remove(); continue }
                    try element.attr("type", "checkbox").attr("disabled", "")
                }
                if element.tagName() == "img" {
                    try element.replaceWith(TextNode(element.attr("alt"), ""))
                }
                for name in ["colspan", "rowspan"] where element.hasAttr(name) {
                    let value = Int(try element.attr(name)) ?? 1
                    try element.attr(name, String(max(1, min(100, value))))
                }
            }
            let allowed = Whitelist.none()
            for tag in tags + ["input"] { try allowed.addTags(tag) }
            try allowed.addAttributes(":all", "title", "style")
            try allowed.addAttributes("a", "href").addProtocols("a", "href", "http", "https")
            try allowed.addAttributes("input", "type", "checked", "disabled")
            try allowed.addAttributes("ol", "start")
            try allowed.addAttributes("code", "class")
            for tag in ["th", "td"] { try allowed.addAttributes(tag, "align", "colspan", "rowspan") }
            return try SwiftSoup.clean(document.body()?.html() ?? "", allowed) ?? ""
        } catch {
            // Never fall back to unfiltered HTML on parser failure.
            return source.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
    }

    public static func document(fragment: String, fontSize: Double, dark: Bool) -> String {
        let size = min(32, max(10, fontSize.isFinite ? fontSize : 14))
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
        :root{color-scheme:\(dark ? "dark" : "light")}*{box-sizing:border-box}
        html,body{margin:0;padding:0;background:transparent}
        body{font:\(size)px -apple-system,sans-serif;line-height:1.6;color:\(dark ? "#e7e7e7" : "#202825");overflow-wrap:anywhere}
        p{margin:0 0 .7em}p:last-child{margin-bottom:0}pre{white-space:pre;overflow-x:auto;padding:10px;background:#8881;border-radius:8px}
        code,kbd{font-family:ui-monospace,monospace;background:#8881}table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto}
        th,td{border:1px solid #8885;padding:8px 12px;min-width:64px}th{background:#8881}
        blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #8885}ul,ol{padding-left:24px}a{color:\(dark ? "#8ab4f8" : "#1967d2")}
        </style></head><body>\(fragment)</body></html>
        """
    }
}
