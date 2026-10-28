package com.nexorai.nexbot.sync

import com.nexorai.nexbot.core.ApprovalRow
import com.nexorai.nexbot.core.BotRow
import com.nexorai.nexbot.core.Copy
import com.nexorai.nexbot.core.CoreClient
import com.nexorai.nexbot.core.CoreException
import com.nexorai.nexbot.core.CoreOrigin
import com.nexorai.nexbot.core.CoreState
import com.nexorai.nexbot.core.LiveFrame
import com.nexorai.nexbot.core.MessageFeed
import com.nexorai.nexbot.core.MessageRow
import com.nexorai.nexbot.core.StreamingText
import com.nexorai.nexbot.core.SyncPolicy
import com.nexorai.nexbot.core.SyncState
import com.nexorai.nexbot.core.TaskRow
import com.nexorai.nexbot.core.UploadedAttachment
import com.nexorai.nexbot.data.ConnectionStore
import com.nexorai.nexbot.data.StoredConnection
import com.nexorai.nexbot.notifications.Notifier
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The phone's session and screen state.
 *
 * Two registries of truth: Core owns bots, messages, tasks and approvals; this
 * class owns exactly one live stream and the coalescing rules that keep a
 * cellular radio from being asked for the whole state on every token. All
 * timing constants come from [SyncPolicy], which is tested on the JVM without
 * an Android runtime.
 *
 * Every public method is fire-and-forget from the UI. State transitions happen
 * inside one [MutableStateFlow]; the composition only reads.
 */
