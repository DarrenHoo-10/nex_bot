import NexClientKit

func mbFallbackMessage(_ error: Error) -> String {
    let text = CoreError.wrap(error).message
    return text.isEmpty ? "操作失败，请重试" : text
}
