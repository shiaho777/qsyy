#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include "node.h"

// libuv wants argv in one contiguous buffer. node::Start blocks for the
// life of the embedded server, so Java calls this off the UI thread.
extern "C" JNIEXPORT jint JNICALL
Java_com_shiaho777_qsyy_NodeRuntime_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {
    const jsize argc = env->GetArrayLength(arguments);
    int bytes = 0;
    for (jsize i = 0; i < argc; i++) {
        jstring value = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *utf = env->GetStringUTFChars(value, nullptr);
        bytes += strlen(utf) + 1;
        env->ReleaseStringUTFChars(value, utf);
        env->DeleteLocalRef(value);
    }

    char *buffer = (char *) calloc(bytes, 1);
    char **argv = (char **) calloc(argc, sizeof(char *));
    char *cursor = buffer;
    for (jsize i = 0; i < argc; i++) {
        jstring value = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *utf = env->GetStringUTFChars(value, nullptr);
        size_t len = strlen(utf);
        memcpy(cursor, utf, len);
        argv[i] = cursor;
        cursor += len + 1;
        env->ReleaseStringUTFChars(value, utf);
        env->DeleteLocalRef(value);
    }

    const int code = node::Start(argc, argv);
    free(argv);
    free(buffer);
    return code;
}
