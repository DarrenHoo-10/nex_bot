import Foundation

/// Binary frames of the terminal stream: `[u8 type][u32 little-endian sid][payload]`. Port of `shared/cli-agent-frames.ts`.
public enum CliFrame: Sendable, Equatable {
    /// Terminal output, device to client.
    case output(sid: UInt32, payload: Data)
    /// Keystrokes, client to device.
    case input(sid: UInt32, payload: Data)

    public static let outputType: UInt8 = 0x01
    public static let inputType: UInt8 = 0x02
    public static let headerSize = 5
    public static let payloadMax = 65536

    /// Nil for a short frame, an unknown type or a payload over the limit.
    public static func decode(_ data: Data) -> CliFrame? {
        guard data.count >= headerSize, data.count - headerSize <= payloadMax else { return nil }
        let bytes = [UInt8](data.prefix(headerSize))
        let sid = UInt32(bytes[1]) | UInt32(bytes[2]) << 8 | UInt32(bytes[3]) << 16 | UInt32(bytes[4]) << 24
        let payload = Data(data.dropFirst(headerSize))
        switch bytes[0] {
        case outputType: return .output(sid: sid, payload: payload)
        case inputType: return .input(sid: sid, payload: payload)
        default: return nil
        }
    }

    public func encode() -> Data {
        let (type, sid, payload): (UInt8, UInt32, Data)
        switch self {
        case .output(let s, let p): (type, sid, payload) = (Self.outputType, s, p)
        case .input(let s, let p): (type, sid, payload) = (Self.inputType, s, p)
        }
        var out = Data([type, UInt8(sid & 0xFF), UInt8((sid >> 8) & 0xFF), UInt8((sid >> 16) & 0xFF), UInt8((sid >> 24) & 0xFF)])
        out.append(payload)
        return out
    }

    /// Keystrokes as input frames of at most `payloadMax` bytes each. Nothing for empty input.
    public static func inputFrames(sid: UInt32, _ bytes: Data) -> [Data] {
        guard !bytes.isEmpty else { return [] }
        var frames: [Data] = []
        var start = bytes.startIndex
        while start < bytes.endIndex {
            let end = bytes.index(start, offsetBy: payloadMax, limitedBy: bytes.endIndex) ?? bytes.endIndex
            frames.append(CliFrame.input(sid: sid, payload: Data(bytes[start..<end])).encode())
            start = end
        }
        return frames
    }
}
