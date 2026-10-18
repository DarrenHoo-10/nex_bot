package com.nexorai.nexbot.ui

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexorai.nexbot.core.ApprovalRow
import com.nexorai.nexbot.core.BotRow
import com.nexorai.nexbot.core.Copy
import com.nexorai.nexbot.core.MessageRow
import com.nexorai.nexbot.core.SyncPolicy
import com.nexorai.nexbot.core.ToolStep
import com.nexorai.nexbot.core.UploadedAttachment
import com.nexorai.nexbot.sync.Repository
import java.io.File
import kotlinx.coroutines.launch

private data class Quote(val author: String, val text: String)

/**
 * The chat from `doc/ui/workspace-mobile.png`: transparent assistant text,
 * right-aligned user bubbles, per-message time/quote/copy, a collapsible work
 * log, the amber approval card and the pill composer with a circular send.
 */
@Composable
fun ChatScreen(state: Repository.UiState, repository: Repository) {
    val extra = LocalNexExtra.current
    val bot = state.selectedBot
    val listState = rememberLazyListState()
    val clipboard = LocalClipboardManager.current
    val botName = bot?.name ?: "Agent"
    val processing = SyncPolicy.showsProcessing(
        connected = state.connected,
        sending = state.busy,
        streamingText = state.streamingText,
        tasks = state.activeTasks,
        approvals = state.pendingApprovals,
    )
    var draft by rememberSaveable(bot?.id) { mutableStateOf("") }
    var quote by remember(bot?.id) { mutableStateOf<Quote?>(null) }
    var attachments by remember(bot?.id) { mutableStateOf<List<UploadedAttachment>>(emptyList()) }
    var uploading by remember { mutableStateOf(false) }
    var addMenu by remember { mutableStateOf(false) }
    var permissionMenu by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val approvalMode = bot?.approvalSetting ?: "standard"
    val toast: (String) -> Unit = { message -> Toast.makeText(context, message, Toast.LENGTH_SHORT).show() }

    fun submit() {
        if ((draft.isBlank() && attachments.isEmpty()) || state.busy || uploading) return
        repository.send(composeBody(quote, draft), attachments.map { it.id })
        draft = ""
        quote = null
        attachments = emptyList()
    }

    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val botId = bot?.id
        if (uris.isEmpty() || botId == null) return@rememberLauncherForActivityResult
        val room = 5 - attachments.size
        if (room <= 0) {
            toast("最多添加 5 个附件")
            return@rememberLauncherForActivityResult
        }
        if (uris.size > room) toast("最多添加 5 个附件")
        scope.launch {
            uploading = true
            try {
                for (uri in uris.take(room)) {
                    val name = displayName(context, uri) ?: "附件"
                    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: continue
                    if (bytes.isEmpty() || bytes.size > 5 * 1024 * 1024) {
                        toast("请选择 5 MB 以内的非空文件")
                        continue
                    }
                    attachments = attachments + repository.uploadAttachment(botId, name, bytes)
                }
            } catch (failure: Exception) {
                toast(failure.message ?: "上传失败")
            } finally {
                uploading = false
            }
        }
    }

    fun changeMode(mode: String) {
        permissionMenu = false
        if (mode != approvalMode) repository.setApprovalMode(mode)
    }

    fun exportTranscript() {
        scope.launch {
            try {
                val markdown = repository.exportTranscript()
                val share = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, "$botName-对话.md")
                    putExtra(Intent.EXTRA_TEXT, markdown)
                }
                context.startActivity(Intent.createChooser(share, "导出对话"))
            } catch (failure: Exception) {
                toast(failure.message ?: "导出失败")
            }
        }
    }

    fun downloadAttachment(path: String, name: String) {
        scope.launch {
            try {
                val bytes = repository.downloadAttachment(path)
                toast(if (saveDownload(context, name, bytes)) "已保存到下载" else "保存失败")
            } catch (failure: Exception) {
                toast(failure.message ?: "下载失败")
            }
        }
    }

    val rows = remember(state.messages) { chatItems(state.messages) }
    LaunchedEffect(rows.size, state.streamingText, processing) {
        // Wait for the new rows to be measured, then pin the bottom: the
        // previous item count is stale inside the same composition.
        withFrameNanos { }
        val total = listState.layoutInfo.totalItemsCount
        if (total > 0) listState.animateScrollToItem(total - 1)
    }

    val companion = bot?.let { companionState(state, it) } ?: CompanionState.Idle
    val status = companionLabel(companion) to when (companion) {
        CompanionState.Approval -> extra.statusApproval
        CompanionState.Failed -> extra.statusFailed
        CompanionState.Offline -> extra.statusOffline
        CompanionState.Thinking, CompanionState.Working -> extra.statusWorking
        else -> null
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .safeDrawingPadding()
            .imePadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(65.dp)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .clickable(onClick = repository::clearSelection)
                    .semantics { contentDescription = "返回" },
                contentAlignment = Alignment.Center,
            ) {
                BackChevron(20.dp, MaterialTheme.colorScheme.onBackground)
            }
            CompanionAvatar(
                bot,
                state.bots,
                40.dp,
                companion,
            )
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    botName,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onBackground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    status.second?.let { color ->
                        Dot(color, 6.dp)
                        Spacer(Modifier.width(5.dp))
                    }
                    Text(status.first, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }

        if (state.error != null || !state.connected) {
            NoticeBanner(
                text = state.error ?: "Core 连接中断，正在重新同步…",
                action = "重试",
                onAction = repository::retry,
            )
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.Bottom,
        ) {
            if (state.hasMore) {
                item(key = "older") {
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        TextAction("加载更早的消息", onClick = repository::loadOlder)
                    }
                }
            }
            if (rows.isEmpty() && state.streamingText == null && !processing) {
                item(key = "empty") {
                    Text(
                        "还没有消息",
                        modifier = Modifier.fillMaxWidth().padding(top = 48.dp),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            itemsIndexed(rows, key = { index, item ->
                when (item) {
                    is ChatItem.Day -> "day-$index"
                    is ChatItem.Msg -> item.message.id
                }
            }) { _, item ->
                when (item) {
                    is ChatItem.Day -> DayDivider(item.label)
                    is ChatItem.Msg -> MessageBlock(
                        message = item.message,
                        bot = bot,
                        bots = state.bots,
                        onQuote = { author, text -> quote = Quote(author, text) },
                        onCopy = { text -> clipboard.setText(AnnotatedString(text)) },
                        onAttachment = { path, name -> downloadAttachment(path, name) },
                    )
                }
            }
            state.streamingText?.let { text ->
                item(key = "streaming") {
                    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        MarkdownText(text)
                        Text(
                            "正在回复…",
                            modifier = Modifier.padding(top = 4.dp),
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (processing) {
                item(key = "processing") { TypingDots() }
            }
            state.pendingApprovals.forEach { approval ->
                item(key = "approval-${approval.id}") {
                    ApprovalCard(
                        approval = approval,
                        botName = botName,
                        onAllow = { repository.decide(approval, true) },
                        onDeny = { repository.decide(approval, false) },
                    )
                }
            }
            if (state.activeTasks.isNotEmpty() || state.pendingApprovals.isNotEmpty() || processing) {
                item(key = "task-status") {
                    TaskStatusRow(state, botName, repository)
                }
            }
        }

        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            if (attachments.isNotEmpty() || uploading) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 6.dp)
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    attachments.forEach { file ->
                        Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                            Row(
                                modifier = Modifier.padding(start = 9.dp, end = 4.dp, top = 5.dp, bottom = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    file.name,
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.widthIn(max = 150.dp),
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    "×",
                                    fontSize = 15.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier
                                        .clickable(enabled = !state.busy && !uploading) {
                                            attachments = attachments.filter { it.id != file.id }
                                        }
                                        .padding(horizontal = 4.dp),
                                )
                            }
                        }
                    }
                    if (uploading) {
                        Text("正在上传…", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            quote?.let { quoted ->
                QuoteBar(quoted, onDismiss = { quote = null })
                Spacer(Modifier.height(8.dp))
            }
            Surface(
                shape = RoundedCornerShape(22.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            ) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
                    BasicTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = TextStyle(fontSize = 14.sp, lineHeight = 22.sp, color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        maxLines = 6,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { submit() }),
                        decorationBox = { inner ->
                            Box {
                                if (draft.isEmpty()) {
                                    Text(
                                        "给 $botName 发消息…",
                                        fontSize = 14.sp,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                inner()
                            }
                        },
                    )
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box {
                            Box(
                                modifier = Modifier
                                    .size(34.dp)
                                    .clip(CircleShape)
                                    .clickable(enabled = !uploading) { addMenu = true }
                                    .semantics { contentDescription = "添加" },
                                contentAlignment = Alignment.Center,
                            ) {
                                PlusGlyph(20.dp, MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            DropdownMenu(expanded = addMenu, onDismissRequest = { addMenu = false }) {
                                Text(
                                    "添加",
                                    fontSize = 10.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                )
                                DropdownMenuItem(
                                    text = { CommandRow("文件", "file") },
                                    enabled = !uploading && bot != null,
                                    onClick = {
                                        addMenu = false
                                        pickFiles.launch(arrayOf("*/*"))
                                    },
                                )
                                Text(
                                    "指令",
                                    fontSize = 10.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                )
                                DropdownMenuItem(
                                    text = { CommandRow("权限", if (approvalMode == "full") "完全权限" else "标准权限") },
                                    enabled = !state.busy,
                                    onClick = {
                                        addMenu = false
                                        permissionMenu = true
                                    },
                                )
                                DropdownMenuItem(
                                    text = { CommandRow("导出对话", "Markdown") },
                                    enabled = state.messages.isNotEmpty(),
                                    onClick = {
                                        addMenu = false
                                        exportTranscript()
                                    },
                                )
                            }
                        }
                        Spacer(Modifier.width(4.dp))
                        Box {
                            Row(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable(enabled = !state.busy) { permissionMenu = true }
                                    .padding(horizontal = 6.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                ShieldGlyph(
                                    15.dp,
                                    MaterialTheme.colorScheme.onSurfaceVariant,
                                    filled = approvalMode == "full",
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    if (approvalMode == "full") "完全权限" else "标准权限",
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(Modifier.width(2.dp))
                                ChevronUpGlyph(11.dp, MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            DropdownMenu(expanded = permissionMenu, onDismissRequest = { permissionMenu = false }) {
                                PermissionItem("标准权限", approvalMode == "standard") { changeMode("standard") }
                                PermissionItem("完全权限", approvalMode == "full") { changeMode("full") }
                            }
                        }
                        Spacer(Modifier.weight(1f))
                        val canSend = (draft.isNotBlank() || attachments.isNotEmpty()) && !state.busy && !uploading
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .clip(CircleShape)
                                .background(if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                                .clickable(enabled = canSend) { submit() }
                                .semantics { contentDescription = "发送" },
                            contentAlignment = Alignment.Center,
                        ) {
                            UpArrow(
                                15.dp,
                                if (canSend) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CommandRow(label: String, hint: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 13.sp)
        Spacer(Modifier.weight(1f))
        Text(hint, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun PermissionItem(label: String, selected: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(label, fontSize = 13.sp)
                Spacer(Modifier.weight(1f))
                if (selected) Text("✓", fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
            }
        },
        onClick = onClick,
    )
}

private fun displayName(context: Context, uri: Uri): String? =
    context.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
        ?: uri.lastPathSegment

/** Downloads go to the public Downloads collection on Q+, and to the app's own
 *  external files folder on 26–28, which needs no storage permission. */
private fun saveDownload(context: Context, name: String, bytes: ByteArray): Boolean {
    val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "attachment" }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safe)
            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        val written = resolver.openOutputStream(target)?.use { it.write(bytes) } != null
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(target, values, null, null)
        written
    } else {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return false
        File(dir, safe).writeBytes(bytes)
        true
    }
}

private fun composeBody(quote: Quote?, draft: String): String =
    if (quote == null) draft else "> ${quote.author}：${quote.text}\n\n$draft"

@Composable
private fun DayDivider(label: String) {
    Box(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 14.dp), contentAlignment = Alignment.Center) {
        Text(label, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun MessageBlock(
    message: MessageRow,
    bot: BotRow?,
    bots: List<BotRow>,
    onQuote: (String, String) -> Unit,
    onCopy: (String) -> Unit,
    onAttachment: (String, String) -> Unit,
) {
    if (message.a2aDirection != null && message.a2aDirection != "replied") {
        val peer = bots.firstOrNull { it.id == (message.a2aPeerId ?: message.senderBotId) }
        Text(
            text = when (message.a2aDirection) {
                "sent" -> "已发消息给 ${peer?.name ?: "Agent"}"
                "returned" -> "${peer?.name ?: "Agent"} 返回了结果"
                else -> "消息来自 ${peer?.name ?: "Agent"}"
            },
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    val user = message.role == "user"
    val extra = LocalNexExtra.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(if (user) 0.92f else 0.97f),
            horizontalAlignment = if (user) Alignment.End else Alignment.Start,
        ) {
            if (user) {
                Surface(
                    color = extra.chatUserBubble,
                    shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomEnd = 5.dp, bottomStart = 18.dp),
                ) {
                    Text(
                        message.content,
                        modifier = Modifier.padding(horizontal = 17.dp, vertical = 13.dp),
                        fontSize = 14.sp,
                        lineHeight = 25.sp,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                }
            } else {
                MarkdownText(message.content, onAttachment = onAttachment)
                if (message.toolSteps.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    ToolSteps(message.toolSteps)
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(timeLabel(message.createdAt), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(9.dp))
                TextAction("引用") { onQuote(Copy.senderLabel(message, bot?.name ?: "Agent", null), message.content) }
                Spacer(Modifier.width(9.dp))
                TextAction("复制") { onCopy(message.content) }
            }
        }
    }
}

@Composable
private fun ToolSteps(steps: List<ToolStep>) {
    var open by rememberSaveable(steps.firstOrNull()?.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(4.dp))
                .clickable { open = !open }
                .padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (open) "▾" else "▸", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(4.dp))
            Text(
                "执行记录 · ${steps.size} 项操作",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (open) {
            val outline = MaterialTheme.colorScheme.outline
            val extra = LocalNexExtra.current
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp)
                    .drawBehind {
                        drawLine(
                            color = outline,
                            start = androidx.compose.ui.geometry.Offset(0f, 0f),
                            end = androidx.compose.ui.geometry.Offset(size.width, 0f),
                            strokeWidth = 1.dp.toPx(),
                        )
                    }
                    .padding(top = 4.dp),
            ) {
                steps.forEach { step ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .background(
                                    when (step.status) {
                                        "succeeded" -> extra.success
                                        "failed", "rejected" -> extra.statusFailed
                                        else -> extra.statusOffline
                                    },
                                    CircleShape,
                                ),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            Copy.toolLabel(step.toolName),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onBackground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.width(8.dp))
                        if (step.summary.isNotBlank()) {
                            Text(
                                step.summary,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 10.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                        } else {
                            Spacer(Modifier.weight(1f))
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(
                            Copy.statusLabel(step.status),
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskStatusRow(state: Repository.UiState, botName: String, repository: Repository) {
    val extra = LocalNexExtra.current
    val phrase = when {
        state.pendingApprovals.isNotEmpty() -> "Agent 正在工作·等你批准"
        state.activeTasks.isNotEmpty() -> Copy.taskPhrase(state.activeTasks.first()).ifEmpty { "$botName 正在工作" }
        else -> "$botName 正在工作"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(
            if (state.pendingApprovals.isNotEmpty()) extra.statusApproval else extra.statusWorking,
            6.dp,
        )
        Spacer(Modifier.width(7.dp))
        Text(
            phrase,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .clickable(onClick = repository::stopTasks)
                .padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StopGlyph(10.dp, MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(4.dp))
            Text("停止任务", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ApprovalCard(approval: ApprovalRow, botName: String, onAllow: () -> Unit, onDeny: () -> Unit) {
    val extra = LocalNexExtra.current
    var expanded by rememberSaveable(approval.id) { mutableStateOf(false) }
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, extra.warning),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(
                "$botName 需要你的批准",
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(3.dp))
            Text(
                Copy.approvalDescription(approval.toolName),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            TextAction(if (expanded) "收起具体操作" else "▸ 查看具体操作") { expanded = !expanded }
            if (expanded) {
                Spacer(Modifier.height(6.dp))
                Surface(color = MaterialTheme.colorScheme.background, shape = RoundedCornerShape(6.dp)) {
                    Text(
                        approval.argumentsJson,
                        modifier = Modifier
                            .heightIn(max = 180.dp)
                            .verticalScroll(rememberScrollState())
                            .padding(10.dp),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NexButton(
                    text = "批准",
                    onClick = onAllow,
                    container = extra.strong,
                    content = extra.onStrong,
                    height = 36.dp,
                )
                NexOutlineButton(text = "拒绝", onClick = onDeny, height = 36.dp)
            }
        }
    }
}

@Composable
private fun QuoteBar(quote: Quote, onDismiss: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(quote.author, fontSize = 10.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                quote.text.lineSequence().firstOrNull().orEmpty(),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            "×",
            fontSize = 16.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clickable(onClick = onDismiss).padding(horizontal = 8.dp),
        )
    }
}

@Composable
private fun TypingDots() {
    val extra = LocalNexExtra.current
    val transition = rememberInfiniteTransition(label = "typing")
    val alphas = (0..2).map { index ->
        transition.animateFloat(
            initialValue = 0.25f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(600, delayMillis = index * 150), RepeatMode.Reverse),
            label = "dot-$index",
        )
    }
    Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        alphas.forEach { alpha ->
            Box(
                Modifier
                    .padding(end = 4.dp)
                    .size(4.dp)
                    .background(extra.statusWorking.copy(alpha = alpha.value), CircleShape),
            )
        }
    }
}
