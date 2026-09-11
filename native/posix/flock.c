#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#endif
#define NAPI_VERSION 8
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#define CHECK_NAPI(env, operation) do { \
    if ((operation) != napi_ok) { \
        napi_throw_error((env), NULL, "Node-API operation failed"); \
        return NULL; \
    } \
} while (0)

static const char *errno_code(int number) {
    switch (number) {
        case ENOENT: return "ENOENT";
        case ENOTDIR: return "ENOTDIR";
        case ELOOP: return "ELOOP";
        case ENAMETOOLONG: return "ENAMETOOLONG";
        case EOVERFLOW: return "EOVERFLOW";
        case EMFILE: return "EMFILE";
        case ENFILE: return "ENFILE";
        case EBADF: return "EBADF";
        case EINTR: return "EINTR";
        case EAGAIN: return "EAGAIN";
#if EWOULDBLOCK != EAGAIN
        case EWOULDBLOCK: return "EWOULDBLOCK";
#endif
        case EINVAL: return "EINVAL";
        case ENOLCK: return "ENOLCK";
        case EACCES: return "EACCES";
        case EPERM: return "EPERM";
        case EIO: return "EIO";
        case ENOMEM: return "ENOMEM";
        case ENOSYS: return "ENOSYS";
        case EOPNOTSUPP: return "EOPNOTSUPP";
#if ENOTSUP != EOPNOTSUPP
        case ENOTSUP: return "ENOTSUP";
#endif
        default: return "UNKNOWN";
    }
}

static napi_value throw_errno(napi_env env, int number) {
    napi_value message, error, code, numeric_errno;
    CHECK_NAPI(env, napi_create_string_utf8(env, strerror(number), NAPI_AUTO_LENGTH, &message));
    CHECK_NAPI(env, napi_create_error(env, NULL, message, &error));
    CHECK_NAPI(env, napi_create_string_utf8(env, errno_code(number), NAPI_AUTO_LENGTH, &code));
    CHECK_NAPI(env, napi_create_int32(env, number, &numeric_errno));
    CHECK_NAPI(env, napi_set_named_property(env, error, "code", code));
    CHECK_NAPI(env, napi_set_named_property(env, error, "errno", numeric_errno));
    CHECK_NAPI(env, napi_throw(env, error));
    return NULL;
}

static int descriptor_argument(napi_env env, napi_callback_info info, int *descriptor) {
    size_t count = 2;
    napi_value arguments[2];
    napi_valuetype type;
    double value;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok) {
        napi_throw_error(env, NULL, "Cannot read flock arguments");
        return 0;
    }
    if (count != 1 || napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_number
        || napi_get_value_double(env, arguments[0], &value) != napi_ok) {
        napi_throw_type_error(env, NULL, "flock requires exactly one numeric descriptor");
        return 0;
    }
    if (!isfinite(value) || value < 0 || value > INT_MAX || floor(value) != value) {
        napi_throw_range_error(env, NULL, "descriptor must be a nonnegative C int");
        return 0;
    }
    *descriptor = (int)value;
    return 1;
}

static napi_value try_lock(napi_env env, napi_callback_info info) {
    int descriptor;
    napi_value result;
    if (!descriptor_argument(env, info, &descriptor)) return NULL;
    if (flock(descriptor, LOCK_EX | LOCK_NB) == 0) {
        CHECK_NAPI(env, napi_get_boolean(env, 1, &result));
        return result;
    }
    int number = errno;
    if (number == EWOULDBLOCK || number == EAGAIN) {
        CHECK_NAPI(env, napi_get_boolean(env, 0, &result));
        return result;
    }
    return throw_errno(env, number);
}

static napi_value unlock(napi_env env, napi_callback_info info) {
    int descriptor;
    napi_value result;
    if (!descriptor_argument(env, info, &descriptor)) return NULL;
    if (flock(descriptor, LOCK_UN) != 0) return throw_errno(env, errno);
    CHECK_NAPI(env, napi_get_undefined(env, &result));
    return result;
}

