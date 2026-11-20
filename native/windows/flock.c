/*
 * Windows byte-range locks are mandatory. Reserve a byte past the largest
 * expected file size so lock files and PID files remain readable while locked.
 */
#define NAPI_VERSION 8
#define WIN32_LEAN_AND_MEAN
#define USING_UV_SHARED 1
#include <uv.h>
#include <aclapi.h>
#include <winternl.h>
#include <node_api.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* The user-mode SDK header declares NtCreateFile but omits this ntdll export. */
NTSYSAPI NTSTATUS NTAPI NtSetSecurityObject(HANDLE file, SECURITY_INFORMATION flags, PSECURITY_DESCRIPTOR security);

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
    { ERROR_FILE_NOT_FOUND, ENOENT, "ENOENT" },
    { ERROR_PATH_NOT_FOUND, ENOENT, "ENOENT" },
    { ERROR_INVALID_HANDLE, EBADF, "EBADF" },
    { ERROR_NOT_ENOUGH_MEMORY, ENOMEM, "ENOMEM" },
    { ERROR_INVALID_PARAMETER, EINVAL, "EINVAL" },
    { ERROR_NOT_SUPPORTED, ENOSYS, "ENOSYS" },
    { ERROR_NOT_LOCKED, ENOLCK, "ENOLCK" },
    { ERROR_INVALID_OWNER, EPERM, "EPERM" },
    { ERROR_FILENAME_EXCED_RANGE, ENAMETOOLONG, "ENAMETOOLONG" },
    { ERROR_TOO_MANY_OPEN_FILES, EMFILE, "EMFILE" },
    { ERROR_DIRECTORY, ENOTDIR, "ENOTDIR" },
    { ERROR_STOPPED_ON_SYMLINK, ELOOP, "ELOOP" },
    { ERROR_NO_UNICODE_TRANSLATION, EILSEQ, "EILSEQ" },
};

static napi_value throw_win32_at(napi_env env, DWORD status, const char *operation) {
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
    if (length == 0) strcpy_s(text, sizeof(text), "Windows filesystem operation failed");
    char description[320];
    snprintf(description, sizeof(description), "%s%s%s", operation ? operation : "", operation ? ": " : "", text);
    napi_value message, error, code_value, numeric;
    CHECK_NAPI(env, napi_create_string_utf8(env, description, NAPI_AUTO_LENGTH, &message));
    CHECK_NAPI(env, napi_create_error(env, NULL, message, &error));
    CHECK_NAPI(env, napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value));
    CHECK_NAPI(env, napi_create_int32(env, number, &numeric));
    CHECK_NAPI(env, napi_set_named_property(env, error, "code", code_value));
    CHECK_NAPI(env, napi_set_named_property(env, error, "errno", numeric));
    CHECK_NAPI(env, napi_throw(env, error));
    return NULL;
}

static napi_value throw_win32(napi_env env, DWORD status) {
    return throw_win32_at(env, status, NULL);
}

static BOOL get_descriptor(napi_env env, napi_value argument, HANDLE *handle) {
    napi_valuetype type;
    double value;
    if (napi_typeof(env, argument, &type) != napi_ok || type != napi_number
        || napi_get_value_double(env, argument, &value) != napi_ok) {
        napi_throw_type_error(env, NULL, "Descriptor must be a number");
        return FALSE;
    }
    if (!isfinite(value) || value < 0 || value > INT_MAX || floor(value) != value) {
        napi_throw_range_error(env, NULL, "descriptor must be a nonnegative C int");
        return FALSE;
    }
    *handle = uv_get_osfhandle((int)value);
    if (*handle == INVALID_HANDLE_VALUE || *handle == NULL) {
        throw_win32(env, ERROR_INVALID_HANDLE);
        return FALSE;
    }
    return TRUE;
}

