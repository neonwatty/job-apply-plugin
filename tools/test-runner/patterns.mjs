export function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

const REGEX_CACHE = new Map();

export function globRegex(pattern) {
  const source = normalizePath(pattern);
  if (REGEX_CACHE.has(source)) return REGEX_CACHE.get(source);
  let result = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*") {
      if (source[index + 1] === "*") {
        index += 1;
        if (source[index + 1] === "/") {
          index += 1;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`${result}$`);
  REGEX_CACHE.set(source, compiled);
  return compiled;
}

export function matches(path, patterns = []) {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => globRegex(pattern).test(normalized));
}

export function expandPatterns(paths, include, exclude = []) {
  return paths.filter((path) => matches(path, include) && !matches(path, exclude));
}
