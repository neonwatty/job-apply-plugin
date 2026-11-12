/*
 * Native Windows counterpart of native/posix/flock.c.
 *
 * tryLock/unlock keep the POSIX contract (advisory, exclusive, non-blocking, released
 * when the descriptor closes or the process exits) using LockFileEx on one byte far
 * beyond any real file size. Windows byte-range locks are mandatory, so locking real
 * content would block other readers of lock and PID files; the sentinel byte does not.
 *
 * listNames/inspect/openFile resolve entries against a caller-pinned directory descriptor.
 *
 * restrictToOwner/isOwnerOnly provide the Windows equivalent of chmod 0700/0600 and the
 * Store's "private and owned" check: a protected DACL whose only allow entries are for the
 * current user, inherited by every object later created inside the directory.
 */
#define NAPI_VERSION 8
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Exported by node.exe (libuv); maps a Node file descriptor to its Win32 HANDLE. */
__declspec(dllimport) HANDLE uv_get_osfhandle(int fd);

#define SENTINEL_OFFSET_HIGH 0x7FFFFFFFu
#define SENTINEL_OFFSET_LOW 0xFFFFFFF0u

#define CHECK_NAPI(env, operation) do { \
    if ((operation) != napi_ok) { \
        napi_throw_error((env), NULL, "Node-API operation failed"); \
        return NULL; \
    } \
} while (0)

typedef struct { DWORD win32; int number; const char *code; } error_map;
static const error_map errors[] = {
    { ERROR_FILE_NOT_FOUND, ENOENT, "ENOENT" }, { ERROR_PATH_NOT_FOUND, ENOENT, "ENOENT" },
    { ERROR_ACCESS_DENIED, EACCES, "EACCES" }, { ERROR_INVALID_HANDLE, EBADF, "EBADF" },
    { ERROR_NOT_ENOUGH_MEMORY, ENOMEM, "ENOMEM" }, { ERROR_OUTOFMEMORY, ENOMEM, "ENOMEM" },
    { ERROR_INVALID_PARAMETER, EINVAL, "EINVAL" }, { ERROR_FILENAME_EXCED_RANGE, ENAMETOOLONG, "ENAMETOOLONG" },
    { ERROR_NOT_SUPPORTED, ENOSYS, "ENOSYS" }, { ERROR_PRIVILEGE_NOT_HELD, EPERM, "EPERM" },
    { ERROR_SHARING_VIOLATION, EACCES, "EACCES" }, { ERROR_LOCK_VIOLATION, EAGAIN, "EAGAIN" },
    { ERROR_WRITE_PROTECT, EACCES, "EACCES" }, { ERROR_NOT_LOCKED, ENOLCK, "ENOLCK" },
};

static napi_value throw_win32(napi_env env, DWORD code) {
    int number = EIO;
    const char *name = "EIO";
    for (size_t index = 0; index < sizeof(errors) / sizeof(errors[0]); index++) {
        if (errors[index].win32 == code) { number = errors[index].number; name = errors[index].code; break; }
    }
    char text[256];
    DWORD length = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code,
        MAKELANGID(LANG_ENGLISH, SUBLANG_DEFAULT), text, sizeof(text), NULL);
    while (length > 0 && (text[length - 1] == '\r' || text[length - 1] == '\n' || text[length - 1] == '.')) text[--length] = 0;
    if (length == 0) strcpy_s(text, sizeof(text), "Windows operation failed");
    napi_value message, error, code_value, numeric;
    CHECK_NAPI(env, napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message));
    CHECK_NAPI(env, napi_create_error(env, NULL, message, &error));
    CHECK_NAPI(env, napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &code_value));
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
    if (*handle == INVALID_HANDLE_VALUE || *handle == NULL) { throw_win32(env, ERROR_INVALID_HANDLE); return 0; }
    return 1;
}

static napi_value try_lock(napi_env env, napi_callback_info info) {
    HANDLE handle;
    napi_value result;
    if (!descriptor_handle(env, info, &handle)) return NULL;
    OVERLAPPED overlapped = {0};
    overlapped.Offset = SENTINEL_OFFSET_LOW;
    overlapped.OffsetHigh = SENTINEL_OFFSET_HIGH;
    if (LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)) {
        CHECK_NAPI(env, napi_get_boolean(env, 1, &result));
        return result;
    }
    DWORD code = GetLastError();
    /* flock(LOCK_NB) reports "held elsewhere" as false; so do these. A second lock on the
     * same handle also fails here, matching a second flock through another descriptor. */
    if (code == ERROR_LOCK_VIOLATION || code == ERROR_IO_PENDING) {
        CHECK_NAPI(env, napi_get_boolean(env, 0, &result));
        return result;
    }
    return throw_win32(env, code);
}

