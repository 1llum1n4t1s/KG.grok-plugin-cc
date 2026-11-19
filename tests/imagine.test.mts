import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import {
  assertImagineAspect,
  extractGeneratedImagePaths,
  imagineBilling,
  isImageGenerationTool,
  isMissingImageEntitlement
} from "../plugins/grok/scripts/lib/imagine.mjs";

process.env.GROK_PLUGIN_LANGUAGE = "en";

const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function sessionImage(home: string, name = "1.jpg") {
  const file = path.join(home, ".grok", "sessions", "sid", "images", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jpeg);
  return file;
}

function imageUpdates(file: string, text?: string) {
  return [
    { sessionUpdate: "tool_call", toolCallId: "call-img", title: "image_gen", rawInput: { prompt: "red cube", aspect_ratio: "1:1" } },
    { sessionUpdate: "tool_call_update", toolCallId: "call-img", title: "imagine: red cube", status: "in_progress", rawInput: { variant: "ImageGen", prompt: "red cube", aspect_ratio: "1:1" } },
    { sessionUpdate: "tool_call_update", toolCallId: "call-img", status: "completed", content: [{ type: "content", content: { type: "text", text: text ?? JSON.stringify({ path: file, filename: path.basename(file), session_folder: "images" }) } }] }
  ];
}

function imagine(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 15000 });
}

test("image result parsers accept the JSON path and the Windows prose path", () => {
  const jsonPath = extractGeneratedImagePaths({
    content: [{ type: "content", content: { type: "text", text: JSON.stringify({ path: "/tmp/probe/images/1.jpg", filename: "1.jpg", session_folder: "images" }) } }]
  });
  assert.deepEqual(jsonPath, ["/tmp/probe/images/1.jpg"]);
  const prose = String.raw`Image generated and saved to \\?\C:\Users\Dell\.grok\sessions\abc\images\1.jpg.`;
  assert.deepEqual(extractGeneratedImagePaths({ content: [{ type: "text", text: prose }] }), [String.raw`C:\Users\Dell\.grok\sessions\abc\images\1.jpg`]);
});

test("image entitlement matches only an image-tool SuperGrok failure", () => {
  assert.equal(isMissingImageEntitlement("Grok Build's image tools need a SuperGrok subscription."), true);
  assert.equal(isMissingImageEntitlement("usage balance exhausted"), false);
  assert.equal(isMissingImageEntitlement("SuperGrok includes chat"), false);
  assert.equal(isImageGenerationTool({ title: "image_gen", rawInput: { prompt: "cube" } }), true);
  assert.equal(isImageGenerationTool({ title: "imagine: cube", rawInput: { variant: "ImageGen" } }), true);
  assert.equal(isImageGenerationTool({ title: "video_gen", rawInput: { variant: "VideoGen" } }), false);
  assert.equal(isImageGenerationTool({ title: "imagine-video: cube" }), false);
  assert.throws(() => assertImagineAspect("7:1"), /7:1/);
});

test("API key billing is refused until opt-in, and subscription sign-in is not", () => {
  const api = imagineBilling({ XAI_API_KEY: "secret" }, false);
  assert.equal(api.allowed, false);
  assert.match(api.notice, /grok-imagine-image-2\.0/);
  assert.match(api.notice, /\$0\.04\/img/);
  assert.match(api.notice, /--allow-api-billing/);
  const opted = imagineBilling({ XAI_API_KEY: "secret" }, true);
  assert.equal(opted.method, "api-key");
  assert.equal(opted.allowed, true);
  const subscription = imagineBilling({}, false);
  assert.equal(subscription.method, "browser-login");
  assert.match(subscription.notice, /weekly usage pool/);
});

