import Foundation

public struct ChatSkill: Decodable, Sendable, Identifiable {
    public let name: String
    public let description: String
    public var id: String { name }

    public func adding(to draft: String, engine: CliEngine? = nil) -> String {
        if let engine { return (engine == .codex ? "$" : "/") + name + " " + draft }
        return "请用 skill.read 读取并使用「\(name)」技能。\n" + draft
    }
}

struct ChatSkillCatalog: Decodable, Sendable {
    let skills: [ChatSkill]
}
