/*
 * Windows byte-range locks are mandatory. Reserve a byte past the largest
 * expected file size so lock files and PID files remain readable while locked.
 */
#define NAPI_VERSION 8
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <string.h>

/* Node exports libuv's conversion from a Node descriptor to a Win32 handle. */
__declspec(dllimport) HANDLE uv_get_osfhandle(int fd);

#define LOCK_OFFSET_HIGH 0x7FFFFFFFu
#define LOCK_OFFSET_LOW 0xFFFFFFF0u

#define CHECK_NAPI(env, operation) do { \
    if ((operation) != napi_ok) { \
        napi_throw_error((env), NULL, "Node-API operation failed"); \
        return NULL; \
    } \
} while (0)

typedef struct { DWORD win32; int number; const char *code; } error_map;
static const error_map errors[] = {
    { ERROR_ACCESS_DENIED, EACCES, "EACCES" },
    { ERROR_INVALID_HANDLE, EBADF, "EBADF" },
    { ERROR_INVALID_PARAMETER, EINVAL, "EINVAL" },
    { ERROR_NOT_SUPPORTED, ENOSYS, "ENOSYS" },
    { ERROR_NOT_LOCKED, ENOLCK, "ENOLCK" },
};

static napi_value throw_win32(napi_env env, DWORD status) {
    int number = EIO;
    const char *code = "EIO";
    for (size_t index = 0; index < sizeof(errors) / sizeof(errors[0]); index++) {
        if (errors[index].win32 == status) {
            number = errors[index].number;
            code = errors[index].code;
            break;
        }
    }
    char text[256];
    DWORD length = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, status, MAKELANGID(LANG_ENGLISH, SUBLANG_DEFAULT), text, sizeof(text), NULL);
    while (length > 0 && (text[length - 1] == '\r' || text[length - 1] == '\n' || text[length - 1] == '.')) {
        text[--length] = 0;
    }
    if (length == 0) strcpy_s(text, sizeof(text), "Windows file lock operation failed");
    napi_value message, error, code_value, numeric;
    CHECK_NAPI(env, napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message));
    CHECK_NAPI(env, napi_create_error(env, NULL, message, &error));
    CHECK_NAPI(env, napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value));
    CHECK_NAPI(env, napi_create_int32(env, number, &numeric));
    CHECK_NAPI(env, napi_set_named_property(env, error, "code", code_value));
    CHECK_NAPI(env, napi_set_named_property(env, error, "errno", numeric));
    CHECK_NAPI(env, napi_throw(env, error));
    return NULL;
}

static int descriptor_handle(napi_env env, napi_callback_info info, HANDLE *handle) {
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
    *handle = uv_get_osfhandle((int)value);
    if (*handle == INVALID_HANDLE_VALUE || *handle == NULL) {
        throw_win32(env, ERROR_INVALID_HANDLE);
        return 0;
    }
    return 1;
}

static napi_value try_lock(napi_env env, napi_callback_info info) {
    HANDLE handle;
    napi_value result;
    if (!descriptor_handle(env, info, &handle)) return NULL;
    /* LockFile requests an exclusive lock and returns immediately on contention. */
    BOOL acquired = LockFile(handle, LOCK_OFFSET_LOW, LOCK_OFFSET_HIGH, 1, 0);
    if (!acquired) {
        DWORD status = GetLastError();
        if (status != ERROR_LOCK_VIOLATION) return throw_win32(env, status);
    }
    CHECK_NAPI(env, napi_get_boolean(env, acquired != FALSE, &result));
    return result;
}

static napi_value unlock(napi_env env, napi_callback_info info) {
    HANDLE handle;
    napi_value result;
    if (!descriptor_handle(env, info, &handle)) return NULL;
    if (!UnlockFile(handle, LOCK_OFFSET_LOW, LOCK_OFFSET_HIGH, 1, 0)) {
        DWORD status = GetLastError();
        if (status != ERROR_NOT_LOCKED) return throw_win32(env, status);
    }
    CHECK_NAPI(env, napi_get_undefined(env, &result));
    return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        { "tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL },
        { "unlock", NULL, unlock, NULL, NULL, NULL, napi_default, NULL },
    };
    CHECK_NAPI(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
    return exports;
}

NAPI_MODULE(flock, initialize)
