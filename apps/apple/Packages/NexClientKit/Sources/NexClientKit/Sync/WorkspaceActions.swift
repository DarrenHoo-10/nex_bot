import Foundation

/// One async throwing method per user action. Each one echoes the version of the *current* row, routes failures
/// through `report` (so an expired session ends the app session) and throws the ``CoreError`` with Core's Chinese
/// message. Mutations call ``WorkspaceStore/refresh()`` after success; read-only calls (recall, preview, ...) do not.
extension WorkspaceStore {
    private func missing(_ what: String) -> CoreError { CoreError(kind: .unsupported, message: what) }

    /// Runs `body`, reporting failures; optionally refreshes afterwards.
    private func act<T: Sendable>(refresh doRefresh: Bool = true, _ body: () async throws -> T) async throws -> T {
        let value: T
        do { value = try await body() } catch { throw report(error) }
        if doRefresh { await refresh() }
        return value
    }
    private func currentBot(_ id: String) throws -> Bot {
        guard let b = bot(id) else { throw missing("Agent 不存在") }
        return b
    }
    private func currentRoutine(_ id: String) throws -> Routine {
        guard let r = state?.routines.first(where: { $0.id == id }) else { throw missing("例行任务不存在") }
        return r
    }
    private func currentConnector(_ id: String) throws -> ConnectorView {
        guard let c = state?.connectors.first(where: { $0.id == id }) else { throw missing("连接器不存在") }
        return c
    }

    // MARK: Agents

    /// Creates an agent and returns its id (select it with ``select(_:)``).
    @discardableResult
    public func createAgent(name: String, instructions: String = "") async throws -> String {
        try await act { try await client.createBot(name: name, instructions: instructions) }
    }
    /// Saves name and instructions; `expertise` is only sent when non-nil.
    public func updateIdentity(botID: String, name: String, instructions: String, expertise: [String]? = nil) async throws {
        let b = try currentBot(botID)
        try await act { try await client.updateBot(id: botID, name: name, instructions: instructions, version: b.version, expertise: expertise) }
    }
    public func updateAppearance(botID: String, _ choice: AppearanceChoice) async throws {
        let b = try currentBot(botID)
        try await act { try await client.updateAppearance(id: botID, appearance: choice, version: b.appearanceVersion) }
    }
    public func updatePolicy(botID: String, tools: [String]) async throws {
        let b = try currentBot(botID)
        try await act { try await client.updatePolicy(id: botID, version: b.policyVersion, tools: tools) }
    }
    /// Switches 标准权限 / 完全权限. Echoes `Bot.approvalModeVersion`; a stale version throws "权限模式已变化，请刷新".
    public func setApprovalMode(botID: String, mode: ApprovalMode) async throws {
        let b = try currentBot(botID)
        try await act { try await client.updateApprovalMode(id: botID, mode: mode, version: b.approvalModeVersion) }
    }
    /// Downloads a sent attachment (`AttachmentLink.id`). The suggested file name comes from Core.
    public func downloadAttachment(id: String) async throws -> (data: Data, filename: String) {
        try await act(refresh: false) { try await client.downloadAttachment(id: id) }
    }
    /// Archives the agent. The store then selects the first remaining agent.
    public func archiveAgent(botID: String) async throws {
        let b = try currentBot(botID)
        try await act { try await client.archiveBot(id: botID, version: b.version) }
    }
    /// Resumes a paused task.
    public func resumeTask(_ taskID: String) async throws { try await act { try await client.resume(task: taskID) } }
    /// Stops a task (any status). Prefer ``ConversationStore/stop()`` for the open conversation.
    public func cancelTask(_ taskID: String) async throws { try await act { try await client.cancel(task: taskID) } }

    // MARK: Routines

