package com.nexorai.nexbot.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.nexorai.nexbot.MainActivity
import com.nexorai.nexbot.R

/**
 * Local notifications, on while the process is alive. Closed-app push (FCM)
 * needs Core-side registration and is deliberately not part of v1; see
 * docs/plans/2026-10-17-android-client.md §7.4.
 */
class NotificationNotifier(private val context: Context) : Notifier {
    override fun approval(botId: String, botName: String) {
        post(
            id = APPROVAL_NOTIFICATION,
            title = context.getString(R.string.notification_approval, botName),
            text = context.getString(R.string.approval_title, botName),
            botId = botId,
        )
    }

    override fun reply(botId: String, botName: String) {
        post(
            id = REPLY_NOTIFICATION,
            title = context.getString(R.string.notification_reply, botName),
            text = context.getString(R.string.app_name),
            botId = botId,
        )
    }

    private fun post(id: Int, title: String, text: String, botId: String) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(EXTRA_BOT, botId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            // A monochrome companion silhouette, as Android requires for the
            // status bar; the launcher icon is the full-colour brand mark.
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        runCatching { manager.notify(id, notification) }
    }

    companion object {
        const val CHANNEL_ID = "nexbot"
        const val EXTRA_BOT = "com.nexorai.nexbot.BOT_ID"
        private const val APPROVAL_NOTIFICATION = 2101
        private const val REPLY_NOTIFICATION = 2102

        fun createChannel(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.notification_channel_description)
            }
            manager.createNotificationChannel(channel)
        }
    }
}