test("imagine does not start Grok when API billing was not accepted", () => {
  const fake = installFakeGrok({ replies: [{ text: "should not run" }] });
  const cwd = makeTempDir("grok-imagine-cwd-");
  try {
    const refused = imagine(["imagine", "a red cube"], fake.env, cwd);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /grok-imagine-image-2\.0/);
    assert.match(refused.stderr, /--allow-api-billing/);
    assert.equal(fake.readState(), null);
    const json = imagine(["imagine", "--json", "a red cube"], fake.env, cwd);
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).error.classification, "api-billing-required");
    assert.equal(fake.readState(), null);
  } finally {
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("imagine rejects repository writes, a bad aspect, and an output path outside the workspace before starting Grok", () => {
  const fake = installFakeGrok({ replies: [{ text: "should not run" }] });
  const cwd = makeTempDir("grok-imagine-cwd-");
  try {
    for (const args of [
      ["imagine", "--write", "a red cube"],
      ["imagine", "--aspect", "7:1", "a red cube"],
      ["imagine", "--output", "../outside.png", "a red cube"]
    ]) {
      const result = imagine(args, fake.env, cwd);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(fake.readState(), null);
    }
    assert.match(imagine(["imagine", "--write", "a red cube"], fake.env, cwd).stderr, /does not edit the repository/);
  } finally {
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("API key opt-in copies the session image and leaves the repository file untouched", () => {
  const home = makeTempDir("grok-imagine-home-");
  const source = sessionImage(home);
  const fake = installFakeGrok({ replies: [{
    requestPermissionFor: { title: "image_gen", kind: "other", rawInput: { prompt: "赤い立方体", aspect_ratio: "16:9" } },
    updates: imageUpdates(source),
    text: "saved"
  }] });
  const cwd = makeTempDir("grok-imagine-cwd-");
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep");
  const env = { ...fake.env, HOME: home, USERPROFILE: home };
  try {
    const result = imagine(["imagine", "--json", "--allow-api-billing", "--aspect", "16:9", "--", "赤い立方体"], env, cwd);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.billing.method, "api-key");
    assert.match(payload.billing.notice, /\$0\.04\/img/);
    assert.equal(payload.images.length, 1);
    assert.equal(fs.readFileSync(payload.images[0].saved).toString("hex"), jpeg.toString("hex"));
    assert.equal(path.basename(payload.images[0].saved), "1.jpg");
    assert.equal(fs.readFileSync(path.join(cwd, "keep.txt"), "utf8"), "keep");
    assert.match(fake.readState().prompts[0], /赤い立方体/);
    assert.match(fake.readState().prompts[0], /aspect_ratio to "16:9"/);
    assert.match(fake.readState().prompts[0], /Do not create, edit, delete, or rename anything in the repository/);
  } finally {
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(home, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("subscription sign-in copies a prose-reported session image without API opt-in", () => {
  const home = makeTempDir("grok-imagine-home-");
  const source = sessionImage(home);
  const fake = installFakeGrok({ replies: [{
    requestPermissionFor: { title: "image_gen", kind: "other", rawInput: { prompt: "cube" } },
    updates: imageUpdates(source, `Image generated and saved to ${source}.`),
    text: source
  }] });
  const cwd = makeTempDir("grok-imagine-cwd-");
  const env = { ...fake.env, HOME: home, USERPROFILE: home };
  delete env.XAI_API_KEY;
  try {
    const result = imagine(["imagine", "a small red cube"], env, cwd);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /weekly usage pool/);
    assert.match(result.stdout, /Saved: /);
    assert.equal(fs.readFileSync(path.join(cwd, "grok-imagine", "1.jpg")).toString("hex"), jpeg.toString("hex"));
    assert.doesNotMatch(result.stdout, /--allow-api-billing/);
  } finally {
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(home, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("an existing output name is not overwritten", () => {
  const home = makeTempDir("grok-imagine-home-");
  const source = sessionImage(home);
  const fake = installFakeGrok({ replies: [{
    requestPermissionFor: { title: "image_gen", kind: "other", rawInput: { prompt: "cube" } },
    updates: imageUpdates(source),
    text: "saved"
  }] });
  const cwd = makeTempDir("grok-imagine-cwd-");
  fs.mkdirSync(path.join(cwd, "grok-imagine"));
  fs.writeFileSync(path.join(cwd, "grok-imagine", "1.jpg"), "old");
  const env = { ...fake.env, HOME: home, USERPROFILE: home };
  delete env.XAI_API_KEY;
  try {
    const result = imagine(["imagine", "cube"], env, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, "grok-imagine", "1.jpg"), "utf8"), "old");
    assert.equal(fs.readFileSync(path.join(cwd, "grok-imagine", "1-2.jpg")).toString("hex"), jpeg.toString("hex"));
  } finally {
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(home, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("a reported path outside the session images directory is not copied", () => {
  const home = makeTempDir("grok-imagine-home-");
  const fake = installFakeGrok({});
  const cwd = makeTempDir("grok-imagine-cwd-");
  const planted = path.join(cwd, "secret.jpg");
  fs.writeFileSync(planted, "secret");
  fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{
    requestPermissionFor: { title: "image_gen", kind: "other", rawInput: { prompt: "cube" } },
    updates: imageUpdates(planted),
    text: "saved"
  }] }));
  const env = { ...fake.env, HOME: home, USERPROFILE: home };
  delete env.XAI_API_KEY;
  try {
    const result = imagine(["imagine", "--json", "cube"], env, cwd);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.classification, "untrusted-image-path");
    assert.equal(JSON.parse(result.stdout).images.length, 0);
    assert.equal(fs.readFileSync(planted, "utf8"), "secret");
    assert.equal(fs.existsSync(path.join(cwd, "grok-imagine")), false);
  } finally {
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(home, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("missing image entitlement and non-image tools fail without writing the workspace", () => {
  const fake = installFakeGrok({ replies: [{ text: "Grok Build's image tools need a SuperGrok subscription." }] });
  const cwd = makeTempDir("grok-imagine-cwd-");
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep");
  const env = { ...fake.env };
  delete env.XAI_API_KEY;
  try {
    const missing = imagine(["imagine", "--json", "a cube"], env, cwd);
    assert.equal(missing.status, 1, missing.stdout);
    const payload = JSON.parse(missing.stdout);
    assert.equal(payload.error.classification, "image-entitlement-missing");
    assert.match(payload.error.guidance, /SuperGrok/);
    assert.equal(payload.images.length, 0);
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{
      requestPermissionFor: { title: "video_gen", kind: "other", rawInput: { variant: "VideoGen" } },
      onDenied: { text: "denied", stopReason: "cancelled" }
    }] }));
    const video = imagine(["imagine", "--json", "animate it"], env, cwd);
    assert.equal(video.status, 1, video.stdout);
    assert.match(JSON.parse(video.stdout).permissionDenials.join(" "), /imagine only allows the image generation tool/);
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{
      requestPermissionFor: { title: "Write a file", kind: "edit", rawInput: { path: "keep.txt" } },
      onDenied: { text: "denied", stopReason: "cancelled" }
    }] }));
    const edit = imagine(["imagine", "cube"], env, cwd);
    assert.equal(edit.status, 1, edit.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, "keep.txt"), "utf8"), "keep");
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{
      requestClientFileWrite: { path: "keep.txt", content: "changed" },
      text: "wrote"
    }] }));
    const clientWrite = imagine(["imagine", "--json", "cube"], env, cwd);
    assert.equal(clientWrite.status, 1, clientWrite.stdout);
    assert.match(JSON.parse(clientWrite.stdout).permissionDenials.join(" "), /ACP file write request was denied/);
    assert.equal(fs.readFileSync(path.join(cwd, "keep.txt"), "utf8"), "keep");
  } finally {
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("imagine copies the image when the working directory is a symlink to the workspace", () => {
  const home = makeTempDir("grok-imagine-home-");
  const source = sessionImage(home);
  const fake = installFakeGrok({ replies: [{
    requestPermissionFor: { title: "image_gen", kind: "other", rawInput: { prompt: "cube" } },
    updates: imageUpdates(source),
    text: "saved"
  }] });
  const real = makeTempDir("grok-imagine-real-");
  const linkParent = makeTempDir("grok-imagine-link-");
  const cwd = path.join(linkParent, "cwd");
  fs.symlinkSync(real, cwd, "dir");
  const env = { ...fake.env, HOME: home, USERPROFILE: home };
  delete env.XAI_API_KEY;
  try {
    const result = imagine(["imagine", "--json", "a red cube"], env, cwd);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const saved = JSON.parse(result.stdout).images[0].saved;
    assert.equal(fs.readFileSync(saved).toString("hex"), jpeg.toString("hex"));
    assert.equal(path.relative(fs.realpathSync(real), fs.realpathSync(saved)).startsWith(".."), false);
    assert.equal(fs.existsSync(path.join(real, "grok-imagine", "1.jpg")), true);
  } finally {
    fs.unlinkSync(cwd);
    removeTempFixture(real, { recursive: true, force: true });
    removeTempFixture(linkParent, { recursive: true, force: true });
    removeTempFixture(home, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});

test("an output directory that is a symlink out of the workspace is refused", () => {
  const fake = installFakeGrok({ replies: [{ text: "should not run" }] });
  const cwd = makeTempDir("grok-imagine-cwd-");
  const outside = makeTempDir("grok-imagine-outside-");
  const link = path.join(cwd, "grok-imagine");
  fs.symlinkSync(outside, link);
  const env = { ...fake.env };
  delete env.XAI_API_KEY;
  try {
    const result = imagine(["imagine", "cube"], env, cwd);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /inside the workspace/);
    assert.equal(fake.readState(), null);
    assert.equal(fs.readdirSync(outside).length, 0);
  } finally {
    fs.unlinkSync(link);
    removeTempFixture(cwd, { recursive: true, force: true });
    removeTempFixture(outside, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  }
});
