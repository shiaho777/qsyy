import java.net.URI

plugins {
    id("com.android.application")
}

val qsyyAssets = layout.buildDirectory.dir("generated/qsyyAssets")

tasks.register("fetchLibnode") {
    notCompatibleWithConfigurationCache("downloads and unzips libnode")
    val dest = layout.projectDirectory.dir("libnode")
    val zip = layout.buildDirectory.file("nodejs-mobile-v18.20.4-android.zip")
    outputs.dir(dest)
    doLast {
        val header = dest.file("include/node/node.h").asFile
        val so = dest.file("bin/arm64-v8a/libnode.so").asFile
        if (header.isFile && so.isFile) return@doLast
        val zipFile = zip.get().asFile
        zipFile.parentFile.mkdirs()
        if (!zipFile.isFile || zipFile.length() < 1_000_000) {
            URI.create(
                "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip"
            ).toURL().openStream().use { input ->
                zipFile.outputStream().use { output -> input.copyTo(output) }
            }
        }
        copy {
            from(zipTree(zipFile))
            include("include/**", "bin/arm64-v8a/**")
            into(dest)
        }
    }
}

tasks.register<Copy>("syncQsyyRuntime") {
    into(qsyyAssets.map { it.dir("qsyy-app") })
    from(rootProject.file("../app/standalone")) {
        include("server.mjs", "platform.mjs", "ttnet-helper.mjs", "public/**")
        exclude("device.json", "web-session.json")
        into("standalone")
    }
    from(rootProject.file("../app/bridge")) {
        include("restore_cache.js", "lib/**")
        exclude("**/node_modules/**")
        into("bridge")
    }
    from("src/main/qsyy-boot") {
        include("boot.mjs")
    }
}

android {
    namespace = "com.shiaho777.qsyy"
    compileSdk = 35
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "com.shiaho777.qsyy"
        minSdk = 24
        targetSdk = 35
        versionCode = 10
        versionName = "1.3.1"
        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
        ndk {
            // nodejs-mobile ships this ABI. 32-bit armeabi-v7a is omitted:
            // libnode.so is ~60MB per ABI.
            abiFilters += "arm64-v8a"
        }
    }

    // No signing config: CI assembles a debug-signed APK (runnable out of the
    // box); release builds with a real keystore are a maintainer step.
    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("libnode/bin")
            assets.srcDir(qsyyAssets)
        }
    }
}

tasks.configureEach {
    if (name.contains("CMake") || name.contains("externalNative") || name.contains("Jni")) {
        dependsOn("fetchLibnode")
    }
    if (name.contains("merge") && name.contains("Assets")) {
        dependsOn("syncQsyyRuntime")
    }
}

dependencies {
    // appcompat pulls kotlin-stdlib-jdk7/jdk8 1.6.x which now ships inside
    // kotlin-stdlib >= 1.8 — exclude the legacy artifacts outright
    implementation("androidx.appcompat:appcompat:1.7.0") {
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk7")
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk8")
    }
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.8.22")
}
