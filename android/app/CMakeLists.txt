cmake_minimum_required(VERSION 3.22.1)
project(qsyy-node)

# nodejs-mobile's libnode.so. Headers and the .so are fetched by the
# fetchLibnode Gradle task into app/libnode (not committed; ~60MB).
include_directories(${CMAKE_SOURCE_DIR}/libnode/include/node)

add_library(native-lib SHARED src/main/cpp/node_launcher.cpp)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
