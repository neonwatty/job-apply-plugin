#if defined(__linux__)
#define _GNU_SOURCE
#elif defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define DIRECTORY_FLAGS (O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
#define FILE_FLAGS (O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
#define NAME_CAPACITY 256

static napi_value fail(napi_env env, int number) {
    const char *code = "EIO";
    if (number == ENOENT) code = "ENOENT";
    if (number == EEXIST) code = "EEXIST";
    if (number == ENOSYS || number == ENOTSUP) code = "ENOSYS";
    if (number == ELOOP || number == EISDIR || number == ENOTDIR) code = "EUNSAFEPATH";
    napi_throw_error(env, code, "Recorder filesystem operation failed");
    return NULL;
}

#define REQUIRE_NAPI(call) do { if ((call) != napi_ok) return fail(env, EIO); } while (0)

static bool int_arg(napi_env env, napi_value value, int *result) {
    double number;
    if (napi_get_value_double(env, value, &number) != napi_ok ||
        !(number >= 0 && number <= INT_MAX) || (int)number != number) return false;
    *result = (int)number;
    return true;
}

static bool name_arg(napi_env env, napi_value value, char name[NAME_CAPACITY]) {
    size_t length, copied;
    return napi_get_value_string_utf8(env, value, NULL, 0, &length) == napi_ok &&
        length > 0 && length < NAME_CAPACITY &&
        napi_get_value_string_utf8(env, value, name, NAME_CAPACITY, &copied) == napi_ok &&
        copied == length && strlen(name) == length && !strchr(name, '/') &&
        strcmp(name, ".") != 0 && strcmp(name, "..") != 0;
}

static napi_value bad_arguments(napi_env env) {
    napi_throw_type_error(env, NULL, "Invalid recorder directory arguments");
    return NULL;
}

static napi_value return_fd(napi_env env, int fd) {
    napi_value result;
    if (fd < 0) return fail(env, errno);
    if (napi_create_int32(env, fd, &result) != napi_ok) {
        close(fd);
        return fail(env, EIO);
    }
    return result;
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
    napi_value args[2];
    size_t count = 2;
    int fd;
    char name[NAME_CAPACITY];
    REQUIRE_NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
    if (count != 2 || !int_arg(env, args[0], &fd) || !name_arg(env, args[1], name)) return bad_arguments(env);
    return return_fd(env, openat(fd, name, DIRECTORY_FLAGS));
}

static napi_value open_file(napi_env env, napi_callback_info info) {
    napi_value args[3];
    size_t count = 3;
    int fd, mode;
    char name[NAME_CAPACITY];
    REQUIRE_NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
    if (count != 3 || !int_arg(env, args[0], &fd) || !name_arg(env, args[1], name) ||
        !int_arg(env, args[2], &mode) || mode > 2) return bad_arguments(env);
    const int access[] = { O_RDONLY, O_WRONLY | O_CREAT | O_EXCL, O_WRONLY | O_APPEND };
    return return_fd(env, openat(fd, name, FILE_FLAGS | access[mode], 0600));
}

