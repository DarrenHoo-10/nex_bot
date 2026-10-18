package com.nexorai.nexbot

import android.app.Application
import android.os.Build
import com.nexorai.nexbot.data.KeystoreSecretBox
import com.nexorai.nexbot.data.PrefsConnectionStore
import com.nexorai.nexbot.notifications.NotificationNotifier
import com.nexorai.nexbot.sync.Repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class NexBotApp : Application() {
    lateinit var repository: Repository
        private set

    override fun onCreate() {
        super.onCreate()
        NotificationNotifier.createChannel(this)
        repository = Repository(
            store = PrefsConnectionStore(this, KeystoreSecretBox()),
            notifier = NotificationNotifier(this),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
            deviceName = {
                val model = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android"
                "$model · Android"
            },
        )
    }
}