static napi_value unlock(napi_env env, napi_callback_info info) {
    HANDLE handle;
    napi_value result;
    if (!descriptor_handle(env, info, &handle)) return NULL;
    OVERLAPPED overlapped = {0};
    overlapped.Offset = SENTINEL_OFFSET_LOW;
    overlapped.OffsetHigh = SENTINEL_OFFSET_HIGH;
    /* flock(LOCK_UN) succeeds when nothing is held; keep that contract. */
    if (!UnlockFileEx(handle, 0, 1, 0, &overlapped) && GetLastError() != ERROR_NOT_LOCKED) {
        return throw_win32(env, GetLastError());
    }
    CHECK_NAPI(env, napi_get_undefined(env, &result));
    return result;
}

/* Read one UTF-8 string argument as a NUL-free wide path. Caller frees. */
static wchar_t *path_argument(napi_env env, napi_callback_info info) {
    size_t count = 2, length = 0;
    napi_value arguments[2];
    napi_valuetype type;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 1
        || napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_string
        || napi_get_value_string_utf16(env, arguments[0], NULL, 0, &length) != napi_ok) {
        napi_throw_type_error(env, NULL, "ACL operation requires exactly one path string");
        return NULL;
    }
    if (length == 0 || length > 32767) { napi_throw_range_error(env, NULL, "ACL path length is invalid"); return NULL; }
    wchar_t *path = calloc(length + 1, sizeof(wchar_t));
    if (!path) { throw_win32(env, ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    size_t written;
    if (napi_get_value_string_utf16(env, arguments[0], (char16_t *)path, length + 1, &written) != napi_ok
        || written != length || wcslen(path) != length) {
        free(path);
        napi_throw_type_error(env, NULL, "ACL path is invalid");
        return NULL;
    }
    return path;
}

/* The current process token's user SID. Caller frees. */
static PSID current_user(DWORD *failure) {
    HANDLE token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { *failure = GetLastError(); return NULL; }
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    TOKEN_USER *user = size ? malloc(size) : NULL;
    PSID copy = NULL;
    if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)) {
        *failure = user ? GetLastError() : ERROR_NOT_ENOUGH_MEMORY;
    } else {
        DWORD length = GetLengthSid(user->User.Sid);
        copy = malloc(length);
        if (!copy || !CopySid(length, copy, user->User.Sid)) {
            *failure = copy ? GetLastError() : ERROR_NOT_ENOUGH_MEMORY;
            free(copy); copy = NULL;
        }
    }
    free(user);
    CloseHandle(token);
    return copy;
}

static napi_value restrict_to_owner(napi_env env, napi_callback_info info) {
    wchar_t *path = path_argument(env, info);
    if (!path) return NULL;
    DWORD failure = ERROR_SUCCESS;
    PSID user = current_user(&failure);
    PACL acl = NULL;
    if (user) {
        EXPLICIT_ACCESS_W access = {0};
        access.grfAccessPermissions = GENERIC_ALL;
        access.grfAccessMode = SET_ACCESS;
        access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_USER;
        access.Trustee.ptstrName = (LPWSTR)user;
        failure = SetEntriesInAclW(1, &access, NULL, &acl);
        if (failure == ERROR_SUCCESS) {
            /* PROTECTED drops inherited entries (Administrators, SYSTEM, other users). */
            failure = SetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
        }
    }
    if (acl) LocalFree(acl);
    free(user);
    free(path);
    if (failure != ERROR_SUCCESS) return throw_win32(env, failure);
    napi_value result;
    CHECK_NAPI(env, napi_get_undefined(env, &result));
    return result;
}

/* The token's default owner for new objects. For an elevated administrator this is the
 * Administrators group rather than the user. Caller frees. */
static PSID default_owner(void) {
    HANDLE token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
    DWORD size = 0;
    GetTokenInformation(token, TokenOwner, NULL, 0, &size);
    TOKEN_OWNER *owner = size ? malloc(size) : NULL;
    PSID copy = NULL;
    if (owner && GetTokenInformation(token, TokenOwner, owner, size, &size)) {
        DWORD length = GetLengthSid(owner->Owner);
        copy = malloc(length);
        if (copy && !CopySid(length, copy, owner->Owner)) { free(copy); copy = NULL; }
    }
    free(owner);
    CloseHandle(token);
    return copy;
}