static BOOL descriptor_handle(napi_env env, napi_callback_info info, HANDLE *handle) {
    size_t count = 2;
    napi_value arguments[2];
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 1) {
        napi_throw_type_error(env, NULL, "Operation requires exactly one descriptor");
        return FALSE;
    }
    return get_descriptor(env, arguments[0], handle);
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

static wchar_t *wide_string(napi_env env, napi_value argument, size_t limit, size_t *length) {
    napi_valuetype type;
    if (napi_typeof(env, argument, &type) != napi_ok || type != napi_string
        || napi_get_value_string_utf16(env, argument, NULL, 0, length) != napi_ok) {
        napi_throw_type_error(env, NULL, "Expected a path string");
        return NULL;
    }
    if (*length == 0 || *length > limit) {
        napi_throw_range_error(env, NULL, "Path length is invalid");
        return NULL;
    }
    wchar_t *value = calloc(*length + 1, sizeof(wchar_t));
    if (!value) {
        throw_win32(env, ERROR_NOT_ENOUGH_MEMORY);
        return NULL;
    }
    size_t written;
    if (napi_get_value_string_utf16(env, argument, (char16_t *)value, *length + 1, &written) != napi_ok
        || written != *length || wcslen(value) != *length) {
        free(value);
        napi_throw_type_error(env, NULL, "Path is invalid");
        return NULL;
    }
    return value;
}

static const DWORD file_sharing = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

static void *token_information(HANDLE token, TOKEN_INFORMATION_CLASS kind, DWORD *failure) {
    DWORD size = 0;
    if (!GetTokenInformation(token, kind, NULL, 0, &size) && GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        *failure = GetLastError();
        return NULL;
    }
    void *information = malloc(size);
    if (!information) {
        *failure = ERROR_NOT_ENOUGH_MEMORY;
        return NULL;
    }
    if (!GetTokenInformation(token, kind, information, size, &size)) {
        *failure = GetLastError();
        free(information);
        return NULL;
    }
    return information;
}

/* Reject allow entries for another SID even when they only apply to descendants. */
static BOOL owner_only_dacl(PACL acl, PSID user) {
    if (!acl) return FALSE;
    BOOL has_access = FALSE;
    for (DWORD index = 0; index < acl->AceCount; index++) {
        ACCESS_ALLOWED_ACE *ace;
        if (!GetAce(acl, index, (void **)&ace) || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE
            || !EqualSid((PSID)&ace->SidStart, user)) return FALSE;
        if (!(ace->Header.AceFlags & INHERIT_ONLY_ACE) && ace->Mask != 0) has_access = TRUE;
    }
    return has_access;
}

