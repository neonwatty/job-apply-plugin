"""Fixed synthetic typed JSON oracle, without caller-selected inputs or files."""

import json
import random
import sys
import unicodedata


SEED = 0x71A9B003
RANDOM_CASES = 512
STRING_CASES = 128
NUMBERS = [
    "0", "-0", "1", "-1", "1.0", "1e0", "-0.0", "1e-5", "1e16",
    "9007199254740993", "9007199254740993.0", "5e-324", "1e9999",
    "-1e-9999", "NaN", "Infinity", "-Infinity", "2.2250738585072014e-308",
]
KEYS = ["a", "A", "0", "12", "2", "__proto__", "constructor", "prototype",
        "\ue000", "\U00010000", "\ud800", "\udfff", "\n", "", "é"]
CHARACTERS = ["a", "Z", " ", "\n", "\r", "\t", "\b", "\f", "\0",
              "\x1f", '"', "\\", "/", "é", "\u2028", "\u2029",
              "\ue000", "\U00010000", "\U0001f600", "\ud800", "\udfff"]


def encode_string(value, source):
    ascii_choice = source.choice([True, False])
    contains_surrogate = any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    return json.dumps(value, ensure_ascii=contains_surrogate or ascii_choice)


def random_value(source, depth):
    kind = source.randrange(6 if depth else 4)
    if kind == 0:
        return source.choice(NUMBERS)
    if kind == 1:
        return source.choice(["true", "false", "null"])
    if kind in (2, 3):
        return encode_string("".join(source.choices(CHARACTERS, k=source.randrange(12))), source)
    if kind == 4:
        return "[" + ",".join(random_value(source, depth - 1) for _ in range(source.randrange(5))) + "]"
    return "{" + ",".join(
        encode_string(source.choice(KEYS), source) + ":" + random_value(source, depth - 1)
        for _ in range(source.randrange(6))
    ) + "}"


def cases():
    fixed = [
        "null", "true", "false", "[]", "{}", "[null,true,false,0,1.0,-0.0]",
        '{"a":1,"a":2}', '{"a":1,"\\u0061":2.0}',
        '{"__proto__":1,"constructor":2,"prototype":3}',
        '{"2":2,"12":12,"0":0,"a":1}',
        '{"\\ud800\\udc00":1,"\\ue000":2}',
        '{"\\ud800":1,"\\udfff":2,"\\u0000":3}',
        '{"z":[1,1.0,1e0,-0,-0.0],"a":{"b":true,"a":null}}',
        '"\\ud800"', '"\\udfff"', '"\\ud800\\udc00"',
        '"\\ud800x\\udc00"', '"\\/\\b\\f\\n\\r\\t\\u0000"',
        '"é😀\u2028\u2029"',
        " \r\n\t{\"a\" : [ 1, 2 ] }\t ",
        '{"n":NaN,"p":Infinity,"m":-Infinity,"o":1e9999}',
        '{"\\ud800\\udc00":1,"\\ud800":2,"\\ue000":3,"\\udfff":4}',
    ]
    fixed.extend(NUMBERS)
    for index, raw in enumerate(fixed):
        yield f"fixed-{index}", raw
    invalid = [
        "", " ", "[", "{", "[1,]", '{"a":1,}', "[,1]", '{"a" 1}',
        "{a:1}", "[1 2]", "true false", "nullx", "01", "+1", ".1", "1.",
        "1e", "1e+", "--1", "nan", "inf", "+Infinity", "-NaN",
        '"unterminated', '"\\x"', '"\\u12"', '"\\uGGGG"', '"raw\nnewline"',
        '"raw\x00null"', "\ufeff{}", "[true,false]x", '["😀",?]',
    ]
    for index, raw in enumerate(invalid):
        yield f"invalid-{index}", raw
    source = random.Random(SEED)
    for index in range(RANDOM_CASES):
        yield f"seeded-{index}", random_value(source, 5)
    for index in range(STRING_CASES):
        value = "".join(source.choices(CHARACTERS, k=32))
        yield f"string-{index}", encode_string(value, source)


def main():
    if len(sys.argv) != 1 or sys.stdin.read(1):
        sys.stderr.write("reference_input_rejected\n")
        return 2
    observations = []
    for identifier, raw in cases():
        # Raw text models UTF-8 transports, not arbitrary Python surrogate strings.
        # Lone surrogates remain covered as ASCII JSON escape sequences.
        raw.encode("utf-8", errors="strict")
        item = {"id": identifier, "raw": raw}
        try:
            value = json.loads(raw)
            item.update({"accepted": True, "scope": json.dumps(
                value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
            )})
        except json.JSONDecodeError as error:
            item.update({"accepted": False, "error": "JSONDecodeError", "offset": error.pos})
        observations.append(item)
    result = {
        "provenance": {
            "inputModel": "unicode-scalar-raw-text",
            "implementation": sys.implementation.name,
            "python": sys.version.split()[0],
            "unicode": unicodedata.unidata_version,
            "intMaxStrDigits": sys.get_int_max_str_digits(),
            "recursionLimit": sys.getrecursionlimit(),
        },
        "seed": SEED,
        "randomCases": RANDOM_CASES,
        "stringCases": STRING_CASES,
        "cases": observations,
    }
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
