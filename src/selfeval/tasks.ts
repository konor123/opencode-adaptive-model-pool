// Minimal self-evaluation set (plan v1.0 §6.4 items 1–3). Each task is a tiny sandbox + deterministic verifier.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface SelfEvalTask {
  id: string
  kind: "coding" | "tools"
  files: Record<string, string>
  prompt: string
  verify: (dir: string) => boolean
}

const py = (dir: string, file: string) => spawnSync("python3", [file], { cwd: dir, timeout: 30_000, stdio: "ignore" }).status === 0
const read = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined)

const CALC = `def average(values):
    """Return the arithmetic mean of a non-empty list of numbers."""
    total = 0
    for v in values[1:]:
        total += v
    return total // len(values)
`
const CALC_TEST = `from calc import average
assert average([1, 2, 3, 4]) == 2.5, average([1, 2, 3, 4])
assert average([10]) == 10
assert average([-1, 1]) == 0
print("ok")
`
const UTIL = `def compute_total(items):
    return sum(i["price"] * i["qty"] for i in items)
`
const MAIN = `from util import compute_total

def run():
    return compute_total([{"price": 3, "qty": 2}, {"price": 5, "qty": 1}])
`
const MAIN_TEST = `import util
from main import run
assert hasattr(util, "sum_items") and not hasattr(util, "compute_total")
assert run() == 11
print("ok")
`

export const TASKS: SelfEvalTask[] = [
  {
    id: "fix-bug-py",
    kind: "coding",
    files: { "calc.py": CALC, "test_calc.py": CALC_TEST },
    prompt: "The test in test_calc.py fails. Fix the bug in calc.py without editing test_calc.py, then run `python3 test_calc.py` to confirm it passes.",
    verify: (d) => read(d, "test_calc.py") === CALC_TEST && py(d, "test_calc.py"),
  },
  {
    id: "rename-multi-file",
    kind: "coding",
    files: { "util.py": UTIL, "main.py": MAIN, "test_main.py": MAIN_TEST },
    prompt: "Rename the function compute_total to sum_items in util.py and update every caller. Do not edit test_main.py. Then run `python3 test_main.py`.",
    verify: (d) => read(d, "test_main.py") === MAIN_TEST && py(d, "test_main.py") && !/compute_total/.test((read(d, "util.py") ?? "") + (read(d, "main.py") ?? "")),
  },
  {
    id: "write-json-exact",
    kind: "tools",
    files: {},
    prompt: 'Create a file named result.json whose entire content is a JSON object with exactly these keys: "name" (the string "oamp"), "version" (the integer 3), "tags" (an array with the strings "a" and "b" in that order). Use your file-writing tool.',
    verify: (d) => {
      try {
        const j = JSON.parse(read(d, "result.json") ?? "")
        return JSON.stringify(j) === JSON.stringify({ name: "oamp", version: 3, tags: ["a", "b"] }) ||
          (j.name === "oamp" && j.version === 3 && JSON.stringify(j.tags) === '["a","b"]' && Object.keys(j).length === 3)
      } catch {
        return false
      }
    },
  },
  {
    id: "read-then-write",
    kind: "tools",
    files: { "data.txt": "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\n" },
    prompt: "Read data.txt, then create count.txt containing only the number of lines in data.txt (digits only, no other text).",
    verify: (d) => (read(d, "count.txt") ?? "").trim() === "7",
  },
]