static napi_value inspect(napi_env env, napi_callback_info info) {
    napi_value args[2], result, value;
    size_t count = 2;
    int fd;
    char name[NAME_CAPACITY];
    struct stat metadata;
    REQUIRE_NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
    if (count != 2 || !int_arg(env, args[0], &fd) || !name_arg(env, args[1], name)) return bad_arguments(env);
    if (fstatat(fd, name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) return fail(env, errno);
    REQUIRE_NAPI(napi_create_object(env, &result));
    REQUIRE_NAPI(napi_create_uint32(env, metadata.st_mode, &value));
    REQUIRE_NAPI(napi_set_named_property(env, result, "mode", value));
    REQUIRE_NAPI(napi_create_double(env, (double)metadata.st_size, &value));
    REQUIRE_NAPI(napi_set_named_property(env, result, "size", value));
    return result;
}

static napi_value create_directory(napi_env env, napi_callback_info info) {
    napi_value args[2], result;
    size_t count = 2;
    int fd;
    char name[NAME_CAPACITY];
    REQUIRE_NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
    if (count != 2 || !int_arg(env, args[0], &fd) || !name_arg(env, args[1], name)) return bad_arguments(env);
    if (mkdirat(fd, name, 0700) < 0) return fail(env, errno);
    REQUIRE_NAPI(napi_get_undefined(env, &result));
    return result;
}

static napi_value unlink_entry(napi_env env, napi_callback_info info) {
    napi_value args[3], result;
    size_t count = 3;
    int fd;
    bool directory;
    char name[NAME_CAPACITY];
    REQUIRE_NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
    if (count != 3 || !int_arg(env, args[0], &fd) || !name_arg(env, args[1], name) ||
        napi_get_value_bool(env, args[2], &directory) != napi_ok) return bad_arguments(env);
    if (unlinkat(fd, name, directory ? AT_REMOVEDIR : 0) < 0) return fail(env, errno);
    REQUIRE_NAPI(napi_get_undefined(env, &result));
    return result;
}

static napi_value rename_entry(napi_env env, napi_callback_info info) {
    napi_value args[5], result;
    size_t count = 5;
    int source_fd, destination_fd, status;
    bool exclusive;
    char source[NAME_CAPACITY], destination[NAME_CAPACITY];
    REQUIRE_NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
    if (count != 5 || !int_arg(env, args[0], &source_fd) || !name_arg(env, args[1], source) ||
        !int_arg(env, args[2], &destination_fd) || !name_arg(env, args[3], destination) ||
        napi_get_value_bool(env, args[4], &exclusive) != napi_ok) return bad_arguments(env);
    if (!exclusive) status = renameat(source_fd, source, destination_fd, destination);
#if defined(__APPLE__)
    else status = renameatx_np(source_fd, source, destination_fd, destination, RENAME_EXCL);
#elif defined(__linux__)
    else status = renameat2(source_fd, source, destination_fd, destination, RENAME_NOREPLACE);
#else
    else return fail(env, ENOSYS);
#endif
    if (status < 0) return fail(env, errno);
    REQUIRE_NAPI(napi_get_undefined(env, &result));
    return result;
}

static napi_value list(napi_env env, napi_callback_info info) {
    napi_value args[2], result;
    size_t count = 2;
    int fd, maximum;
    REQUIRE_NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
    if (count != 2 || !int_arg(env, args[0], &fd) || !int_arg(env, args[1], &maximum) || maximum > 4096) return bad_arguments(env);
    REQUIRE_NAPI(napi_create_array(env, &result));
    int opened = openat(fd, ".", DIRECTORY_FLAGS);
    if (opened < 0) return fail(env, errno);
    DIR *directory = fdopendir(opened);
    if (!directory) {
        int number = errno;
        close(opened);
        return fail(env, number);
    }
    int index = 0, number;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        number = errno;
        if (entry == NULL) break;
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        if (index >= maximum) {
            closedir(directory);
            napi_throw_error(env, "EENTRYBUDGET", "Recorder directory entry budget exceeded");
            return NULL;
        }
        napi_value value;
        if (napi_create_buffer_copy(env, strlen(entry->d_name), entry->d_name, NULL, &value) != napi_ok ||
            napi_set_element(env, result, (uint32_t)index++, value) != napi_ok) {
            number = EIO;
            break;
        }
    }
    if (closedir(directory) < 0 && number == 0) number = errno;
    return number ? fail(env, number) : result;
}

NAPI_MODULE_INIT() {
    const napi_property_descriptor methods[] = {
        { "openDirectory", NULL, open_directory, NULL, NULL, NULL, napi_default, NULL },
        { "openFile", NULL, open_file, NULL, NULL, NULL, napi_default, NULL },
        { "inspect", NULL, inspect, NULL, NULL, NULL, napi_default, NULL },
        { "mkdir", NULL, create_directory, NULL, NULL, NULL, napi_default, NULL },
        { "unlink", NULL, unlink_entry, NULL, NULL, NULL, napi_default, NULL },
        { "rename", NULL, rename_entry, NULL, NULL, NULL, napi_default, NULL },
        { "list", NULL, list, NULL, NULL, NULL, napi_default, NULL },
    };
    REQUIRE_NAPI(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
    return exports;
}
