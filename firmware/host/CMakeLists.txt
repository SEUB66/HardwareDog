# The firmware core on a PC: hwdog-host (simulated board) and the unit tests.
cmake_minimum_required(VERSION 3.16)
project(hwdog_host C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(CORE ${CMAKE_CURRENT_SOURCE_DIR}/../components/hdp)
add_compile_options(-Wall -Wextra -Werror -Wshadow -Wconversion -Wno-sign-conversion -Wno-float-conversion)

add_library(hdp STATIC ${CORE}/hdp.c)
target_include_directories(hdp PUBLIC ${CORE}/include)
target_link_libraries(hdp PUBLIC m)

add_executable(hwdog-host host_main.c)
target_link_libraries(hwdog-host hdp)

# The tests run the core with AddressSanitizer and UBSan.
add_executable(hdp-tests tests.c ${CORE}/hdp.c)
target_include_directories(hdp-tests PRIVATE ${CORE}/include)
target_compile_options(hdp-tests PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
target_link_options(hdp-tests PRIVATE -fsanitize=address,undefined)
target_link_libraries(hdp-tests m)

enable_testing()
add_test(NAME firmware-core COMMAND hdp-tests)
