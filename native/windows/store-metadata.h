/* Store metadata comes from one handle, so ACLs and file identity describe the same entry. */
static napi_value store_metadata(napi_env env, napi_callback_info info) {
    size_t count = 2, length;
    napi_value arguments[2], result, value;
    napi_valuetype type;
    if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != 1
        || napi_typeof(env, arguments[0], &type) != napi_ok) {
        napi_throw_type_error(env, NULL, "Store metadata requires a path or descriptor");
        return NULL;
    }
    HANDLE file;
    BOOL opened = type == napi_string;
    if (opened) {
        wchar_t *path = wide_string(env, arguments[0], 32767, &length);
        if (!path) return NULL;
        file = CreateFileW(path, FILE_READ_ATTRIBUTES | READ_CONTROL, file_sharing, NULL, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
        DWORD failure = file == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
        free(path);
        if (failure != ERROR_SUCCESS) return throw_win32(env, failure);
    } else if (!get_descriptor(env, arguments[0], &file)) {
        return NULL;
    }

    DWORD failure = ERROR_SUCCESS;
    FILE_ID_INFO identity;
    BY_HANDLE_FILE_INFORMATION attributes;
    HANDLE token = NULL;
    TOKEN_USER *user = NULL;
    PSECURITY_DESCRIPTOR security = NULL;
    PSID owner = NULL;
    PACL acl = NULL;
    BOOL private = FALSE;
    if (GetFileType(file) != FILE_TYPE_DISK) failure = ERROR_INVALID_PARAMETER;
    else if (!GetFileInformationByHandle(file, &attributes)) failure = GetLastError();
    else if (attributes.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) failure = ERROR_STOPPED_ON_SYMLINK;
    else if (!GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity))) failure = GetLastError();
    else if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) failure = GetLastError();
    else if ((user = token_information(token, TokenUser, &failure)) != NULL) {
        failure = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &owner, NULL, &acl, NULL, &security);
        if (failure == ERROR_SUCCESS) private = owner && IsValidSid(owner)
            && EqualSid(owner, user->User.Sid) && owner_only_dacl(acl, user->User.Sid);
    }
    if (security) LocalFree(security);
    free(user);
    if (token) CloseHandle(token);
    if (opened) CloseHandle(file);
    if (failure != ERROR_SUCCESS) return throw_win32_at(env, failure, "Inspect Store metadata");

    CHECK_NAPI(env, napi_create_object(env, &result));
    CHECK_NAPI(env, napi_create_buffer_copy(env, sizeof(identity.FileId.Identifier), identity.FileId.Identifier, NULL, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "id", value));
    CHECK_NAPI(env, napi_create_bigint_uint64(env, identity.VolumeSerialNumber, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "volume", value));
    CHECK_NAPI(env, napi_create_uint32(env, attributes.nNumberOfLinks, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "links", value));
    CHECK_NAPI(env, napi_get_boolean(env, (attributes.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "directory", value));
    CHECK_NAPI(env, napi_get_boolean(env, private != FALSE, &value));
    CHECK_NAPI(env, napi_set_named_property(env, result, "private", value));
    return result;
}
