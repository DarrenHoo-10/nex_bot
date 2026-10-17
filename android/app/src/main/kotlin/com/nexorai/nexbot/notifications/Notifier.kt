package com.nexorai.nexbot.notifications

/** The two events a connected phone can announce while the app is alive. */
interface Notifier {
    fun approval(botId: String, botName: String)

    fun reply(botId: String, botName: String)

    object None : Notifier {
        override fun approval(botId: String, botName: String) = Unit

        override fun reply(botId: String, botName: String) = Unit
    }
}
