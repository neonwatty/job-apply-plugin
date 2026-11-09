#define _POSIX_C_SOURCE 200809L
#define NAPI_VERSION 8
#include <node_api.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

_Static_assert(sizeof(time_t) <= sizeof(int64_t), "Unsupported time_t width");
_Static_assert((time_t)-1 < (time_t)0, "Signed time_t required");

typedef struct {
    napi_ref buffer_constructor;
    napi_ref is_buffer;
} timestamp_binding;

static void release_binding(napi_env env, void *data, void *hint) {
    (void)hint;
    timestamp_binding *binding = data;
    if (binding->buffer_constructor != NULL) napi_delete_reference(env, binding->buffer_constructor);
    if (binding->is_buffer != NULL) napi_delete_reference(env, binding->is_buffer);
    free(binding);
}

typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    char *path;
    struct timespec times[2];
    int flags;
    int error_number;
} timestamp_work;

static const char *errno_code(int number) {
    switch (number) {
        case EACCES: return "EACCES";
        case EPERM: return "EPERM";
        case ENOENT: return "ENOENT";
        case ENOTDIR: return "ENOTDIR";
        case ELOOP: return "ELOOP";
        case ENAMETOOLONG: return "ENAMETOOLONG";
        case EROFS: return "EROFS";
        case EINVAL: return "EINVAL";
        case EFAULT: return "EFAULT";
        case EBADF: return "EBADF";
        case EINTR: return "EINTR";
        case EIO: return "EIO";
        case ENOMEM: return "ENOMEM";
        case ENOSPC: return "ENOSPC";
        case ENOSYS: return "ENOSYS";
        case EOVERFLOW: return "EOVERFLOW";
        case EOPNOTSUPP: return "EOPNOTSUPP";
#if ENOTSUP != EOPNOTSUPP
        case ENOTSUP: return "ENOTSUP";
#endif
        default: return "UNKNOWN";
    }
}

static napi_value make_error(napi_env env, int number) {
    napi_value message, error, code, numeric_errno;
    if (napi_create_string_utf8(env, strerror(number), NAPI_AUTO_LENGTH, &message) != napi_ok
        || napi_create_error(env, NULL, message, &error) != napi_ok
        || napi_create_string_utf8(env, errno_code(number), NAPI_AUTO_LENGTH, &code) != napi_ok
        || napi_create_int32(env, number, &numeric_errno) != napi_ok
        || napi_set_named_property(env, error, "code", code) != napi_ok
        || napi_set_named_property(env, error, "errno", numeric_errno) != napi_ok) return NULL;
    return error;
}

static int read_time(napi_env env, napi_value seconds, napi_value nanos, struct timespec *result) {
    napi_valuetype type;
    int64_t value;
    bool lossless;
    double fraction;
    if (napi_typeof(env, seconds, &type) != napi_ok || type != napi_bigint
        || napi_get_value_bigint_int64(env, seconds, &value, &lossless) != napi_ok) {
        napi_throw_type_error(env, NULL, "Timestamp seconds must be a bigint");
        return 0;
    }
    if (!lossless || (int64_t)(time_t)value != value) {
        napi_throw_range_error(env, NULL, "Timestamp seconds exceed native time_t");
        return 0;
    }
    if (napi_typeof(env, nanos, &type) != napi_ok || type != napi_number
        || napi_get_value_double(env, nanos, &fraction) != napi_ok) {
        napi_throw_type_error(env, NULL, "Timestamp nanoseconds must be a number");
        return 0;
    }
    if (!isfinite(fraction) || floor(fraction) != fraction || fraction < 0 || fraction > 999999999) {
        napi_throw_range_error(env, NULL, "Timestamp nanoseconds must be normalized");
        return 0;
    }
    result->tv_sec = (time_t)value;
    result->tv_nsec = (long)fraction;
    return 1;
}

static void execute(napi_env env, void *data) {
    (void)env;
    timestamp_work *operation = data;
    if (utimensat(AT_FDCWD, operation->path, operation->times, operation->flags) != 0) {
        operation->error_number = errno;
    }
}

static void complete(napi_env env, napi_status status, void *data) {
    timestamp_work *operation = data;
    napi_value result;
    if (status != napi_ok || operation->error_number != 0) {
        result = make_error(env, status != napi_ok ? EINTR : operation->error_number);
        if (result != NULL) napi_reject_deferred(env, operation->deferred, result);
    } else if (napi_get_undefined(env, &result) == napi_ok) {
        napi_resolve_deferred(env, operation->deferred, result);
    }
    napi_delete_async_work(env, operation->work);
    free(operation->path);
    free(operation);
}