static DWORD set_owner_only_dacl(HANDLE file, PSID user, BOOL change_owner, BOOL directory) {
    EXPLICIT_ACCESS_W access = {0};
    access.grfAccessPermissions = FILE_ALL_ACCESS;
    access.grfAccessMode = SET_ACCESS;
    access.grfInheritance = directory ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_USER;
    access.Trustee.ptstrName = (LPWSTR)user;
    PACL acl = NULL;
    DWORD failure = SetEntriesInAclW(1, &access, NULL, &acl);
    if (failure == ERROR_SUCCESS) {
        SECURITY_DESCRIPTOR security;
        if (!InitializeSecurityDescriptor(&security, SECURITY_DESCRIPTOR_REVISION)
            || !SetSecurityDescriptorDacl(&security, TRUE, acl, FALSE)
            || !SetSecurityDescriptorControl(&security, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
            || (change_owner && !SetSecurityDescriptorOwner(&security, user, FALSE))) {
            failure = GetLastError();
        } else {
            /* Apply to the pinned object without propagating edits to existing children. */
            SECURITY_INFORMATION flags = DACL_SECURITY_INFORMATION;
            if (change_owner) flags |= OWNER_SECURITY_INFORMATION;
            NTSTATUS status = NtSetSecurityObject(file, flags, &security);
            if (status < 0) failure = RtlNtStatusToDosError(status);
        }
    }
    if (acl) LocalFree(acl);
    return failure;
}

static napi_value owner_acl(napi_env env, napi_callback_info info, BOOL restrict_owner) {
    size_t count = 2, length;
    napi_value arguments[2], result;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 1) {
        napi_throw_type_error(env, NULL, "ACL operation requires exactly one path");
        return NULL;
    }
    wchar_t *path = wide_string(env, arguments[0], 32767, &length);
    if (!path) return NULL;
    HANDLE file = CreateFileW(path, restrict_owner ? MAXIMUM_ALLOWED : READ_CONTROL | FILE_READ_ATTRIBUTES,
        file_sharing, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
    DWORD failure = file == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    free(path);
    if (failure != ERROR_SUCCESS) return throw_win32_at(env, failure, "Open ACL path");

    FILE_ATTRIBUTE_TAG_INFO metadata;
    HANDLE token = NULL;
    TOKEN_USER *user = NULL;
    TOKEN_OWNER *default_owner = NULL;
    PSECURITY_DESCRIPTOR security = NULL;
    PSID owner = NULL;
    PACL acl = NULL;
    BOOL valid = FALSE;
    if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &metadata, sizeof(metadata))) {
        failure = GetLastError();
        goto cleanup;
    }
    if (metadata.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
        failure = ERROR_STOPPED_ON_SYMLINK;
        goto cleanup;
    }
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        failure = GetLastError();
        goto cleanup;
    }
    user = token_information(token, TokenUser, &failure);
    if (!user) goto cleanup;
    failure = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &acl, NULL, &security);
    if (failure != ERROR_SUCCESS) goto cleanup;
    if (!owner || !IsValidSid(owner)) {
        failure = ERROR_INVALID_OWNER;
        goto cleanup;
    }
    BOOL owned = EqualSid(owner, user->User.Sid);
    if (!restrict_owner) {
        valid = owned && owner_only_dacl(acl, user->User.Sid);
        goto cleanup;
    }
    if (!owned) {
        /* Elevated processes may create objects owned by the token's default group. */
        default_owner = token_information(token, TokenOwner, &failure);
        if (!default_owner) goto cleanup;
        if (!EqualSid(owner, default_owner->Owner)) {
            failure = ERROR_INVALID_OWNER;
            goto cleanup;
        }
    }
    failure = set_owner_only_dacl(file, user->User.Sid, !owned, (metadata.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0);

cleanup:
    if (security) LocalFree(security);
    free(default_owner);
    free(user);
    if (token) CloseHandle(token);
    CloseHandle(file);
    if (failure != ERROR_SUCCESS) {
        return throw_win32_at(env, failure, restrict_owner ? "Set owner-only ACL" : "Inspect owner ACL");
    }
    CHECK_NAPI(env, restrict_owner ? napi_get_undefined(env, &result) : napi_get_boolean(env, valid != FALSE, &result));
    return result;
}

static napi_value restrict_to_owner(napi_env env, napi_callback_info info) {
    return owner_acl(env, info, TRUE);
}

static napi_value is_owner_only(napi_env env, napi_callback_info info) {
    return owner_acl(env, info, FALSE);
}