    /// Creates (`existing == nil`) or edits a routine; the version comes from the current row. Returns the routine id.
    @discardableResult
    public func saveRoutine(botID: String, existing: Routine? = nil, name: String, prompt: String, schedule: RoutineSchedule, timeZone: String = TimeZone.current.identifier) async throws -> String {
        var draft = RoutineDraft(botID: botID, name: name, prompt: prompt, schedule: schedule, timeZone: timeZone)
        if let existing { draft.id = existing.id; draft.version = (try? currentRoutine(existing.id))?.version ?? existing.version }
        return try await act { try await client.saveRoutine(draft) }
    }
    public func setRoutineEnabled(_ routine: Routine, enabled: Bool) async throws {
        let r = (try? currentRoutine(routine.id)) ?? routine
        try await act { try await client.toggleRoutine(id: r.id, version: r.version, enabled: enabled) }
    }
    /// Runs now. Pass the same `clientID` when retrying so the run is not duplicated.
    public func runRoutine(_ routine: Routine, clientID: String = UUID().uuidString) async throws {
        try await act { try await client.runRoutine(id: routine.id, clientID: clientID) }
    }

    // MARK: Connectors

    /// Adds (`existing == nil`) or edits a connector. `token` blank keeps the credential while URL and transport stay.
    @discardableResult
    public func saveConnector(existing: ConnectorView? = nil, name: String, url: String, transport: String, token: String = "", clearToken: Bool = false) async throws -> String {
        guard existing?.isGmail != true else { throw missing("此连接器使用 Google 授权") }
        var draft = ConnectorDraft(name: name, url: url, transport: transport, token: token, clearToken: clearToken ? true : nil, enabled: existing?.enabled ?? true)
        if let existing { draft.id = existing.id; draft.version = (try? currentConnector(existing.id))?.version ?? existing.version }
        return try await act { try await client.saveConnector(draft) }
    }
    /// Contacts the MCP server and stores its tool catalog. Returns the tool count. State reloads even on failure
    /// because Core stores the test error in the row.
    public func testConnector(_ connectorID: String) async throws -> Int {
        let c = try currentConnector(connectorID)
        do { return try await act { try await client.testConnector(id: c.id, version: c.version) } }
        catch { await refresh(); throw error }
    }
    /// Replaces the tools `botID` may call (empty revokes).
    public func grantConnector(_ connectorID: String, botID: String, tools: [String]) async throws {
        let c = try currentConnector(connectorID)
        try await act { try await client.grantConnector(id: c.id, version: c.version, botID: botID, tools: tools) }
    }
    public func setConnectorEnabled(_ connectorID: String, enabled: Bool) async throws {
        let c = try currentConnector(connectorID)
        try await act { try await client.toggleConnector(id: c.id, version: c.version, enabled: enabled) }
    }
    public func removeConnector(_ connectorID: String) async throws {
        let c = try currentConnector(connectorID)
        try await act { try await client.deleteConnector(id: c.id, version: c.version) }
    }

    public func startGmailAuthorization(connectorID: String? = nil) async throws -> ConnectorOAuthAttempt {
        guard !ended else { throw missing(Self.expiredMessage) }
        let connector = try connectorID.map { try currentConnector($0) }
        guard connector == nil || connector?.isGmail == true else { throw missing("连接器类型不匹配") }
        return try await act(refresh: false) { try await client.startConnectorAuthorization(id: connector?.id, version: connector?.version) }
    }
    public func gmailAuthorizationStatus(id: String) async throws -> ConnectorOAuthStatus {
        guard !ended else { throw missing(Self.expiredMessage) }
        return try await act(refresh: false) { try await client.connectorAuthorizationStatus(id: id) }
    }
    public func cancelGmailAuthorization(id: String) async {
        // Best effort after navigation/logout; do not turn a cleanup failure into UI feedback.
        try? await client.cancelConnectorAuthorization(id: id)
    }
    public func disconnectGmail(_ connectorID: String) async throws -> String? {
        let connector = try currentConnector(connectorID)
        guard connector.isGmail else { throw missing("连接器类型不匹配") }
        return try await act { try await client.disconnectConnector(id: connector.id, version: connector.version) }
    }

    // MARK: Devices and node

