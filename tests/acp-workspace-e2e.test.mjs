import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { classifyShellCommand } from "../plugins/grok/scripts/lib/grok.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { removeTempFixture } from "./helpers.mjs";
// 失敗条件: 外部リンク経由のread/write、未作成の親、隣接rootの接頭辞。
// 保全条件: 内部リンク、リンクのcwd、通常の新規write、欠損readの既存エラー。
test("ACP file requests stay inside the real session workspace", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-workspace-e2e-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "workspace-sibling");
    const inside = path.join(workspace, "inside");
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inside, "canary.txt"), "INSIDE_CANARY");
    fs.writeFileSync(path.join(outside, "canary.txt"), "OUTSIDE_CANARY");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(outside, path.join(workspace, "outside-link"), linkType);
    fs.symlinkSync(inside, path.join(workspace, "inside-link"), linkType);
    const cwdAlias = path.join(root, "cwd-alias");
    fs.symlinkSync(workspace, cwdAlias, linkType);
    fs.symlinkSync(path.join(outside, "missing-target"), path.join(workspace, "dangling-link"), linkType);
    const links = [cwdAlias, path.join(workspace, "outside-link"), path.join(workspace, "inside-link"), path.join(workspace, "dangling-link")].map(file => {
        const stat = fs.lstatSync(file, { bigint: true });
        assert.ok(stat.isSymbolicLink());
        return { file, dev: stat.dev, ino: stat.ino, target: fs.readlinkSync(file) };
    });
    const cases = [
        { read: "outside-link/canary.txt", code: -32602 },
        { write: "outside-link/canary.txt", code: -32602 },
        { write: "outside-link/new/deep.txt", code: -32602 },
        { write: "dangling-link/new.txt", code: -32602 },
        { read: path.join(outside, "canary.txt"), code: -32602 },
        { write: path.join(outside, "prefix.txt"), code: -32602 },
        { read: "inside-link/canary.txt", content: "INSIDE_CANARY" },
        { write: "inside-link/new/deep.txt" },
        { write: "normal/new.txt" },
        { read: "missing.txt", code: -32603 }
    ];
    const fake = installFakeGrok({ replies: cases.map((item) => item.read
            ? { requestClientFileRead: { path: item.read } }
            : { requestClientFileWrite: { path: item.write, content: "DUMMY_WRITE" } }) });
    let client;
    try {
        client = await GrokAcpClient.connectForeground(cwdAlias, {
            grokBin: fake.env.GROK_BIN, env: fake.env,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
        });
        const session = await client.request("session/new", { cwd: cwdAlias, mcpServers: [] });
        for (const item of cases) {
            await client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "exercise dummy file request" }] });
            const response = fake.readState().clientFileResponses.at(-1);
            assert.equal(response.code, item.code, item.read ?? item.write);
            if (item.content)
                assert.equal(response.content, item.content);
            if (item.code === -32603)
                assert.match(response.message, /ENOENT/);
        }
        assert.equal(fs.readFileSync(path.join(outside, "canary.txt"), "utf8"), "OUTSIDE_CANARY");
        assert.equal(fs.existsSync(path.join(outside, "new")), false);
        assert.equal(fs.existsSync(path.join(outside, "missing-target")), false);
        assert.equal(fs.existsSync(path.join(outside, "prefix.txt")), false);
        assert.equal(fs.readFileSync(path.join(inside, "new/deep.txt"), "utf8"), "DUMMY_WRITE");
        assert.equal(fs.readFileSync(path.join(workspace, "normal/new.txt"), "utf8"), "DUMMY_WRITE");
    }
    finally {
        try {
            assert.ok(client, "connection did not return a client with shutdown evidence");
            await client.close();
            assert.equal(client.closeStopUnconfirmed, false);
            for (const link of links) {
                const stat = fs.lstatSync(link.file, { bigint: true });
                assert.ok(stat.isSymbolicLink() && stat.dev === link.dev && stat.ino === link.ino, "fixture link identity changed");
                assert.equal(fs.readlinkSync(link.file), link.target, "fixture link target changed");
            }
            if (!(process.platform === "win32" && process.env.GROK_TEST_DEFER_CLEANUP === "1"))
                for (const link of links)
                    fs.unlinkSync(link.file);
            removeTempFixture(root, { recursive: true, force: true });
            removeTempFixture(fake.binDir, { recursive: true, force: true });
        }
        catch (error) {
            t.diagnostic(`Fixture retained: ${root}; ${fake.binDir}: ${error.message}`);
            throw error;
        }
    }
});
// cwd が実体で、対象がそれを指すシンボリックリンク経由のとき、字句比較は `..` になる。
// Test-Path と同じ実体判定で領域内の読取りを許可し、領域外は拒否する。
test("ACP reads a workspace file addressed through a symlink alias", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-alias-read-"));
    const real = path.join(root, "real");
    const outside = path.join(root, "outside.txt");
    const alias = path.join(root, "alias");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "inside.txt"), "ALIAS_INSIDE");
    fs.writeFileSync(outside, "OUTSIDE");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(real, alias, linkType);
    const aliasFile = path.join(alias, "inside.txt");
    const lexical = path.relative(path.resolve(real), path.resolve(real, aliasFile));
    assert.ok(lexical === ".." || lexical.startsWith(`..${path.sep}`), lexical);
    assert.equal(classifyShellCommand(`Test-Path -LiteralPath "${aliasFile}"`, real).allowed, true);
    assert.equal(classifyShellCommand(`Test-Path -LiteralPath "${outside}"`, real).allowed, false);
    const link = { file: alias, dev: fs.lstatSync(alias, { bigint: true }).dev, ino: fs.lstatSync(alias, { bigint: true }).ino, target: fs.readlinkSync(alias) };
    const fake = installFakeGrok({ replies: [
            { requestClientFileRead: { path: aliasFile } },
            { requestClientFileRead: { path: outside } }
        ] });
    let client;
    try {
        client = await GrokAcpClient.connectForeground(real, {
            grokBin: fake.env.GROK_BIN, env: fake.env,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
        });
        const session = await client.request("session/new", { cwd: real, mcpServers: [] });
        await client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "read alias" }] });
        const allowed = fake.readState().clientFileResponses.at(-1);
        assert.equal(allowed.code, undefined, JSON.stringify(allowed));
        assert.equal(allowed.content, "ALIAS_INSIDE");
        await client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "read outside" }] });
        const denied = fake.readState().clientFileResponses.at(-1);
        assert.equal(denied.code, -32602, JSON.stringify(denied));
        assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE");
    }
    finally {
        try {
            assert.ok(client, "connection did not return a client with shutdown evidence");
            await client.close();
            assert.equal(client.closeStopUnconfirmed, false);
            const stat = fs.lstatSync(link.file, { bigint: true });
            assert.ok(stat.isSymbolicLink() && stat.dev === link.dev && stat.ino === link.ino, "fixture link identity changed");
            assert.equal(fs.readlinkSync(link.file), link.target, "fixture link target changed");
            if (!(process.platform === "win32" && process.env.GROK_TEST_DEFER_CLEANUP === "1"))
                fs.unlinkSync(link.file);
            removeTempFixture(root, { recursive: true, force: true });
            removeTempFixture(fake.binDir, { recursive: true, force: true });
        }
        catch (error) {
            t.diagnostic(`Fixture retained: ${root}; ${fake.binDir}: ${error.message}`);
            throw error;
        }
    }
});
// 失敗条件: ACP処理中のstate更新と親のreadStateが重なり、不完全JSONを読む。
test("fake ACP state remains readable while the agent publishes updates", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-state-e2e-"));
    const fake = installFakeGrok({ holdPrompt: true });
    let client;
    try {
        client = await GrokAcpClient.connectForeground(workspace, { grokBin: fake.env.GROK_BIN, env: fake.env });
        const session = await client.request("session/new", { cwd: workspace, mcpServers: [] });
        for (let i = 0; i < 80; i += 1) {
            void client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "DUMMY_STATE".repeat(400) }] }).catch(() => { });
        }
        const deadline = Date.now() + 10_000;
        while (fake.readState().prompts.length !== 80) {
            assert.ok(Date.now() < deadline, "fake agent must record all prompts");
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(fake.readState().prompts.length, 80);
    }
    finally {
        try {
            assert.ok(client, "connection did not return a client with shutdown evidence");
            await client.close();
            assert.equal(client.closeStopUnconfirmed, false);
            removeTempFixture(workspace, { recursive: true, force: true });
            removeTempFixture(fake.binDir, { recursive: true, force: true });
        }
        catch (error) {
            t.diagnostic(`Fixture retained: ${workspace}; ${fake.binDir}: ${error.message}`);
            throw error;
        }
    }
});
