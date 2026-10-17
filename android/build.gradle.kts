// Versions are the matrix the deleted Android app already proved against this
// repository (git show 0d6708c5^:android/build.gradle.kts): Gradle 9.5.0,
// AGP 9.3.1, Kotlin 2.2.21. Keep the Kotlin version in lockstep with :core.
plugins {
    kotlin("jvm") version "2.2.21" apply false
    kotlin("plugin.serialization") version "2.2.21" apply false
    kotlin("plugin.compose") version "2.2.21" apply false
    id("com.android.application") version "9.3.1" apply false
}
