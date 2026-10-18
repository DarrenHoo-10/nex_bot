import Foundation

/// `--profile=NAME` / `NEXBOT_PROFILE` and `--origin=URL` / `NEXBOT_CORE_ORIGIN`. Arguments win over the environment.
public struct LaunchOptions: Sendable, Equatable {
    public var profile: String?
    public var origin: String?

    public init(profile: String? = nil, origin: String? = nil) { self.profile = profile; self.origin = origin }

    public static func parse(arguments: [String], environment: [String: String]) -> LaunchOptions {
        func argument(_ prefix: String) -> String? { arguments.first { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) } }
        func nonEmpty(_ s: String?) -> String? { s?.isEmpty == false ? s : nil }
        return LaunchOptions(profile: nonEmpty(argument("--profile=") ?? environment["NEXBOT_PROFILE"]),
                             origin: nonEmpty(argument("--origin=") ?? environment["NEXBOT_CORE_ORIGIN"]))
    }

    /// Options of the running process.
    public static var current: LaunchOptions { parse(arguments: CommandLine.arguments, environment: ProcessInfo.processInfo.environment) }

    /// The validated override, or nil. Throws ``CoreError`` for a malformed address.
    public func originOverride() throws -> CoreOrigin? { try origin.map { try CoreOrigin($0) } }
}
