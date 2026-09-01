// qsyy Android shell settings — Gradle module layout is minimal: a single
// WebView activity pointing at the user's qsyy server.
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "qsyy"
include(":app")