    /// Registers a device and returns the one-time pairing token.
    public func pairDevice(name: String) async throws -> DevicePairing { try await act { try await client.pairDevice(name: name) } }
    public func revokeDevice(_ deviceID: String) async throws { try await act { try await client.revokeDevice(id: deviceID) } }
    /// Sets the backend-readable directory. Only a loopback client may; others throw Core's 403 text.
    @discardableResult
    public func configureNode(root: String) async throws -> NodeState { try await act { try await client.configureNode(root: root) } }
    /// Confirms an interrupted device call stopped. Loopback clients only.
    public func reconcileNodeCall(_ callID: String) async throws {
        guard let call = state?.node?.unknownCalls.first(where: { $0.callID == callID }) else { throw missing("调用状态已变化") }
        try await act { try await client.reconcileNode(callID: callID, version: call.version) }
    }

    // MARK: Settings

    /// Saves the model connection. `contextWindow` / `maxOutputTokens` are tri-state: ``LimitSetting/preserve`` (default) keeps
    /// the saved override for this provider + endpoint + model, `.automatic` clears it, `.manual(n)` sets it.
    public func saveModel(provider: String, model: String, endpoint: String, apiKey: String = "",
                          contextWindow: LimitSetting = .preserve, maxOutputTokens: LimitSetting = .preserve) async throws {
        try await act { try await client.saveModel(ModelSettings(provider: provider, model: model, endpoint: endpoint, apiKey: apiKey.isEmpty ? nil : apiKey, contextWindow: contextWindow, maxOutputTokens: maxOutputTokens)) }
    }
    /// Saved overrides and the cached catalog answer for a model (read only, no state refresh, no network lookup).
    public func modelLimits(provider: String, endpoint: String, model: String) async throws -> ModelLimitInfo {
        try await act(refresh: false) { try await client.modelLimits(provider: provider, endpoint: endpoint, model: model) }
    }
    /// Online models.dev lookup (联网识别); `force` bypasses the 24 h cache. Read only on the workspace.
    public func refreshModelLimits(provider: String, endpoint: String, model: String, force: Bool = false) async throws -> ModelLimitInfo {
        try await act(refresh: false) { try await client.refreshModelLimits(provider: provider, endpoint: endpoint, model: model, force: force) }
    }
    /// Lists the provider's models for the model picker; saves nothing. Empty `apiKey` reuses the saved key.
    public func listModels(provider: String, endpoint: String, apiKey: String = "") async throws -> ModelCatalog {
        try await act(refresh: false) { try await client.listModels(ModelCatalogQuery(provider: provider, endpoint: endpoint, apiKey: apiKey)) }
    }
    /// Saves the memory plugin. Returns the new plugin state (check `restartRequired`).
    @discardableResult
    public func saveMemoryPlugin(enabled: Bool, endpoint: String = "", token: String = "") async throws -> MemoryPluginState {
        try await act { try await client.saveMemoryPlugin(MemoryPluginSettings(enabled: enabled, endpoint: endpoint.isEmpty ? nil : endpoint, token: token.isEmpty ? nil : token)) }
    }
    /// Tests a configuration without saving it. Returns the provider id.
    public func testMemoryPlugin(endpoint: String, token: String = "") async throws -> String {
        try await act(refresh: false) { try await client.testMemoryPlugin(MemoryPluginSettings(enabled: true, endpoint: endpoint, token: token.isEmpty ? nil : token)) }
    }

    // MARK: Memory

