"""Root-only normalization of structured results from cloned Stores."""


def normalize_store_result(value, root):
    """Replace an exact Store path prefix before repr/JSON escaping occurs."""
    root_text = str(root)
    if isinstance(value, str):
        if value == root_text or any(
            value.startswith(root_text + separator) for separator in ("/", "\\")
        ):
            return "<STORE_ROOT>" + value[len(root_text):]
        return value
    if isinstance(value, dict):
        return {key: normalize_store_result(item, root) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_store_result(item, root) for item in value]
    if isinstance(value, tuple):
        return tuple(normalize_store_result(item, root) for item in value)
    return value
