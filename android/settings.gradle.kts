// qsyy Android shell. The activity embeds the standalone server and opens it
// on 127.0.0.1; there is no remote address to configure.
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "qsyy"
include(":app")