/*
 * True when every allow entry names only the current user and the owner is that user or
 * the token's default owner (objects an elevated process creates are owned by Administrators).
 */
static napi_value is_owner_only(napi_env env, napi_callback_info info) {
    wchar_t *path = path_argument(env, info);
    if (!path) return NULL;
    DWORD failure = ERROR_SUCCESS;
    PSID user = current_user(&failure), owner = NULL, creator = default_owner();
    PACL acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    BOOL owner_only = FALSE;
    if (user) {
        failure = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &owner, NULL, &acl, NULL, &descriptor);
    }
    if (failure == ERROR_SUCCESS && owner && acl && (EqualSid(owner, user) || (creator && EqualSid(owner, creator)))) {
        owner_only = TRUE;
        for (DWORD index = 0; owner_only && index < acl->AceCount; index++) {
            ACE_HEADER *header;
            if (!GetAce(acl, index, (LPVOID *)&header)) { owner_only = FALSE; break; }
            if (header->AceFlags & INHERIT_ONLY_ACE) continue;
            if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
                owner_only = EqualSid((PSID)&((ACCESS_ALLOWED_ACE *)header)->SidStart, user);
            } else if (header->AceType != ACCESS_DENIED_ACE_TYPE) {
                owner_only = FALSE; /* callback/object/compound entries are not expected here */
            }
        }
    }
    if (descriptor) LocalFree(descriptor);
    free(user);
    free(creator);
    free(path);
    if (failure != ERROR_SUCCESS) return throw_win32(env, failure);
    napi_value result;
    CHECK_NAPI(env, napi_get_boolean(env, owner_only, &result));
    return result;
}

/*
 * Directory-descriptor helpers matching the POSIX listNames/inspect/openFile contract.
 * Win32 has no openat, so entries resolve against the pinned handle's current final path.
 * Names that could leave the directory or address an NTFS stream are refused.
 */
__declspec(dllimport) int uv_open_osfhandle(HANDLE handle);