class Repository(
    private val store: ConnectionStore,
    private val notifier: Notifier = Notifier.None,
    private val clientFactory: (String) -> CoreClient = { CoreClient(it) },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    private val deviceName: () -> String = { "Android" },
    private val clock: () -> Long = System::currentTimeMillis,
    private val tailDelayMs: Long = SyncPolicy.TAIL_COALESCE_MS,
    private val snapshotMinIntervalMs: Long = SyncPolicy.SNAPSHOT_MIN_INTERVAL_MS,
    private val tickMs: Long = SyncPolicy.SNAPSHOT_TICK_MS,
    private val backgroundGraceMs: Long = 60_000,
) {
    enum class Phase { Starting, Login, Ready }

    data class UiState(
        val phase: Phase = Phase.Starting,
        val connection: StoredConnection? = null,
        val bots: List<BotRow> = emptyList(),
        val tasks: List<TaskRow> = emptyList(),
        val approvals: List<ApprovalRow> = emptyList(),
        val messages: List<MessageRow> = emptyList(),
        val streaming: List<StreamingText> = emptyList(),
        val selectedBotId: String? = null,
        val hasMore: Boolean = false,
        val connected: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        val notice: String? = null,
    ) {
        val selectedBot: BotRow? get() = bots.firstOrNull { it.id == selectedBotId }

        val activeTasks: List<TaskRow>
            get() = tasks.filter { it.botId == selectedBotId && !Copy.isTerminal(it.status) }

        val pendingApprovals: List<ApprovalRow>
            get() = approvals.filter { it.botId == selectedBotId }

        val streamingText: String? get() = streaming.firstOrNull()?.text?.takeIf { it.isNotBlank() }
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var client: CoreClient? = null
    private var streamJob: Job? = null
    private var pollJob: Job? = null
    private var reloadJob: Job? = null
    private var backgroundJob: Job? = null
    private var started = false
    private var foreground = true
    private var cursor: String? = null
    private var loadedSync: SyncState? = null
    private var selectedSeq = 0L
    private var lastSnapshotAt = 0L
    private var snapshotWanted = false
    private var pendingBotId: String? = null
    private var pendingSend: Pair<Pair<String, String>, String>? = null

    fun start() {
        if (started) return
        started = true
        scope.launch { bootstrap() }
    }

    // ---- session ---------------------------------------------------------

    private suspend fun bootstrap() {
        val saved = withContext(Dispatchers.IO) { store.load() }
        if (saved == null || saved.origin.isEmpty() || saved.token.isEmpty()) {
            _state.update { it.copy(phase = Phase.Login) }
            return
        }
        _state.update { it.copy(connection = saved, phase = Phase.Starting) }
        if (clock() >= saved.expiresAt) {
            expire(saved, "登录已过期，请重新登录")
            return
        }
        val core = clientFactory(saved.origin).also { it.useToken(saved.token) }
        val resumed = try {
            core.resume(saved.token)
        } catch (_: Exception) {
            null
        }
        if (resumed == null || !resumed.authenticated || resumed.coreId != saved.publicCoreId) {
            expire(saved, null)
            return
        }
        client = core
        val renewed = saved.copy(sessionId = resumed.sessionId, expiresAt = resumed.expiresAt)
        withContext(Dispatchers.IO) { store.save(renewed) }
        _state.update { it.copy(connection = renewed, phase = Phase.Ready) }
        enterReady()
    }

    fun login(originInput: String, account: String, password: String) {
        if (password.isEmpty()) {
            _state.update { it.copy(error = "请输入密码") }
            return
        }
        scope.launch {
            _state.update { it.copy(busy = true, error = null) }
            val parsed = CoreOrigin.parse(originInput)
            if (parsed is CoreOrigin.Result.Invalid) {
                _state.update { it.copy(busy = false, error = parsed.reason) }
                return@launch
            }
            val origin = (parsed as CoreOrigin.Result.Valid).origin
            val core = clientFactory(origin)
            try {
                val identity = core.identity()
                check(identity.version == 1 && identity.coreId.isNotEmpty()) { "这台 Core 不支持客户端协议 v1" }
                check(identity.loginRequired) { "这台 Core 没有启用账号登录" }
                check(identity.initialized) { "后端尚未关联账号，请先在服务器运行 init" }
                check("password" in identity.loginMethods) { "后端不支持密码登录" }
                val transaction = core.startLogin(account.trim(), deviceName())
                val session = core.respondLogin(transaction, password)
                check(session.coreId == identity.coreId) { "Core 身份在登录期间发生变化" }
                core.useToken(session.token)
                val saved = StoredConnection(
                    origin = origin,
                    publicCoreId = identity.coreId,
                    name = deviceName(),
                    account = account.trim(),
                    token = session.token,
                    sessionId = session.sessionId,
                    expiresAt = session.expiresAt,
                )
                withContext(Dispatchers.IO) { store.save(saved) }
                client = core
                _state.update { it.copy(phase = Phase.Ready, connection = saved, busy = false, error = null, notice = null) }
                enterReady()
            } catch (failure: CoreException) {
                _state.update { it.copy(busy = false, error = failure.message) }
            } catch (failure: Exception) {
                _state.update { it.copy(busy = false, error = failure.message ?: "无法连接 Core，请检查地址与网络") }
            }
        }
    }

    fun logout() {
        scope.launch {
            runCatching { client?.logout() }
            stopLive()
            withContext(Dispatchers.IO) { store.clear() }
            client = null
            loadedSync = null
            cursor = null
            selectedSeq = 0
            _state.value = UiState(phase = Phase.Login)
        }
    }

    private suspend fun enterReady() {
        _state.update { it.copy(connected = false, error = null) }
        reload(forceSnapshot = true)
        startStream()
        startPolling()
        pendingBotId?.let { botId ->
            pendingBotId = null
            selectBot(botId)
        }
    }

    /**
     * Losing the session must not lose the app: state changes first, then the
     * live jobs stop. `stopLive()` cancels the stream this function may be
     * running in, so anything that must happen (clear the token, show login)
     * happens before that cancellation can reach a suspension point.
     */
    private fun expire(connection: StoredConnection?, message: String?) {
        client = null
        loadedSync = null
        cursor = null
        selectedSeq = 0
        store.clear()
        _state.value = UiState(phase = Phase.Login, connection = connection, notice = message)
        stopLive()
    }

    // ---- screen actions --------------------------------------------------

    fun workspaceTransport(): com.nexorai.nexbot.core.WorkspaceTransport {
        val saved = requireNotNull(_state.value.connection)
        return com.nexorai.nexbot.core.WorkspaceTransport(saved.origin, {
            val current = _state.value
            if (current.phase == Phase.Ready && current.connection?.origin == saved.origin &&
                current.connection.account == saved.account) client?.token else null
        })
    }

    fun workspaceEvents(cursor: String?) = requireNotNull(client).events(cursor)

    fun forgetWorkspace() { expire(_state.value.connection, null) }

    fun selectBot(botId: String) {
        scope.launch {
            selectedSeq = 0
            _state.update {
                it.copy(selectedBotId = botId, messages = emptyList(), streaming = emptyList(), hasMore = false, error = null)
            }
            val core = client ?: return@launch
            try {
                applyFeed(core.messages(botId), replace = true)
            } catch (failure: Exception) {
                markLost(failure.message)
            }
            requestReload(forceSnapshot = true)
        }
    }

    /** A notification tap that arrives before the session is ready. */
    fun openBotWhenReady(botId: String) {
        val ready = _state.value
        if (ready.phase == Phase.Ready && ready.bots.any { it.id == botId }) selectBot(botId) else pendingBotId = botId
    }

    fun clearSelection() {
        _state.update { it.copy(selectedBotId = null, messages = emptyList(), streaming = emptyList(), hasMore = false) }
    }

    fun send(text: String, attachmentIds: List<String> = emptyList()) {
        val body = text.trim()
        if (body.isEmpty() && attachmentIds.isEmpty()) return
        val botId = _state.value.selectedBotId ?: return
        val core = client ?: return
        val key = botId to (body + attachmentIds.joinToString("\u0000"))
        val clientId = pendingSend?.takeIf { it.first == key }?.second
            ?: UUID.randomUUID().toString().also { pendingSend = key to it }
        scope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                core.send(botId, body, clientId, attachmentIds)
                pendingSend = null
                _state.update { it.copy(busy = false) }
                requestReload(forceSnapshot = true)
            } catch (failure: CoreException) {
                _state.update { it.copy(busy = false, error = failure.message) }
            } catch (failure: Exception) {
                _state.update { it.copy(busy = false, error = failure.message ?: "发送失败，请重试") }
            }
        }
    }

    /** Uploads one attachment; the caller enforces the five-file, five-megabyte limits. */
    suspend fun uploadAttachment(botId: String, name: String, bytes: ByteArray): UploadedAttachment {
        val core = client ?: throw CoreException(0, "连接已断开")
        return core.uploadAttachment(botId, name, Base64.getEncoder().encodeToString(bytes))
    }

    /** Changes the per-Agent approval mode and refreshes the snapshot for its version. */
    fun setApprovalMode(mode: String) {
        val bot = _state.value.selectedBot ?: return
        val core = client ?: return
        scope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                core.setApprovalMode(bot.id, mode, bot.approvalSettingVersion)
                _state.update { it.copy(busy = false) }
                requestReload(forceSnapshot = true)
            } catch (failure: CoreException) {
                _state.update { it.copy(busy = false, error = failure.message) }
            } catch (failure: Exception) {
                _state.update { it.copy(busy = false, error = failure.message ?: "权限保存失败") }
            }
        }
    }

    suspend fun downloadAttachment(path: String): ByteArray {
        val core = client ?: throw CoreException(0, "连接已断开")
        return core.download(path)
    }

    /** Marks the selected Agent's conversation so its next message opens a new topic. */
    suspend fun startNewTopic(): Boolean {
        val core = client ?: throw CoreException(0, "连接已断开")
        val botId = _state.value.selectedBotId ?: throw CoreException(0, "没有选中的 Agent")
        val marked = core.newTopic(botId)
        requestReload(forceSnapshot = true)
        return marked
    }

    /** The whole transcript as Markdown, fetched page by page from the start. */
    suspend fun exportTranscript(): String {
        val core = client ?: throw CoreException(0, "连接已断开")
        val botId = _state.value.selectedBotId ?: throw CoreException(0, "没有选中的 Agent")
        val botName = _state.value.selectedBot?.name ?: "Agent"
        val initial = loadedSync ?: throw CoreException(0, "状态尚未加载")
        val rows = mutableListOf<MessageRow>()
        var after = 0L
        while (true) {
            val feed = core.messages(botId, after = after)
            if (feed.sync.coreId != initial.coreId || feed.sync.privacyEpoch != initial.privacyEpoch) {
                throw CoreException(0, "对话已变化，请重新导出")
            }
            rows += feed.messages
            if (!feed.hasMore || feed.messages.isEmpty()) break
            after = feed.messages.last().seq
        }
        val formatter = DateTimeFormatter.ofPattern("M月d日 HH:mm")
        return rows.joinToString("\n\n---\n\n") { message ->
            "### ${Copy.senderLabel(message, botName, null)} · " +
                formatter.format(Instant.ofEpochMilli(message.createdAt).atZone(ZoneId.systemDefault())) +
                "\n\n" + message.content
        }
    }

    fun stopTasks() {
        val botId = _state.value.selectedBotId ?: return
        val running = _state.value.tasks.filter {
            it.botId == botId && !Copy.isTerminal(it.status) && it.status != "needs_reconciliation"
        }
        if (running.isEmpty()) return
        scope.launch {
            for (task in running) runCatching { client?.cancel(task.id) }
            requestReload(forceSnapshot = true)
        }
    }

    fun decide(approval: ApprovalRow, allow: Boolean) {
        scope.launch {
            try {
                client?.decide(approval.id, approval.argumentHash, allow)
            } catch (failure: Exception) {
                _state.update { it.copy(error = failure.message ?: "审批失败") }
            }
            requestReload(forceSnapshot = true)
        }
    }

    fun loadOlder() {
        val botId = _state.value.selectedBotId ?: return
        val firstSeq = _state.value.messages.firstOrNull()?.seq?.takeIf { it > 1 } ?: return
        scope.launch {
            try {
                val feed = client?.messages(botId, before = firstSeq) ?: return@launch
                val current = _state.value
                val merged = (feed.messages + current.messages).distinctBy { it.id }.sortedBy { it.seq }
                _state.update {
                    it.copy(
                        messages = merged,
                        hasMore = feed.messages.isNotEmpty() && (feed.messages.firstOrNull()?.seq ?: 1L) > 1L,
                    )
                }
            } catch (failure: Exception) {
                _state.update { it.copy(error = failure.message ?: "加载失败") }
            }
        }
    }

    fun retry() {
        scope.launch { reload(forceSnapshot = true) }
    }

    fun setForeground(value: Boolean) {
        foreground = value
        if (value) {
            if (_state.value.phase == Phase.Ready) {
                requestReload(forceSnapshot = true)
                if (streamJob?.isActive != true) startStream()
            }
            return
        }
        backgroundJob?.cancel()
        backgroundJob = scope.launch {
            delay(backgroundGraceMs)
            if (!foreground) {
                streamJob?.cancel()
                streamJob = null
            }
        }
    }

    fun close() {
        stopLive()
    }

    // ---- data flow -------------------------------------------------------

    private fun requestReload(forceSnapshot: Boolean = false) {
        if (forceSnapshot) snapshotWanted = true
        if (reloadJob?.isActive == true) return
        reloadJob = scope.launch {
            delay(tailDelayMs)
            reload()
        }
    }

    private suspend fun reload(forceSnapshot: Boolean = false) {
        val core = client ?: return
        val snapshotDue = forceSnapshot || snapshotWanted || lastSnapshotAt == 0L ||
            clock() - lastSnapshotAt >= snapshotMinIntervalMs
        if (snapshotDue) {
            try {
                applyState(core.state(summary = true))
                lastSnapshotAt = clock()
                snapshotWanted = false
            } catch (failure: CoreException) {
                if (failure.status == 401) {
                    expire(_state.value.connection, "登录已过期，请重新登录")
                    return
                }
                markLost(failure.message)
            } catch (failure: Exception) {
                markLost(failure.message)
            }
        }
        val botId = _state.value.selectedBotId ?: return
        try {
            val feed = if (selectedSeq > 0) core.messages(botId, after = selectedSeq) else core.messages(botId)
            applyFeed(feed, replace = selectedSeq == 0L)
        } catch (failure: CoreException) {
            if (failure.status == 401) {
                expire(_state.value.connection, "登录已过期，请重新登录")
                return
            }
            markLost(failure.message)
        } catch (failure: Exception) {
            markLost(failure.message)
        }
    }

    private fun applyState(next: CoreState) {
        val previous = _state.value
        val previousSync = loadedSync
        val invalid = previousSync != null && (
            previousSync.coreId != next.sync.coreId ||
                previousSync.bootId != next.sync.bootId ||
                previousSync.privacyEpoch != next.sync.privacyEpoch
            )
        loadedSync = next.sync
        val connection = previous.connection?.let { saved ->
            if (saved.workspaceCoreId == next.sync.coreId) saved else saved.copy(workspaceCoreId = next.sync.coreId).also {
                scope.launch(Dispatchers.IO) { store.save(it) }
            }
        }
        _state.update {
            it.copy(
                connection = connection,
                bots = next.bots,
                tasks = next.tasks,
                approvals = next.approvals,
                connected = true,
                error = null,
                messages = if (invalid) emptyList() else it.messages,
                streaming = if (invalid) emptyList() else it.streaming,
                hasMore = if (invalid) false else it.hasMore,
            )
        }
        if (invalid) {
            selectedSeq = 0
            requestReload(forceSnapshot = true)
        }
        announce(previous, _state.value)
    }

    private fun applyFeed(feed: MessageFeed, replace: Boolean) {
        val current = _state.value
        val merged = if (replace) {
            feed.messages.sortedBy { it.seq }
        } else {
            val seen = current.messages.map { it.id }.toSet()
            (current.messages + feed.messages.filter { it.id !in seen }).sortedBy { it.seq }
        }
        val lastSeq = merged.lastOrNull()?.seq ?: 0L
        selectedSeq = maxOf(selectedSeq, lastSeq)
        val hasMore = if (replace) (feed.messages.firstOrNull()?.seq ?: 1L) > 1L else current.hasMore
        _state.update {
            it.copy(
                messages = merged,
                streaming = feed.streaming.filter { stream -> stream.text.isNotEmpty() },
                hasMore = hasMore,
                connected = true,
                error = null,
            )
        }
        val botId = _state.value.selectedBotId
        if (botId != null && lastSeq > 0) {
            scope.launch { runCatching { client?.markRead(botId, lastSeq) } }
        }
    }

    private fun announce(previous: UiState, next: UiState) {
        if (!foreground || previous.bots.isEmpty()) return
        val selected = next.selectedBotId
        val knownApprovals = previous.approvals.map { it.id }.toSet()
        next.approvals.firstOrNull { it.id !in knownApprovals && it.botId != selected }?.let { approval ->
            notifier.approval(approval.botId, next.bots.firstOrNull { it.id == approval.botId }?.name ?: "Agent")
        }
        for (bot in next.bots) {
            if (bot.id == selected) continue
            val before = previous.bots.firstOrNull { it.id == bot.id }?.unreadCount ?: 0
            if (bot.unreadCount > before) notifier.reply(bot.id, bot.name)
        }
    }

    private fun markLost(message: String?) {
        _state.update { it.copy(connected = false, error = message ?: "Core 连接中断，正在重新同步…") }
    }

    // ---- live stream -----------------------------------------------------

    private class StreamStopped : Exception()

    private fun startStream() {
        val core = client ?: return
        streamJob?.cancel()
        streamJob = scope.launch {
            var attempt = 0
            android.util.Log.d("NexBotRepo", "stream starting cursor=$cursor")
            while (isActive && foreground) {
                try {
                    core.events(cursor).collect { frame ->
                        when (frame) {
                            is LiveFrame.Change -> {
                                attempt = 0
                                cursor = frame.cursor.toString()
                                if (SyncPolicy.needsSnapshot(frame, loadedSync)) {
                                    loadedSync = null
                                    selectedSeq = 0
                                    _state.update {
                                        it.copy(messages = emptyList(), streaming = emptyList(), hasMore = false)
                                    }
                                }
                                snapshotWanted = true
                                requestReload()
                            }

                            LiveFrame.Revoked -> throw StreamStopped()
                            is LiveFrame.Unknown -> Unit
                        }
                    }
                    if (!foreground) break
                    android.util.Log.d("NexBotRepo", "stream ended, reconnecting")
                    delay(SyncPolicy.backoffMs(attempt++))
                } catch (stopped: StreamStopped) {
                    android.util.Log.d("NexBotRepo", "stream revoked")
                    expire(_state.value.connection, "登录已过期，请重新登录")
                    break
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: CoreException) {
                    android.util.Log.w("NexBotRepo", "stream refused ${failure.status}", failure)
                    if (failure.status == 401) {
                        expire(_state.value.connection, "登录已过期，请重新登录")
                        break
                    }
                    markLost(failure.message)
                    delay(SyncPolicy.backoffMs(attempt++))
                } catch (failure: Exception) {
                    android.util.Log.w("NexBotRepo", "stream failed", failure)
                    if (!foreground) break
                    markLost(null)
                    delay(SyncPolicy.backoffMs(attempt++))
                }
            }
        }
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                delay(tickMs)
                val current = _state.value
                if (!foreground || current.phase != Phase.Ready) continue
                refreshSessionIfNeeded()
                requestReload(forceSnapshot = true)
            }
        }
    }

    private fun refreshSessionIfNeeded() {
        val connection = _state.value.connection ?: return
        if (!SyncPolicy.shouldRefresh(clock(), connection.expiresAt)) return
        scope.launch {
            try {
                val session = client?.refresh() ?: return@launch
                val updated = connection.copy(
                    token = session.token,
                    sessionId = session.sessionId,
                    expiresAt = session.expiresAt,
                )
                withContext(Dispatchers.IO) { store.save(updated) }
                _state.update { it.copy(connection = updated) }
            } catch (failure: CoreException) {
                if (failure.status == 401) expire(connection, "登录已过期，请重新登录")
            } catch (_: Exception) {
                // Keep the existing session; the stream will report a real loss.
            }
        }
    }

    private fun stopLive() {
        streamJob?.cancel()
        pollJob?.cancel()
        reloadJob?.cancel()
        backgroundJob?.cancel()
        streamJob = null
        pollJob = null
        reloadJob = null
        backgroundJob = null
    }
}
