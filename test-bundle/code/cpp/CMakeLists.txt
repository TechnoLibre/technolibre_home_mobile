cmake_minimum_required(VERSION 3.16)
project(demo_cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(ringbuffer INTERFACE)
target_include_directories(ringbuffer INTERFACE src)

add_executable(demo src/main.cpp)
target_link_libraries(demo PRIVATE ringbuffer)

enable_testing()
add_executable(tests src/ring_buffer_test.cpp)
target_link_libraries(tests PRIVATE ringbuffer)
add_test(NAME ring_buffer COMMAND tests)
