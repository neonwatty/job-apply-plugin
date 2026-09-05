import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const STORE_SCRIPT = join(REPO_ROOT, "scripts", "job-apply-store.py");
export const FIXED_CLOCK = "2026-09-05T00:00:00Z";

const DRIVER = String.raw`
import argparse, importlib.util, json, pathlib, sys
from datetime import datetime

mode, script, root, fixed_clock, encoded_args = sys.argv[1:]
spec = importlib.util.spec_from_file_location("contract_store_facade", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

if mode == "inventory":
    parser = module.build_parser()
    action = next(item for item in parser._actions if isinstance(item, argparse._SubParsersAction))
    print(json.dumps(list(action.choices)))
    raise SystemExit(0)

instant = datetime.fromisoformat(fixed_clock.replace("Z", "+00:00"))
module.utc_now = lambda: fixed_clock
module.resolve_store = lambda args: module.Store(
    pathlib.Path(root),
    pathlib.Path(root) / "absent-legacy-profile.json",
    clock=lambda: instant,
)
sys.argv = [script, "--root", root, *json.loads(encoded_args)]
raise SystemExit(module.main())
`;

function invoke(mode, root = "unused", args = []) {
  const result = spawnSync(process.env.PYTHON || "python3", [
    "-I", "-c", DRIVER, mode, STORE_SCRIPT, root, FIXED_CLOCK, JSON.stringify(args),
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  if (result.error) throw new Error("python_contract_runner_failed");
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function commandInventory() {
  const result = invoke("inventory");
  if (result.exitCode !== 0 || result.stderr !== "") throw new Error("parser_inventory_failed");
  try {
    const commands = JSON.parse(result.stdout);
    if (!Array.isArray(commands) || commands.some((item) => typeof item !== "string")) throw new Error();
    return commands;
  } catch {
    throw new Error("parser_inventory_invalid");
  }
}

export function runStore(root, args) {
  return invoke("command", root, args);
}