static BOOL check_directory(napi_env env, HANDLE directory) {
    FILE_ATTRIBUTE_TAG_INFO metadata;
    if (!GetFileInformationByHandleEx(directory, FileAttributeTagInfo, &metadata, sizeof(metadata))) {
        throw_win32(env, GetLastError());
        return FALSE;
    }
    if (!(metadata.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (metadata.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        throw_win32(env, ERROR_DIRECTORY);
        return FALSE;
    }
    return TRUE;
}

/* Open an exact basename relative to the directory handle. Preserve the final reparse
 * point for inspection and never reopen the directory by its path. */
static HANDLE open_entry_handle(napi_env env, napi_callback_info info, ACCESS_MASK access) {
    size_t count = 3, length;
    napi_value arguments[3];
    HANDLE directory, entry;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 2) {
        napi_throw_type_error(env, NULL, "Directory operation requires a descriptor and basename");
        return INVALID_HANDLE_VALUE;
    }
    if (!get_descriptor(env, arguments[0], &directory) || !check_directory(env, directory)) return INVALID_HANDLE_VALUE;
    wchar_t *name = wide_string(env, arguments[1], 255, &length);
    if (!name) return INVALID_HANDLE_VALUE;
    if (wcspbrk(name, L"\\/:") || wcscmp(name, L".") == 0 || wcscmp(name, L"..") == 0) {
        free(name);
        napi_throw_type_error(env, NULL, "Directory basename is invalid");
        return INVALID_HANDLE_VALUE;
    }
    UNICODE_STRING basename;
    basename.Length = (USHORT)(length * sizeof(wchar_t));
    basename.MaximumLength = (USHORT)((length + 1) * sizeof(wchar_t));
    basename.Buffer = name;
    OBJECT_ATTRIBUTES attributes;
    InitializeObjectAttributes(&attributes, &basename, OBJ_CASE_INSENSITIVE, directory, NULL);
    IO_STATUS_BLOCK io;
    NTSTATUS status = NtCreateFile(&entry, access | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attributes,
        &io, NULL, 0, file_sharing, FILE_OPEN, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
    free(name);
    if (status < 0) {
        throw_win32(env, RtlNtStatusToDosError(status));
        return INVALID_HANDLE_VALUE;
    }
    return entry;
}

static napi_value scan_names(napi_env env, HANDLE scan) {
    napi_value result;
    CHECK_NAPI(env, napi_create_array(env, &result));
    const DWORD capacity = 64 * 1024;
    unsigned char *buffer = malloc(capacity);
    if (!buffer) return throw_win32(env, ERROR_NOT_ENOUGH_MEMORY);
    uint32_t index = 0;
    FILE_INFO_BY_HANDLE_CLASS kind = FileFullDirectoryRestartInfo;
    for (;;) {
        if (!GetFileInformationByHandleEx(scan, kind, buffer, capacity)) {
            DWORD failure = GetLastError();
            free(buffer);
            if (failure == ERROR_NO_MORE_FILES) return result;
            return throw_win32_at(env, failure, "Read directory entries");
        }
        kind = FileFullDirectoryInfo;
        for (FILE_FULL_DIR_INFO *entry = (FILE_FULL_DIR_INFO *)buffer;;
             entry = (FILE_FULL_DIR_INFO *)((unsigned char *)entry + entry->NextEntryOffset)) {
            int length = (int)(entry->FileNameLength / sizeof(wchar_t));
            BOOL dot = (length == 1 && entry->FileName[0] == L'.')
                || (length == 2 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.');
            if (!dot) {
                char utf8[4 * 255];
                int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, entry->FileName, length,
                    utf8, sizeof(utf8), NULL, NULL);
                if (bytes == 0) {
                    DWORD failure = GetLastError();
                    free(buffer);
                    return throw_win32(env, failure);
                }
                napi_value name;
                if (napi_create_buffer_copy(env, (size_t)bytes, utf8, NULL, &name) != napi_ok
                    || napi_set_element(env, result, index++, name) != napi_ok) {
                    free(buffer);
                    napi_throw_error(env, NULL, "Cannot create directory listing");
                    return NULL;
                }
            }
            if (entry->NextEntryOffset == 0) break;
        }
    }
}

static napi_value list_names(napi_env env, napi_callback_info info) {
    HANDLE directory;
    if (!descriptor_handle(env, info, &directory) || !check_directory(env, directory)) return NULL;
    BY_HANDLE_FILE_INFORMATION metadata;
    if (!GetFileInformationByHandle(directory, &metadata)) return throw_win32_at(env, GetLastError(), "Read directory identity");
    FILE_ID_DESCRIPTOR identity = {0};
    identity.dwSize = sizeof(identity);
    identity.Type = FileIdType;
    identity.FileId.LowPart = metadata.nFileIndexLow;
    identity.FileId.HighPart = (LONG)metadata.nFileIndexHigh;
    /* Open the same object with a fresh scan cursor, even if its name changed. */
    HANDLE scan = OpenFileById(directory, &identity, FILE_GENERIC_READ, file_sharing, NULL,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    if (scan == INVALID_HANDLE_VALUE) return throw_win32_at(env, GetLastError(), "Open independent directory scan");
    napi_value result = check_directory(env, scan) ? scan_names(env, scan) : NULL;
    CloseHandle(scan);
    return result;
}

static napi_value inspect_entry(napi_env env, napi_callback_info info) {
    HANDLE file = open_entry_handle(env, info, 0);
    if (file == INVALID_HANDLE_VALUE) return NULL;
    BY_HANDLE_FILE_INFORMATION metadata;
    BOOL read = GetFileInformationByHandle(file, &metadata);
    DWORD failure = read ? ERROR_SUCCESS : GetLastError();
    CloseHandle(file);
    if (failure != ERROR_SUCCESS) return throw_win32(env, failure);
    /* Mode carries POSIX type bits. Windows permissions are checked through the ACL. */
    uint32_t mode = (metadata.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? 0120000u
        : (metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 0040000u : 0100000u;
    napi_value result, value;
    CHECK_NAPI(env, napi_create_object(env, &result));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, metadata.dwVolumeSerialNumber, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "dev", value));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, ((uint64_t)metadata.nFileIndexHigh << 32) | metadata.nFileIndexLow, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "ino", value));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, ((uint64_t)metadata.nFileSizeHigh << 32) | metadata.nFileSizeLow, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "size", value));
    CHECK_NAPI(env, napi_create_uint32(env, mode, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "mode", value));
    return result;
}

