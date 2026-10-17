pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "nexbot-android"

// `:core` is a plain JVM module; `:app` is the Compose shell. See README.md.
include(":core")
include(":app")
