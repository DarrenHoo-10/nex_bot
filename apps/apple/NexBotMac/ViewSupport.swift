import SwiftUI
import NexClientKit

func mbFallbackMessage(_ error: Error) -> String {
    let text = CoreError.wrap(error).message
    return text.isEmpty ? "操作失败，请重试" : text
}

/// A 1pt hairline in the web UI's border color.
struct Hairline: View {
    var vertical = false
    var body: some View {
        Theme.border.frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

#if DEBUG
/// DEBUG: appends a line to `$NEXBOT_DEBUG_COMMAND_FILE.b.log`.
func mbLog(_ text: String) {
    guard let base = ProcessInfo.processInfo.environment["NEXBOT_DEBUG_COMMAND_FILE"] else { return }
    let path = base + ".b.log", line = text + "\n"
    if let handle = FileHandle(forWritingAtPath: path) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
    else { try? line.write(toFile: path, atomically: true, encoding: .utf8) }
}
#endif
