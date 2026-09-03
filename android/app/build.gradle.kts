plugins {
    id("com.android.application")
}

android {
    namespace = "com.shiaho777.qsyy"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.shiaho777.qsyy"
        minSdk = 24
        targetSdk = 35
        versionCode = 4
        versionName = "1.1.0"
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
