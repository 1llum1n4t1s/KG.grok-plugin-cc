import assert from "node:assert/strict";
import test from "node:test";

import { splitRawArgumentString } from "../plugins/grok/scripts/lib/args.mjs";

test("raw argument parser preserves Windows path separators", () => {
  assert.deepEqual(
    splitRawArgumentString('--cwd C:\\Users\\IMT\\dev\\repo --focus "review this path"'),
    ["--cwd", "C:\\Users\\IMT\\dev\\repo", "--focus", "review this path"]
  );
});

test("raw argument parser still supports escaped spaces and quotes", () => {
  assert.deepEqual(splitRawArgumentString('one two\\ three "four\\\"five"'), ["one", "two three", 'four"five']);
});
