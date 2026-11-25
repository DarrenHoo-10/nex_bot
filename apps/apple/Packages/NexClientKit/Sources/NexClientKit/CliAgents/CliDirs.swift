import Foundation

// Folders on a computer for the new-session page, and how full a session's context is. Ports of
// `directory-source.ts` and the context ring of `Composer.tsx`.

public struct CliDirEntry: Sendable, Hashable, Identifiable, Decodable {
    public var name: String
    public var path: String
    public var git: Bool
    public var id: String { path }
    public init(name: String, path: String, git: Bool = false) { self.name = name; self.path = path; self.git = git }
    enum CodingKeys: String, CodingKey { case name, path, git }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        path = try c.decode(String.self, forKey: .path)
        git = (try? c.decodeIfPresent(Bool.self, forKey: .git)) ?? false
    }
}

/// `GET /api/cli-agents/dirs`: one folder's sub-folders; `path` "" is the roots view.
public struct CliDirListing: Sendable, Hashable, Decodable {
    public var path: String
    public var parent: String?
    public var exists: Bool
    public var git: Bool
    public var entries: [CliDirEntry]
    public init(path: String, parent: String? = nil, exists: Bool = true, git: Bool = false, entries: [CliDirEntry] = []) {
        self.path = path; self.parent = parent; self.exists = exists; self.git = git; self.entries = entries
    }
    enum CodingKeys: String, CodingKey { case path, parent, exists, git, entries }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        parent = try? c.decodeIfPresent(String.self, forKey: .parent)
        exists = (try? c.decode(Bool.self, forKey: .exists)) ?? false
        git = (try? c.decodeIfPresent(Bool.self, forKey: .git)) ?? false
        entries = (try? c.decodeIfPresent(LossyList<CliDirEntry>.self, forKey: .entries))?.values ?? []
    }
}

public enum CliPaths {
    static func isDrive(_ path: String) -> Bool {
        let chars = Array(path)
        return chars.count >= 2 && chars[0].isLetter && chars[0].isASCII && chars[1] == ":" && (chars.count == 2 || (chars.count == 3 && (chars[2] == "\\" || chars[2] == "/")))
    }
    static func isWindows(_ path: String) -> Bool {
        let chars = Array(path)
        return path.hasPrefix("\\\\") || (chars.count >= 2 && chars[0].isLetter && chars[1] == ":")
    }
    public static func separator(_ path: String) -> String { isWindows(path) ? "\\" : "/" }

    /// Drive paths keep their trailing separator (`D:\`); anything else loses it.
    public static func clean(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        if isDrive(trimmed) { return String(trimmed.prefix(2)) + "\\" }
        if trimmed == "/" { return "/" }
        var out = trimmed
        while out.count > 1, out.hasSuffix("/") || out.hasSuffix("\\") { out.removeLast() }
        return out
    }

    public static func isAbsolute(_ path: String) -> Bool { CliSessions.isAbsoluteCwd(path) || isDrive(path) }

    public static func parent(_ path: String) -> String? {
        let c = clean(path)
        if c.isEmpty || c == "/" || (isDrive(c) && c.count == 3) { return nil }
        guard let at = c.lastIndex(where: { $0 == "\\" || $0 == "/" }) else { return nil }
        let up = String(c[c.startIndex..<at])
        if up.count == 2, isDrive(up) { return up + "\\" }
        return up.isEmpty ? "/" : up
    }

    public static func join(_ base: String, _ name: String) -> String {
        let c = clean(base), sep = separator(c)
        let tail = name.trimmingCharacters(in: CharacterSet(charactersIn: "\\/")).replacingOccurrences(of: sep == "\\" ? "/" : "\\", with: sep)
        return (c.hasSuffix(sep) ? c : c + sep) + tail
    }

    public static func name(_ path: String) -> String {
        let c = clean(path)
        if c == "/" || (isDrive(c) && c.count == 3) { return c }
        return c.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? c
    }

    /// The folders from the top down to `path`, for breadcrumbs.
    public static func crumbs(_ path: String) -> [(label: String, path: String)] {
        var out: [(String, String)] = []
        var at: String? = path.isEmpty ? nil : clean(path)
        while let current = at { out.insert((name(current), current), at: 0); at = parent(current) }
        return out
    }

    public enum Query: Equatable { case filter(String), path(String) }

    /// What the picker's text box means: a filter on the current folder, or a path (absolute, or below the current folder).
    public static func read(_ query: String, current: String) -> Query {
        let text = query.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return .filter("") }
        if isAbsolute(text) { return .path(clean(text)) }
        if text.contains("/") || text.contains("\\"), !current.isEmpty { return .path(join(current, text)) }
        return .filter(text)
    }

    /// A folder name a computer accepts.
    public static func validName(_ name: String) -> Bool {
        let bad = CharacterSet(charactersIn: "<>:\"|?*\\/").union(.controlCharacters)
        return !name.isEmpty && name.count <= 120 && name.rangeOfCharacter(from: bad) == nil && !name.hasSuffix(".") && !name.hasSuffix(" ")
    }
}

public enum CliContext {
    public static func share(_ usage: CliContextUsage?) -> Double? {
        guard let usage, let window = usage.window, window > 0 else { return nil }
        return min(1, Double(usage.used) / Double(window))
    }

    public enum Level: String, Sendable { case none, low, high, full }
    /// calm below 70%, a warning to 90%, then the session is about to compact
    public static func level(_ usage: CliContextUsage?) -> Level {
        guard let s = share(usage) else { return .none }
        return s >= 0.9 ? .full : s >= 0.7 ? .high : .low
    }

    /// Tokens in K/M like the CLIs and the assistant's usage: 950, 47.5K, 475K, 1M.
    public static func tokens(_ value: Int) -> String { Usage.compactTokens(value) }

    public static func summary(_ usage: CliContextUsage?) -> String {
        guard let usage else { return "上下文用量：暂无记录" }
        guard let s = share(usage), let window = usage.window else { return "上下文已用 \(tokens(usage.used))" }
        return "上下文 \(Int((s * 100).rounded()))% · \(tokens(usage.used)) / \(tokens(window))"
    }
}
