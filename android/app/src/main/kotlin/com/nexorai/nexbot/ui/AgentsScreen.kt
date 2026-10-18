package com.nexorai.nexbot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nexorai.nexbot.core.BotRow
import com.nexorai.nexbot.sync.Repository

/**
 * The contact sidebar from `doc/ui/workspace-mobile.png`, promoted to a full
 * screen: brand row, search, conversation count, companion rows with unread
 * badges and time, and the account row pinned at the bottom.
 */
@Composable
fun AgentsScreen(
    state: Repository.UiState,
    onOpen: (String) -> Unit,
    onLogout: () -> Unit,
    onRefresh: () -> Unit,
) {
    val extra = LocalNexExtra.current
    var query by rememberSaveable { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }
    val bots = remember(state.bots, query) {
        if (query.isBlank()) state.bots
        else state.bots.filter {
            it.name.contains(query.trim(), ignoreCase = true) ||
                it.lastMessage.orEmpty().contains(query.trim(), ignoreCase = true)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(extra.sidebar)
            .safeDrawingPadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(64.dp)
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NexMark(28.dp)
            Spacer(Modifier.width(9.dp))
            Text(
                "NexBot",
                fontSize = 16.sp,
                fontWeight = BrandWeight,
                letterSpacing = (-0.6).sp,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.weight(1f))
        }

        Surface(
            shape = RoundedCornerShape(8.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .height(36.dp),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SearchGlyph(14.dp, MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(8.dp))
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    textStyle = TextStyle(fontSize = 12.sp, color = MaterialTheme.colorScheme.onBackground),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    modifier = Modifier.weight(1f),
                    decorationBox = { inner ->
                        Box {
                            if (query.isEmpty()) {
                                Text("搜索联系人", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            inner()
                        }
                    },
                )
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, top = 22.dp, bottom = 10.dp),
        ) {
            Text("对话", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Text(state.bots.size.toString(), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        if (!state.connected) {
            NoticeBanner("Core 连接中断，正在重新同步…", action = "重试", onAction = onRefresh)
        }
        state.error?.let { error ->
            if (state.connected) NoticeBanner(error, action = "重试", onAction = onRefresh)
        }

        if (bots.isEmpty()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    if (query.isNotBlank()) "没有匹配的联系人" else "还没有 Agent",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 2.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                items(bots, key = { it.id }) { bot ->
                    ContactRow(
                        bot = bot,
                        allBots = state.bots,
                        state = state,
                        onClick = { onOpen(bot.id) },
                    )
                }
            }
        }

        Surface(color = extra.sidebar) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { menuOpen = true }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AccountAvatar(30.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        state.connection?.account?.takeIf { it.isNotBlank() } ?: "NexorAI 用户",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onBackground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).background(extra.success, CircleShape))
                        Spacer(Modifier.width(5.dp))
                        Text("个人工作空间", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                ChevronDown(14.dp, MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

    if (menuOpen) {
        AlertDialog(
            onDismissRequest = { menuOpen = false },
            title = { Text(state.connection?.account ?: "NexorAI 用户", fontSize = 16.sp) },
            text = { Text("个人工作空间", fontSize = 13.sp) },
            confirmButton = {
                TextButton(onClick = {
                    menuOpen = false
                    onRefresh()
                }) { Text("刷新") }
            },
            dismissButton = {
                TextButton(onClick = {
                    menuOpen = false
                    confirmLogout = true
                }) { Text("退出登录") }
            },
        )
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("退出当前账号？", fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
            text = { Text("退出后需要重新登录。你的聊天和助手会保留。", fontSize = 13.sp) },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    onLogout()
                }) { Text("退出登录") }
            },
            dismissButton = {
                TextButton(onClick = { confirmLogout = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun ContactRow(bot: BotRow, allBots: List<BotRow>, state: Repository.UiState, onClick: () -> Unit) {
    val selected = state.selectedBotId == bot.id
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(9.dp))
            .background(if (selected) MaterialTheme.colorScheme.surface else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CompanionAvatar(
            bot = bot,
            allBots = allBots,
            size = 44.dp,
            state = companionState(state, bot),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    bot.name,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onBackground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.weight(1f))
                bot.lastMessageAt?.let { at ->
                    Text(timeLabel(at), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    bot.lastMessage?.lineSequence()?.firstOrNull()?.takeIf { it.isNotBlank() } ?: "还没有消息",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (bot.unreadCount > 0) {
                    Spacer(Modifier.width(6.dp))
                    UnreadBadge(bot.unreadCount.toInt())
                }
            }
        }
    }
}
