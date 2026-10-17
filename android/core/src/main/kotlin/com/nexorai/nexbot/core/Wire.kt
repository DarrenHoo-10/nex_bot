package com.nexorai.nexbot.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The wire contract of `server/personal-os/`.
 *
 * Everything is tolerant: unknown fields are ignored, missing fields fall back
 * to a default and statuses stay plain strings. Core may add a field or a task
 * state before the phone knows about it, and a phone update must never be
 * required to read a reply. Any value this file does not recognize degrades to
 * the raw string in [Copy].
 */
val CoreJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
}

// ---- identity / sessions -------------------------------------------------

@Serializable
data class IdentityInfo(
    val version: Int = 0,
    val coreId: String = "",
    val loginRequired: Boolean = false,
    val initialized: Boolean = false,
    val loginMethods: List<String> = emptyList(),
)

@Serializable
data class LoginTransaction(
    val transactionId: String = "",
    val bindingToken: String = "",
    val stepId: String = "",
    val challenge: String = "password",
    val expiresAt: Long = 0,
)

@Serializable
data class SessionInfo(
    val token: String = "",
    val sessionId: String = "",
    val coreId: String = "",
    val expiresAt: Long = 0,
    val protocol: String = "native-v1",
    val version: Int = 1,
)

@Serializable
data class ResumedSession(
    val authenticated: Boolean = false,
    val protocol: String = "",
    val sessionId: String = "",
    val coreId: String = "",
    val expiresAt: Long = 0,
)

@Serializable
data class ClientSessionRow(
    @SerialName("session_id") val sessionId: String = "",
    val name: String = "",
    @SerialName("last_seen_at") val lastSeenAt: Long? = null,
    @SerialName("expires_at") val expiresAt: Long = 0,
    @SerialName("revoked_at") val revokedAt: Long? = null,
)

@Serializable
data class ClientSessions(
    val sessions: List<ClientSessionRow> = emptyList(),
    val currentSessionId: String? = null,
)

// ---- sync / state --------------------------------------------------------

@Serializable
data class SyncState(
    val cursor: Long = 0,
    val privacyEpoch: Long = 0,
    val coreId: String = "",
    val bootId: String = "",
)

/** The `data` of an SSE `change` frame. */
@Serializable
data class SyncEvent(
    val cursor: Long = 0,
    val privacyEpoch: Long = 0,
    val coreId: String = "",
    val bootId: String = "",
    val reset: Boolean = false,
)

@Serializable
data class BotRow(
    val id: String = "",
    val name: String = "",
    val instructions: String? = null,
    val version: Long = 0,
    @SerialName("read_seq") val readSeq: Long = 0,
    @SerialName("unread_count") val unreadCount: Long = 0,
    @SerialName("last_message") val lastMessage: String? = null,
    @SerialName("last_message_at") val lastMessageAt: Long? = null,
    @SerialName("policy_json") val policyJson: String? = null,
    @SerialName("policy_version") val policyVersion: Long = 0,
    @SerialName("expertise_json") val expertiseJson: String? = null,
)

@Serializable
data class TaskRow(
    val id: String = "",
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("bot_id") val botId: String = "",
    val objective: String? = null,
    val status: String = "",
    @SerialName("result_summary") val resultSummary: String? = null,
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("ended_at") val endedAt: Long? = null,
    @SerialName("active_tool") val activeTool: String? = null,
)

@Serializable
data class ApprovalRow(
    val id: String = "",
    @SerialName("argument_hash") val argumentHash: String = "",
    @SerialName("expires_at") val expiresAt: Long = 0,
    @SerialName("tool_name") val toolName: String = "",
    @SerialName("arguments_json") val argumentsJson: String = "{}",
    @SerialName("authorization_snapshot_json") val authorizationSnapshotJson: String = "{}",
    @SerialName("bot_id") val botId: String = "",
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("task_id") val taskId: String = "",
    @SerialName("call_id") val callId: String = "",
)