/* Read (descriptor, basename) and build "<final path of descriptor>\<basename>". Caller frees. */
static wchar_t *entry_path(napi_env env, napi_callback_info info) {
    size_t count = 3, length = 0, written;
    napi_value arguments[3];
    napi_valuetype type;
    double value;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 2
        || napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_number
        || napi_get_value_double(env, arguments[0], &value) != napi_ok
        || !isfinite(value) || value < 0 || value > INT_MAX || floor(value) != value
        || napi_typeof(env, arguments[1], &type) != napi_ok || type != napi_string
        || napi_get_value_string_utf16(env, arguments[1], NULL, 0, &length) != napi_ok) {
        napi_throw_type_error(env, NULL, "directory operation requires descriptor and basename");
        return NULL;
    }
    if (length == 0 || length > 255) { napi_throw_range_error(env, NULL, "directory basename length is invalid"); return NULL; }
    HANDLE directory = uv_get_osfhandle((int)value);
    if (directory == INVALID_HANDLE_VALUE || directory == NULL) { throw_win32(env, ERROR_INVALID_HANDLE); return NULL; }
    DWORD prefix = GetFinalPathNameByHandleW(directory, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (prefix == 0) { throw_win32(env, GetLastError()); return NULL; }
    wchar_t *path = calloc((size_t)prefix + 1 + length + 1, sizeof(wchar_t));
    if (!path) { throw_win32(env, ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    DWORD used = GetFinalPathNameByHandleW(directory, path, prefix, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (used == 0 || used >= prefix) { free(path); throw_win32(env, used ? ERROR_INVALID_PARAMETER : GetLastError()); return NULL; }
    path[used++] = L'\\';
    if (napi_get_value_string_utf16(env, arguments[1], (char16_t *)(path + used), length + 1, &written) != napi_ok
        || written != length || wcslen(path + used) != length || wcspbrk(path + used, L"\\/:") != NULL
        || wcscmp(path + used, L".") == 0 || wcscmp(path + used, L"..") == 0) {
        free(path);
        napi_throw_type_error(env, NULL, "directory basename is invalid");
        return NULL;
    }
    return path;
}

/* Open an entry without following a final symlink or junction. */
static HANDLE open_entry_handle(const wchar_t *path, DWORD access) {
    return CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
}

static napi_value list_names(napi_env env, napi_callback_info info) {
    HANDLE directory;
    napi_value result;
    if (!descriptor_handle(env, info, &directory)) return NULL;
    CHECK_NAPI(env, napi_create_array(env, &result));
    const DWORD capacity = 64 * 1024;
    unsigned char *buffer = malloc(capacity);
    if (!buffer) return throw_win32(env, ERROR_NOT_ENOUGH_MEMORY);
    uint32_t index = 0;
    FILE_INFO_BY_HANDLE_CLASS kind = FileFullDirectoryRestartInfo;
    for (;;) {
        if (!GetFileInformationByHandleEx(directory, kind, buffer, capacity)) {
            DWORD code = GetLastError();
            free(buffer);
            if (code == ERROR_NO_MORE_FILES) return result;
            return throw_win32(env, code);
        }
        kind = FileFullDirectoryInfo;
        for (FILE_FULL_DIR_INFO *entry = (FILE_FULL_DIR_INFO *)buffer;;
             entry = (FILE_FULL_DIR_INFO *)((unsigned char *)entry + entry->NextEntryOffset)) {
            int characters = (int)(entry->FileNameLength / sizeof(wchar_t));
            BOOL dot = (characters == 1 && entry->FileName[0] == L'.')
                || (characters == 2 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.');
            if (!dot) {
                int bytes = WideCharToMultiByte(CP_UTF8, 0, entry->FileName, characters, NULL, 0, NULL, NULL);
                char *name = bytes > 0 ? malloc((size_t)bytes) : NULL;
                napi_value value;
                if (!name || WideCharToMultiByte(CP_UTF8, 0, entry->FileName, characters, name, bytes, NULL, NULL) != bytes
                    || napi_create_buffer_copy(env, (size_t)bytes, name, NULL, &value) != napi_ok
                    || napi_set_element(env, result, index++, value) != napi_ok) {
                    free(name); free(buffer);
                    napi_throw_error(env, NULL, "Cannot create directory listing");
                    return NULL;
                }
                free(name);
            }
            if (entry->NextEntryOffset == 0) break;
        }
    }
}

static napi_value inspect_entry(napi_env env, napi_callback_info info) {
    wchar_t *path = entry_path(env, info);
    if (!path) return NULL;
    HANDLE handle = open_entry_handle(path, FILE_READ_ATTRIBUTES);
    free(path);
    if (handle == INVALID_HANDLE_VALUE) return throw_win32(env, GetLastError());
    BY_HANDLE_FILE_INFORMATION metadata;
    BOOL ok = GetFileInformationByHandle(handle, &metadata);
    DWORD code = GetLastError();
    CloseHandle(handle);
    if (!ok) return throw_win32(env, code);
    /* POSIX S_IF* type bits with the private mode every Store entry inherits. */
    uint32_t mode = (metadata.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? 0120000u
        : (metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 0040700u : 0100600u;
    napi_value result, value;
    CHECK_NAPI(env, napi_create_object(env, &result));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, metadata.dwVolumeSerialNumber, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "dev", value));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, ((uint64_t)metadata.nFileIndexHigh << 32) | metadata.nFileIndexLow, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "ino", value));
    CHECK_NAPI(env, napi_create_bigint_int64(env, (int64_t)(((uint64_t)metadata.nFileSizeHigh << 32) | metadata.nFileSizeLow), &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "size", value));
    CHECK_NAPI(env, napi_create_uint32(env, mode, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "mode", value));
    return result;
}

static napi_value open_entry(napi_env env, napi_callback_info info) {
    wchar_t *path = entry_path(env, info);
    if (!path) return NULL;
    HANDLE handle = open_entry_handle(path, GENERIC_READ);
    free(path);
    if (handle == INVALID_HANDLE_VALUE) return throw_win32(env, GetLastError());
    int descriptor = uv_open_osfhandle(handle);
    if (descriptor < 0) { CloseHandle(handle); return throw_win32(env, ERROR_TOO_MANY_OPEN_FILES); }
    napi_value result;
    if (napi_create_int32(env, descriptor, &result) != napi_ok) {
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
        { "restrictToOwner", NULL, restrict_to_owner, NULL, NULL, NULL, napi_default, NULL },
        { "isOwnerOnly", NULL, is_owner_only, NULL, NULL, NULL, napi_default, NULL },
    };
    CHECK_NAPI(env, napi_define_properties(env, exports, 7, properties));
    return exports;
}

NAPI_MODULE(flock, initialize)
