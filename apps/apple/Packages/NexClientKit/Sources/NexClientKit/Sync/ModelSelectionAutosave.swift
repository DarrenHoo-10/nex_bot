import Foundation
import Observation

/// Saves a model choice as soon as it changes (web `useModelSelection`), used for 显示的模型 and 生图模型.
/// Writes are serialized: choices made while a save is in flight stay in the draft and go out with the
/// version the previous answer returned. A failed save reverts to the last confirmed choice.
@MainActor @Observable
public final class ModelSelectionAutosave {
    public typealias Save = @MainActor (_ models: [String]?, _ version: Int) async throws -> ModelVisibility

    /// What the list shows: the latest choice, saved or still saving.
    public private(set) var selection: [String]?
    public private(set) var busy = false
    /// "未保存：…" after a failed save.
    public private(set) var error = ""

    @ObservationIgnored private var confirmed: ModelVisibility
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private let save: Save

    public init(initial: ModelVisibility, save: @escaping Save) {
        confirmed = initial; selection = initial.models; self.save = save
    }

    /// Adopts a newer stored value (another device changed it) unless a save is in flight.
    public func sync(_ stored: ModelVisibility) {
        guard !busy, stored.version > confirmed.version else { return }
        confirmed = stored; selection = stored.models
    }

    /// Toggles one model. `all` is what "everything" means while the choice is nil (show all).
    public func toggle(_ model: String, all: [String]) {
        var next = Set(selection ?? all)
        if next.contains(model) { next.remove(model) } else { next.insert(model) }
        set(next.sorted())
    }

    /// Replaces the whole choice (`nil` shows every model).
    public func set(_ models: [String]?) {
        selection = models; revision += 1; error = ""
        Task { await persist() }
    }

    private func persist() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            while true {
                let sent = revision
                let result = try await save(selection, confirmed.version)
                confirmed = result
                if sent == revision { selection = result.models; break }
            }
        } catch {
            selection = confirmed.models
            self.error = "未保存：" + ((error as? CoreError)?.message ?? "请重新选择")
        }
    }
}
