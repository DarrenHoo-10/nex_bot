import Foundation

/// Markdown to `AttributedString` for chat bubbles.
public enum Markdown {
    /// Inline Markdown with whitespace and newlines preserved. Only http(s) links stay clickable.
    public static func attributed(_ source: String) -> AttributedString {
        var text = (try? AttributedString(markdown: source, options: .init(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(source)
        for run in text.runs where run.link != nil && !isOpenable(run.link!) { text[run.range].link = nil }
        return text
    }
    /// Links are opened in the system browser only for http(s) without credentials.
    public static func isOpenable(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return url.user == nil && url.password == nil && url.host != nil
    }
}