static napi_value open_entry(napi_env env, napi_callback_info info) {
    HANDLE file = open_entry_handle(env, info, FILE_READ_DATA);
    if (file == INVALID_HANDLE_VALUE) return NULL;
    FILE_ATTRIBUTE_TAG_INFO metadata;
    DWORD failure = ERROR_SUCCESS;
    if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &metadata, sizeof(metadata))) failure = GetLastError();
    else if (metadata.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) failure = ERROR_STOPPED_ON_SYMLINK;
    else if (metadata.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) failure = ERROR_DIRECTORY;
    if (failure != ERROR_SUCCESS) {
        CloseHandle(file);
        return throw_win32(env, failure);
    }
    int descriptor = uv_open_osfhandle(file);
    if (descriptor < 0) {
        CloseHandle(file);
        return throw_win32(env, ERROR_TOO_MANY_OPEN_FILES);
    }
    napi_value result;
    if (napi_create_int32(env, descriptor, &result) != napi_ok) {
        uv_fs_t request;
        uv_fs_close(NULL, &request, descriptor, NULL);
        uv_fs_req_cleanup(&request);
        napi_throw_error(env, NULL, "Cannot return opened descriptor");
        return NULL;
    }
    return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        { "tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL },
        { "unlock", NULL, unlock, NULL, NULL, NULL, napi_default, NULL },
        { "restrictToOwner", NULL, restrict_to_owner, NULL, NULL, NULL, napi_default, NULL },
        { "isOwnerOnly", NULL, is_owner_only, NULL, NULL, NULL, napi_default, NULL },
        { "listNames", NULL, list_names, NULL, NULL, NULL, napi_default, NULL },
        { "inspect", NULL, inspect_entry, NULL, NULL, NULL, napi_default, NULL },
        { "openFile", NULL, open_entry, NULL, NULL, NULL, napi_default, NULL },
    };
    CHECK_NAPI(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
    return exports;
}

NAPI_MODULE(flock, initialize)
