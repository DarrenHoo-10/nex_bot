import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    // AGP 9 has Kotlin support built in; the deleted app used the same trio.
    kotlin("plugin.compose")
    kotlin("plugin.serialization")
}

val appVersionName = "0.2.7"
val appVersionCode = 207

val buildWorkspaceUi by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir.parentFile)
    commandLine("node", "scripts/build-android-ui.mjs")
    inputs.dir(rootProject.file("../src/personal"))
    inputs.dir(rootProject.file("../shared"))
    inputs.file(rootProject.file("../electron/client/style.css"))
    inputs.file(rootProject.file("../scripts/build-android-ui.mjs"))
    inputs.file(rootProject.file("../pnpm-lock.yaml"))
    outputs.dir(layout.buildDirectory.dir("generated/workspaceAssets"))
}
tasks.named("preBuild").configure { dependsOn(buildWorkspaceUi) }

android {
    namespace = "com.nexorai.nexbot"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.nexorai.nexbot"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    buildTypes {
        debug {
            // Installs beside a signed release without sharing its data.
            applicationIdSuffix = ".debug"
        }
        release {
            // R8 stays off until its keep rules have been tested against a real
            // session: @Serializable resolves serializers reflectively, and a
            // minified build can otherwise fail on the first decoded frame
            // (the deleted app recorded exactly that failure). See
            // docs/plans/2026-10-17-android-client.md §9.2.
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/workspaceAssets").get().asFile)

    testOptions {
        unitTests {
            // Robolectric mounts real compositions against merged resources.
            isIncludeAndroidResources = true
            all { it.maxHeapSize = "2g" }
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

/**
 * A distributable name instead of AGP's `app-debug.apk`. Release builds are
 * unsigned until signing material is wired (§9.2), so the suffix says so.
 */
androidComponents {
    onVariants { variant ->
        val suffix = if (variant.buildType == "release") "unsigned" else variant.buildType
        variant.outputs.forEach { output ->
            output.outputFileName.set("nexbot-$appVersionName-$suffix.apk")
        }
    }
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2025.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-process:2.9.4")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation(kotlin("test-junit"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation(composeBom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation(composeBom)
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
