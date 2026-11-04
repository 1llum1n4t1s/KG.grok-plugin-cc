import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compareGeneratedFiles } from "../scripts/check-generated.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
test("generated-file checks detect stale and missing distribution files and accept Git line endings", () => {
    const temp = makeTempDir("grok-generated-");
    try {
        const output = path.join(temp, "compiled");
        const repository = path.join(temp, "repository");
        fs.mkdirSync(output);
        fs.mkdirSync(repository);
        const compiled = path.join(output, "entry.mjs");
        const distributed = path.join(repository, "entry.mjs");
        fs.writeFileSync(compiled, "export const value = 1;\n");
        assert.deepEqual(compareGeneratedFiles(repository, output, [compiled]), ["entry.mjs"]);
        fs.writeFileSync(distributed, "export const value = 2;\n");
        assert.deepEqual(compareGeneratedFiles(repository, output, [compiled]), ["entry.mjs"]);
        fs.writeFileSync(distributed, "export const value = 1;\r\n");
        assert.deepEqual(compareGeneratedFiles(repository, output, [compiled]), []);
        assert.throws(() => compareGeneratedFiles(repository, output, [distributed]), /Unexpected compiler output/);
    }
    finally {
        removeTempFixture(temp, { recursive: true, force: true });
    }
});