@Serializable
data class RoutineRow(
    val id: String = "",
    @SerialName("bot_id") val botId: String = "",
    val name: String = "",
    val prompt: String = "",
    @SerialName("schedule_kind") val scheduleKind: String = "",
    @SerialName("interval_ms") val intervalMs: Long? = null,
    @SerialName("local_time") val localTime: String? = null,
    @SerialName("time_zone") val timeZone: String? = null,
    /** SQLite stores this flag as 0/1, not as a JSON boolean. */
    val enabled: Long = 0,
    @SerialName("next_due_at") val nextDueAt: Long? = null,
    val version: Long = 0,
    @SerialName("created_at") val createdAt: Long = 0,
) {
    val isEnabled: Boolean get() = enabled != 0L
}

@Serializable
data class OccurrenceRow(
    val id: String = "",
    @SerialName("routine_id") val routineId: String = "",
    @SerialName("bot_id") val botId: String = "",
    val name: String = "",
    val status: String = "",
    @SerialName("scheduled_at") val scheduledAt: Long = 0,
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("created_at") val createdAt: Long = 0,
)

@Serializable
data class MemoryRow(
    val id: String = "",
    val scope: String = "",
    @SerialName("bot_id") val botId: String? = null,
    val title: String = "",
    val version: Long = 0,
    @SerialName("updated_at") val updatedAt: Long? = null,
    /** Present in the full state, absent in `?view=summary`. */
    val content: String? = null,
)

@Serializable
data class DeviceRow(
    val id: String = "",
    val name: String = "",
    val status: String = "",
    @SerialName("capabilities_json") val capabilitiesJson: String? = null,
)

@Serializable
data class DelegationRow(
    val id: String = "",
    @SerialName("parent_task_id") val parentTaskId: String? = null,
    @SerialName("child_task_id") val childTaskId: String? = null,
    @SerialName("sender_bot_id") val senderBotId: String? = null,
    @SerialName("receiver_bot_id") val receiverBotId: String? = null,
    val status: String = "",
)

@Serializable
data class JournalRow(
    @SerialName("task_id") val taskId: String = "",
    @SerialName("bot_id") val botId: String = "",
    val objective: String = "",
    val result: String = "",
    @SerialName("created_at") val createdAt: Long = 0,
)

/** `GET /api/state`; `view` is `"summary"` only when that view answered. */
@Serializable
data class CoreState(
    val view: String? = null,
    val sync: SyncState = SyncState(),
    val bots: List<BotRow> = emptyList(),
    val tasks: List<TaskRow> = emptyList(),
    val approvals: List<ApprovalRow> = emptyList(),
    val routines: List<RoutineRow> = emptyList(),
    val occurrences: List<OccurrenceRow> = emptyList(),
    val memories: List<MemoryRow> = emptyList(),
    val devices: List<DeviceRow> = emptyList(),
    @SerialName("onlineDevices") val onlineDevices: List<String> = emptyList(),
    val delegations: List<DelegationRow> = emptyList(),
    val journal: List<JournalRow> = emptyList(),
)

// ---- messages ------------------------------------------------------------

@Serializable
data class ToolStep(
    val id: String = "",
    @SerialName("tool_name") val toolName: String = "",
    val status: String = "",
    val summary: String = "",
    val preview: String = "",
    @SerialName("created_at") val createdAt: Long = 0,
)

@Serializable
data class MessageRow(
    val id: String = "",
    @SerialName("bot_id") val botId: String = "",
    val seq: Long = 0,
    val role: String = "",
    val kind: String = "",
    val content: String = "",
    @SerialName("sender_bot_id") val senderBotId: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("a2a_direction") val a2aDirection: String? = null,
    @SerialName("a2a_peer_id") val a2aPeerId: String? = null,
    @SerialName("tool_steps") val toolSteps: List<ToolStep> = emptyList(),
)

@Serializable
data class StreamingText(
    val taskId: String = "",
    val text: String = "",
)

/** `GET /api/agents/messages`. */
@Serializable
data class MessageFeed(
    val sync: SyncState = SyncState(),
    val messages: List<MessageRow> = emptyList(),
    val hasMore: Boolean = false,
    val streaming: List<StreamingText> = emptyList(),
)

// ---- replies -------------------------------------------------------------

@Serializable
data class SendReceipt(val taskId: String = "")

@Serializable
data class OkReply(val ok: Boolean = false)