/* Directory descriptors are caller-owned. No operation resolves the root path again. */
static int entry_arguments(napi_env env, napi_callback_info info, int *fd, char **name) {
    size_t count = 3, length = 0;
    napi_value arguments[3];
    napi_valuetype type;
    double value;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok
        || count != 2 || napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_number
        || napi_get_value_double(env, arguments[0], &value) != napi_ok
        || !isfinite(value) || value < 0 || value > INT_MAX || floor(value) != value
        || napi_typeof(env, arguments[1], &type) != napi_ok || type != napi_string
        || napi_get_value_string_utf8(env, arguments[1], NULL, 0, &length) != napi_ok) {
        napi_throw_type_error(env, NULL, "directory operation requires descriptor and basename");
        return 0;
    }
    if (length == 0 || length > NAME_MAX) {
        napi_throw_range_error(env, NULL, "directory basename length is invalid");
        return 0;
    }
    *name = malloc(length + 1);
    if (!*name) { throw_errno(env, ENOMEM); return 0; }
    size_t written;
    if (napi_get_value_string_utf8(env, arguments[1], *name, length + 1, &written) != napi_ok
        || written != length || strlen(*name) != length || strchr(*name, '/')
        || strcmp(*name, ".") == 0 || strcmp(*name, "..") == 0) {
        free(*name);
        napi_throw_type_error(env, NULL, "directory basename is invalid");
        return 0;
    }
    napi_value roundtrip;
    bool identical;
    if (napi_create_string_utf8(env, *name, length, &roundtrip) != napi_ok
        || napi_strict_equals(env, arguments[1], roundtrip, &identical) != napi_ok || !identical) {
        free(*name);
        napi_throw_type_error(env, NULL, "directory basename must be valid UTF-8");
        return 0;
    }
    *fd = (int)value;
    return 1;
}

static napi_value list_names(napi_env env, napi_callback_info info) {
    int fd;
    napi_value result;
    if (!descriptor_argument(env, info, &fd)) return NULL;
    CHECK_NAPI(env, napi_create_array(env, &result));
    int scanfd = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (scanfd < 0) return throw_errno(env, errno);
    DIR *directory = fdopendir(scanfd);
    if (!directory) { int number = errno; close(scanfd); return throw_errno(env, number); }
    uint32_t index = 0;
    int number = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (!entry) { number = errno; break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        napi_value name;
        if (napi_create_buffer_copy(env, strlen(entry->d_name), entry->d_name, NULL, &name) != napi_ok
            || napi_set_element(env, result, index++, name) != napi_ok) {
            closedir(directory);
            napi_throw_error(env, NULL, "Cannot create directory listing");
            return NULL;
        }
    }
    if (closedir(directory) < 0 && !number) number = errno;
    if (number) return throw_errno(env, number);
    return result;
}

static napi_value inspect_entry(napi_env env, napi_callback_info info) {
    int fd;
    char *name;
    struct stat metadata;
    napi_value result, value;
    if (!entry_arguments(env, info, &fd, &name)) return NULL;
    int status = fstatat(fd, name, &metadata, AT_SYMLINK_NOFOLLOW);
    int number = errno;
    free(name);
    if (status < 0) return throw_errno(env, number);
    CHECK_NAPI(env, napi_create_object(env, &result));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, (uint64_t)metadata.st_dev, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "dev", value));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, (uint64_t)metadata.st_ino, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "ino", value));
    CHECK_NAPI(env, napi_create_bigint_int64(env, (int64_t)metadata.st_size, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "size", value));
    CHECK_NAPI(env, napi_create_uint32(env, (uint32_t)metadata.st_mode, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "mode", value));
    return result;
}

static napi_value open_entry(napi_env env, napi_callback_info info) {
    int fd;
    char *name;
    napi_value result;
    if (!entry_arguments(env, info, &fd, &name)) return NULL;
    int opened = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    int number = errno;
    free(name);
    if (opened < 0) return throw_errno(env, number);
    if (napi_create_int32(env, opened, &result) != napi_ok) {
        close(opened);
        napi_throw_error(env, NULL, "Cannot return opened descriptor");
        return NULL;
    }
    return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        { "tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL },
        { "unlock", NULL, unlock, NULL, NULL, NULL, napi_default, NULL },
        { "listNames", NULL, list_names, NULL, NULL, NULL, napi_default, NULL },
        { "inspect", NULL, inspect_entry, NULL, NULL, NULL, napi_default, NULL },
        { "openFile", NULL, open_entry, NULL, NULL, NULL, napi_default, NULL },
    };
    CHECK_NAPI(env, napi_define_properties(env, exports, 5, properties));
    return exports;
}

NAPI_MODULE(flock, initialize)