static napi_value set_times(napi_env env, napi_callback_info info) {
    size_t count = 7;
    napi_value arguments[7];
    bool is_buffer, follow;
    napi_valuetype type;
    void *bytes;
    size_t length;
    timestamp_work parsed = {0};
    void *binding_data;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, &binding_data) != napi_ok || count != 6) {
        napi_throw_type_error(env, NULL, "setTimes requires exactly six arguments");
        return NULL;
    }
    timestamp_binding *binding = binding_data;
    napi_value constructor, predicate, result;
    if (napi_get_reference_value(env, binding->buffer_constructor, &constructor) != napi_ok
        || napi_get_reference_value(env, binding->is_buffer, &predicate) != napi_ok
        || napi_call_function(env, constructor, predicate, 1, arguments, &result) != napi_ok
        || napi_get_value_bool(env, result, &is_buffer) != napi_ok) return NULL;
    if (!is_buffer || napi_is_buffer(env, arguments[0], &is_buffer) != napi_ok || !is_buffer
        || napi_get_buffer_info(env, arguments[0], &bytes, &length) != napi_ok) {
        napi_throw_type_error(env, NULL, "Timestamp path must be a Buffer");
        return NULL;
    }
    if (length == SIZE_MAX || (length != 0 && memchr(bytes, 0, length) != NULL)) {
        napi_throw_type_error(env, NULL, "Timestamp path contains NUL or exceeds capacity");
        return NULL;
    }
    if (!read_time(env, arguments[1], arguments[2], &parsed.times[0])
        || !read_time(env, arguments[3], arguments[4], &parsed.times[1])) return NULL;
    if (napi_typeof(env, arguments[5], &type) != napi_ok || type != napi_boolean
        || napi_get_value_bool(env, arguments[5], &follow) != napi_ok) {
        napi_throw_type_error(env, NULL, "followSymlinks must be a boolean");
        return NULL;
    }
    timestamp_work *operation = calloc(1, sizeof(*operation));
    if (operation == NULL) {
        napi_throw_error(env, NULL, "Unable to allocate timestamp work");
        return NULL;
    }
    *operation = parsed;
    operation->path = malloc(length + 1);
    if (operation->path == NULL) {
        free(operation);
        napi_throw_error(env, NULL, "Unable to allocate timestamp path");
        return NULL;
    }
    if (length != 0) memcpy(operation->path, bytes, length);
    operation->path[length] = 0;
    operation->flags = follow ? 0 : AT_SYMLINK_NOFOLLOW;
    napi_value promise, resource_name;
    if (napi_create_string_utf8(env, "posix:setTimes", NAPI_AUTO_LENGTH, &resource_name) != napi_ok
        || napi_create_promise(env, &operation->deferred, &promise) != napi_ok
        || napi_create_async_work(env, NULL, resource_name, execute, complete, operation,
            &operation->work) != napi_ok
        || napi_queue_async_work(env, operation->work) != napi_ok) {
        if (operation->work != NULL) napi_delete_async_work(env, operation->work);
        free(operation->path);
        free(operation);
        napi_throw_error(env, NULL, "Unable to queue timestamp work");
        return NULL;
    }
    return promise;
}

static napi_value initialize(napi_env env, napi_value exports) {
    timestamp_binding *binding = calloc(1, sizeof(*binding));
    if (binding == NULL) {
        napi_throw_error(env, NULL, "Cannot allocate timestamp binding");
        return NULL;
    }
    napi_value global, constructor, predicate, function;
    if (napi_get_global(env, &global) != napi_ok
        || napi_get_named_property(env, global, "Buffer", &constructor) != napi_ok
        || napi_get_named_property(env, constructor, "isBuffer", &predicate) != napi_ok
        || napi_create_reference(env, constructor, 1, &binding->buffer_constructor) != napi_ok
        || napi_create_reference(env, predicate, 1, &binding->is_buffer) != napi_ok
        || napi_create_function(env, "setTimes", NAPI_AUTO_LENGTH, set_times, binding, &function) != napi_ok) {
        release_binding(env, binding, NULL);
        napi_throw_error(env, NULL, "Cannot initialize timestamp binding");
        return NULL;
    }
    if (napi_add_finalizer(env, function, binding, release_binding, NULL, NULL) != napi_ok) {
        release_binding(env, binding, NULL);
        napi_throw_error(env, NULL, "Cannot retain timestamp binding");
        return NULL;
    }
    // The function finalizer owns binding even if publishing the export fails.
    if (napi_set_named_property(env, exports, "setTimes", function) != napi_ok) {
        napi_throw_error(env, NULL, "Cannot export timestamp operation");
        return NULL;
    }
    return exports;
}

NAPI_MODULE(timestamps, initialize)
