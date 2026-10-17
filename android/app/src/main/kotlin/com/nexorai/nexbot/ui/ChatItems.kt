package com.nexorai.nexbot.ui

import com.nexorai.nexbot.core.MessageRow
import java.time.ZoneId

/** A transcript row: a day divider or a message. */
sealed interface ChatItem {
    data class Day(val label: String) : ChatItem

    data class Msg(val message: MessageRow) : ChatItem
}

fun chatItems(
    messages: List<MessageRow>,
    now: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(),
): List<ChatItem> {
    val items = mutableListOf<ChatItem>()
    var lastDay: String? = null
    for (message in messages) {
        val day = dayLabel(message.createdAt, now, zone)
        if (day != lastDay) {
            items += ChatItem.Day(day)
            lastDay = day
        }
        items += ChatItem.Msg(message)
    }
    return items
}