    /// Adds (`existing == nil`) or edits a memory. For an existing one the scope cannot change and its version is echoed.
    @discardableResult
    public func saveMemory(botID: String, existing: Memory? = nil, title: String, content: String, scope: String = "bot") async throws -> MemorySaveResult {
        let draft: MemoryDraft
        if let existing {
            let current = state?.memories.first { $0.id == existing.id } ?? existing
            draft = MemoryDraft(botID: existing.botID ?? botID, title: title, content: content, scope: existing.scope, documentID: existing.id, expectedVersion: current.version)
        } else { draft = MemoryDraft(botID: botID, title: title, content: content, scope: scope) }
        return try await act { try await client.saveMemory(draft) }
    }
    public func deleteMemory(_ memory: Memory) async throws {
        let current = state?.memories.first { $0.id == memory.id } ?? memory
        try await act { try await client.deleteMemory(id: current.id, version: current.version) }
    }
    public func recallMemory(botID: String, query: String) async throws -> MemoryRecall {
        try await act(refresh: false) { try await client.recallMemory(bot: botID, query: query) }
    }
    /// Calls the model; allow up to ~2 minutes.
    public func reflectMemory(botID: String, query: String) async throws -> MemoryReflection {
        try await act(refresh: false) { try await client.reflectMemory(bot: botID, query: query) }
    }
    public func expandMemory(botID: String, ref: String) async throws -> MemoryExpansion {
        try await act(refresh: false) { try await client.expandMemory(bot: botID, ref: ref) }
    }
    public func previewForget(botID: String, query: String) async throws -> ForgetPreview {
        try await act(refresh: false) { try await client.previewForget(bot: botID, query: query) }
    }
    /// Forgets what `preview` listed. Core rejects it when the scope changed since the preview.
    public func forget(botID: String, query: String, preview: ForgetPreview) async throws -> ForgetResult {
        try await act { try await client.forget(bot: botID, query: query, revision: preview.revision) }
    }

    // MARK: Preview

    public func previewFile(path: String) async throws -> PreviewItem { try await act(refresh: false) { try await client.preview(path: path) } }
    /// Tool-call preview; on failure the caller can fall back to ``PreviewItem/fallback(step:)``.
    public func previewTool(callID: String) async throws -> PreviewItem { try await act(refresh: false) { try await client.preview(callID: callID) } }

    // MARK: Export

    /// The share text of the loaded conversation: `[M/D HH:mm] sender: content` entries joined by blank lines.
    /// Senders: 我 / 系统 / peer name or 同伴 Agent / bot name or Agent. Nil when no messages are loaded.
    public func exportTranscript(botID: String, timeZone: TimeZone = .current) -> String? {
        let messages = conversation(for: botID).messages
        guard !messages.isEmpty else { return nil }
        let botName = bot(botID)?.name ?? "Agent"
        return messages.map { m in
            let sender: String
            switch m.role {
            case "user": sender = "我"
            case "system": sender = "系统"
            case "peer": sender = (m.a2aPeerID ?? m.senderBotID).flatMap { bot($0)?.name } ?? "同伴 Agent"
            default: sender = botName
            }
            let time = m.createdAt.map { TimeFormat.formatTime($0, timeZone: timeZone) } ?? ""
            return "[\(time)] \(sender): \(m.content)"
        }.joined(separator: "\n\n")
    }

    /// The full conversation as Markdown, like the web's 下载对话: every message is fetched page by page, so it is
    /// independent of how much is loaded. Entries are `### {sender} · {M/D HH:mm}` + blank line + content, joined by `---`.
    /// Throws "对话已变化，请重新导出" when the Core generation (coreId / privacyEpoch) or the selected agent changes
    /// meanwhile, so content that was forgotten during the export is never written out.
    public func exportMarkdown(botID: String, timeZone: TimeZone = .current) async throws -> (filename: String, content: String) {
        let changed = CoreError(kind: .unsupported, message: "对话已变化，请重新导出")
        guard let initial = sync, selectedBotID == botID else { throw changed }
        let botName = bot(botID)?.name
        func stable(_ s: SyncIdentity) -> Bool { s.coreId == initial.coreId && s.privacyEpoch == initial.privacyEpoch }
        var rows: [AgentMessage] = []
        var after = 0
        do {
            while true {
                let feed = try await client.feed(bot: botID, after: after)
                guard selectedBotID == botID, stable(feed.sync) else { throw changed }
                rows += feed.messages
                guard feed.hasMore, let last = feed.messages.last else { break }
                after = last.seq
            }
            let current = try await client.state(view: .summary)
            guard selectedBotID == botID, stable(current.sync) else { throw changed }
        } catch let e as CoreError where e == changed { throw e }
        catch { throw report(error) }
        let content = rows.map { m in
            let time = m.createdAt.map { TimeFormat.formatTime($0, timeZone: timeZone) } ?? ""
            return "### \(senderLabel(m, botName: botName ?? "Agent")) · \(time)\n\n\(m.content)"
        }.joined(separator: "\n\n---\n\n")
        let safe = (botName ?? "").map { "\\/:*?\"<>|".contains($0) ? "_" : String($0) }.joined()
        return ("\(safe.isEmpty ? "NexBot" : safe)-对话.md", content)
    }

