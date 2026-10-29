import Foundation

public struct TodoStep: Codable, Sendable, Hashable {
    public var text: String
    public var done: Bool
    public init(text: String, done: Bool = false) { self.text = text; self.done = done }
}
public struct TodoItem: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var title: String
    public var description: String
    public var owner: String
    public var date: String
    public var priority: String
    public var status: String
    public var version: Int
    public var steps: [TodoStep]
    public var taskId: String?
    public var taskStatus: String?
    public var result: String
    public var log: [String]
    public var createdAt: Double
    public var updatedAt: Double
    public init(date: String = "") {
        id = UUID().uuidString; title = ""; description = ""; owner = "me"; self.date = date
        priority = "普通"; status = "todo"; version = 0; steps = []; result = ""; log = []
        createdAt = 0; updatedAt = 0
    }
    public var statusTitle: String {
        switch status { case "running": "进行中"; case "review": "待验收"; case "done": "已完成"; default: "未开始" }
    }
    public func matches(_ filter: String) -> Bool { filter == "all" || (filter == "running" ? ["running", "review"].contains(status) : status == filter) }
}
public struct TodoList: Decodable, Sendable { public let items: [TodoItem] }
public struct TodoAction: Encodable, Sendable {
    public let id: String
    public let version: Int
    public let action: String
    public let clientId: String
    public let feedback: String?
    public init(_ item: TodoItem, action: String, feedback: String? = nil) {
        id = item.id; version = item.version; self.action = action; self.feedback = feedback; clientId = UUID().uuidString
    }
}
public enum TodoDates {
    public static var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.firstWeekday = 2; c.minimumDaysInFirstWeek = 4; return c }
    public static func key(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }
    public static func parse(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
        return date.flatMap { self.key($0) == key ? $0 : nil }
    }
    public static func days(_ anchor: Date, period: String) -> [Date] {
        if period == "day" { return [anchor] }
        let c = calendar
        if period == "week", let start = c.dateInterval(of: .weekOfYear, for: anchor)?.start { return (0..<7).compactMap { c.date(byAdding: .day, value: $0, to: start) } }
        guard let month = c.dateInterval(of: .month, for: anchor), let start = c.dateInterval(of: .weekOfYear, for: month.start)?.start,
              let last = c.date(byAdding: .day, value: -1, to: month.end), let end = c.dateInterval(of: .weekOfYear, for: last)?.end else { return [] }
        let count = c.dateComponents([.day], from: start, to: end).day ?? 0
        return (0..<count).compactMap { c.date(byAdding: .day, value: $0, to: start) }
    }
}
