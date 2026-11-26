import SwiftUI
import NexClientKit

struct ChatSkillPicker: View {
    let load: () async throws -> [ChatSkill]
    let select: (ChatSkill) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var skills: [ChatSkill]?
    @State private var query = ""
    @State private var error: String?
    @State private var attempt = 0
    @FocusState private var searching: Bool

    private func score(_ text: String, term: String) -> Int? {
        if text == term { return 0 }
        if text.hasPrefix(term) { return 1 }
        if text.contains(term) { return 2 }
        var rest = text[...]
        for char in term {
            guard let at = rest.firstIndex(of: char) else { return nil }
            rest = rest[rest.index(after: at)...]
        }
        return 4
    }

    private var matches: [ChatSkill] {
        let terms = query.precomposedStringWithCompatibilityMapping.lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "/$ ")).split(whereSeparator: \.isWhitespace).map(String.init)
        return (skills ?? []).compactMap { skill -> (ChatSkill, Int)? in
            var total = 0
            let skillName = skill.name.precomposedStringWithCompatibilityMapping.lowercased()
            let skillDescription = skill.description.precomposedStringWithCompatibilityMapping.lowercased()
            for term in terms {
                let name = score(skillName, term: term)
                let description = score(skillDescription, term: term).map { $0 + 3 }
                guard let best = [name, description].compactMap({ $0 }).min() else { return nil }
                total += best
            }
            return (skill, total)
        }.sorted { lhs, rhs in
            lhs.1 == rhs.1 ? lhs.0.name.localizedStandardCompare(rhs.0.name) == .orderedAscending : lhs.1 < rhs.1
        }.map { $0.0 }
    }

    private func choose(_ skill: ChatSkill) { select(skill); dismiss() }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("技能").font(.headline); Spacer(); Button("关闭") { dismiss() } }
            TextField("搜索技能", text: $query).textFieldStyle(.roundedBorder).focused($searching)
                .onSubmit { if let first = matches.first { choose(first) } }
            if let error {
                Text(error).font(.caption).foregroundStyle(Theme.danger)
                Button("重试") { attempt += 1 }
            } else if let skills {
                let rows = matches
                if rows.isEmpty { Text(skills.isEmpty ? "暂无可用技能" : "没有匹配的技能").foregroundStyle(Theme.muted) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(rows) { skill in
                            Button { choose(skill) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(skill.name).fontWeight(.medium)
                                    if !skill.description.isEmpty { Text(skill.description).font(.caption).foregroundStyle(Theme.muted).lineLimit(2) }
                                }.padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                }
            } else { ProgressView("正在读取技能…") }
            Spacer(minLength: 0)
        }
        .padding(16)
        #if os(macOS)
        .frame(width: 380, height: 360)
        #else
        .presentationDetents([.medium, .large])
        #endif
        .onAppear { searching = true }
        .task(id: attempt) {
            error = nil
            do { let rows = try await load(); if !Task.isCancelled { skills = rows } }
            catch let failure { if !Task.isCancelled { error = failure.localizedDescription } }
        }
    }
}
