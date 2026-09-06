#define NAPI_VERSION 8
#include <node_api.h>
#include <sys/file.h>
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

static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        { "tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL },
        { "unlock", NULL, unlock, NULL, NULL, NULL, napi_default, NULL },
    };
    CHECK_NAPI(env, napi_define_properties(env, exports, 2, properties));
    return exports;
}

NAPI_MODULE(flock, initialize)