    private func senderLabel(_ m: AgentMessage, botName: String) -> String {
        switch m.role {
        case "user": "我"
        case "system": "系统"
        case "peer": (m.a2aPeerID ?? m.senderBotID).flatMap { bot($0)?.name } ?? "同伴 Agent"
        default: botName
        }
    }
}

// MARK: - Per-assistant model, visible models and unified memory

extension WorkspaceStore {
    /// Sets the model one assistant chats with; `model == ""` follows the default model. Echoes the assistant's
    /// `modelSelectionVersion` plus provider and endpoint of the current connection. Core refuses while the assistant has an
    /// unfinished task (请等待当前任务结束或停止任务后切换模型) and when the version or connection is stale.
    public func setAgentModel(botID: String, model: String) async throws {
        guard let b = bot(botID) else { throw CoreError(kind: .unsupported, message: "Agent 不存在") }
        guard let config = state?.config else { throw CoreError(kind: .unsupported, message: "请先配置模型连接") }
        do { try await client.updateModel(id: botID, model: model, provider: config.providerID, endpoint: config.endpoint, version: b.modelSelectionVersion) }
        catch { await refresh(); throw report(error) }
        await refresh()
    }
    /// Saves which models the pickers offer for the current connection (`nil` = all); owner only. `version` is the
    /// ``ModelVisibility/version`` the edit started from (default: the state's current one); a stale one fails with
    /// "显示模型已被修改，请重新打开设置".
    @discardableResult
    public func saveModelVisibility(models: [String]?, version: Int? = nil) async throws -> ModelVisibility {
        guard let config = state?.config else { throw CoreError(kind: .unsupported, message: "请先配置模型连接") }
        let current = version ?? state?.modelVisibility.version ?? 0
        let value: ModelVisibility
        do { value = try await client.saveModelVisibility(provider: config.providerID, endpoint: config.endpoint, models: models, version: current) }
        catch { await refresh(); throw report(error) }
        await refresh()
        return value
    }
    /// Saves the image generation models for the current connection; owner only. `version` is the
    /// ``WorkspaceState/imageModelSelection`` version the edit started from.
    @discardableResult
    public func saveImageModelSelection(models: [String], version: Int) async throws -> ModelVisibility {
        guard let config = state?.config else { throw CoreError(kind: .unsupported, message: "请先配置模型连接") }
        let value: ModelVisibility
        do { value = try await client.saveImageModelSelection(provider: config.providerID, endpoint: config.endpoint, models: models, version: version) }
        catch { await refresh(); throw report(error) }
        await refresh()
        return value
    }
    /// The account-wide memory switch, memory model and lifetime memory token usage. Read only (no state refresh).
    public func memorySummary() async throws -> MemorySummary {
        do { return try await client.memorySummary() } catch { throw report(error) }
    }
    /// Saves the unified memory switch and, when given, the memory model (`""` follows the account default model).
    /// `version` is the ``MemorySummary/version`` the caller last saw.
    public func saveMemorySettings(enabled: Bool, model: String? = nil, version: Int) async throws -> MemorySummary {
        do { return try await client.saveMemorySettings(enabled: enabled, model: model, version: version) } catch { throw report(error) }
    }
}
