/**
 * 既定モデル（fast があれば fast、無ければ grok-4.7）と既定の推論深度 high の解決を、
 * 偽の Grok に対して共通ランタイムで確認する。明示指定は文字どおり尊重されること。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runGrokReview, runGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
process.env.GROK_PLUGIN_LANGUAGE = "en";
const FAST = "grok-4.7-build-fast";
const WITH_FAST = ["grok-fake-nonreasoning", "grok-4.7", FAST, "grok-4.6", "grok-4.5"];
const WITHOUT_FAST = ["grok-fake-nonreasoning", "grok-4.6", "grok-4.5", "grok-4.7"];
const ONLY_46 = ["grok-fake-nonreasoning", "grok-4.6", "grok-4.5"];
function effortOption(values, currentValue = "medium") {
    return {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue,
        options: values.map((value) => ({ value, name: value }))
    };
}
function modelOption(values) {
    return {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "grok-fake-nonreasoning",
        options: values.map((value) => ({ value, name: value }))
    };
}
async function runTurn(t, scenario, options = {}) {
    const cwd = makeTempDir("grok-model-defaults-");
    const fake = installFakeGrok({ replies: [{ text: "ok" }], ...scenario });
    t.after(() => {
        removeTempFixture(cwd, { recursive: true, force: true });
        removeTempFixture(fake.binDir, { recursive: true, force: true });
    });
    const env = { ...fake.env, ...options.env };
    if (!options.env?.GROK_PLUGIN_MODEL)
        delete env.GROK_PLUGIN_MODEL;
    const progress = [];
    const result = await runGrokTurn(cwd, {
        env,
        prompt: "do a thing",
        readOnly: true,
        model: options.model,
        effort: options.effort,
        onProgress: (update) => { const message = typeof update === "string" ? update : update.message; if (message)
            progress.push(message); }
    });
    const state = fake.readState();
    return { result, state, progress };
}
const effortMessages = (progress) => progress.filter((message) => /reasoning effort/i.test(message));
test("default model is the fast variant when the model list offers it", async (t) => {
    const { result, state } = await runTurn(t, { availableModels: WITH_FAST });
    assert.deepEqual(state.models, [FAST]);
    assert.equal(result.model, FAST);
});
test("default model falls back to grok-4.7 when there is no fast variant", async (t) => {
    const { result, state } = await runTurn(t, { availableModels: WITHOUT_FAST });
    assert.deepEqual(state.models, ["grok-4.7"]);
    assert.equal(result.model, "grok-4.7");
});
test("default model requests grok-4.7 when the model list is empty", async (t) => {
    const { state } = await runTurn(t, { availableModels: [] });
    assert.deepEqual(state.models, ["grok-4.7"]);
});
test("default model stays on the session default when no candidate is offered", async (t) => {
    const { result, state, progress } = await runTurn(t, { availableModels: ONLY_46 });
    assert.deepEqual(state.models, []);
    assert.equal(result.model, "grok-fake-nonreasoning");
    assert.ok(progress.some((message) => /None of grok-4\.7-build-fast, grok-4\.7 is available; staying on grok-fake-nonreasoning/.test(message)), progress.join("\n"));
});
test("an explicit grok-4.6 is kept even when a fast variant exists", async (t) => {
    const { result, state } = await runTurn(t, { availableModels: WITH_FAST }, { model: "grok-4.6" });
    assert.deepEqual(state.models, ["grok-4.6"]);
    assert.equal(result.model, "grok-4.6");
});
test("GROK_PLUGIN_MODEL=grok-4.6 is kept even when a fast variant exists", async (t) => {
    const { result, state } = await runTurn(t, { availableModels: WITH_FAST }, { env: { GROK_PLUGIN_MODEL: "grok-4.6" } });
    assert.deepEqual(state.models, ["grok-4.6"]);
    assert.equal(result.model, "grok-4.6");
});
test("an explicit grok-4.7 stays the non-fast model", async (t) => {
    const { result, state } = await runTurn(t, { availableModels: WITH_FAST }, { model: "grok-4.7" });
    assert.deepEqual(state.models, ["grok-4.7"]);
    assert.equal(result.model, "grok-4.7");
});
test("an unavailable explicit model is not replaced by the default candidates", async (t) => {
    const { result, state, progress } = await runTurn(t, { availableModels: WITH_FAST }, { model: "grok-9" });
    assert.deepEqual(state.models, []);
    assert.equal(result.model, "grok-fake-nonreasoning");
    assert.ok(progress.some((message) => /Model grok-9 is not available/.test(message)));
});
test("reasoning effort defaults to high and is applied through set_config_option", async (t) => {
    const { state, progress } = await runTurn(t, {
        availableModels: WITH_FAST,
        configOptions: [effortOption(["xhigh", "high", "medium", "low"])]
    });
    assert.deepEqual(state.configs, [{ configId: "reasoning_effort", value: "high" }]);
    assert.ok(progress.some((message) => /Reasoning effort set to high/.test(message)));
});
test("reasoning effort is not touched when it is already high", async (t) => {
    const { state } = await runTurn(t, { configOptions: [effortOption(["high", "medium", "low"], "high")] });
    assert.deepEqual(state.configs, []);
});
test("an explicit effort overrides the high default", async (t) => {
    const { state } = await runTurn(t, { configOptions: [effortOption(["xhigh", "high", "medium", "low"])] }, { effort: "low" });
    assert.deepEqual(state.configs, [{ configId: "reasoning_effort", value: "low" }]);
});
test("the implicit default stays silent when there is no effort selector or no high", async (t) => {
    const none = await runTurn(t, { availableModels: WITH_FAST, configOptions: [] });
    assert.deepEqual(none.state.configs, []);
    assert.deepEqual(effortMessages(none.progress), []);
    const noHigh = await runTurn(t, { configOptions: [effortOption(["medium", "low"])] });
    assert.deepEqual(noHigh.state.configs, []);
    assert.deepEqual(effortMessages(noHigh.progress), []);
});
test("an explicit effort still reports when it cannot be applied", async (t) => {
    const none = await runTurn(t, { configOptions: [] }, { effort: "low" });
    assert.deepEqual(effortMessages(none.progress), ["This Grok build exposes no reasoning effort selector; --effort low was not applied."]);
    const missing = await runTurn(t, { configOptions: [effortOption(["high", "medium"])] }, { effort: "low" });
    assert.deepEqual(missing.state.configs, []);
    assert.match(effortMessages(missing.progress).join("\n"), /Reasoning effort low is not offered \(available: high, medium\); leaving it unchanged\./);
});
test("a session/load failure after set_model does not abort the turn", async (t) => {
    const { result, state } = await runTurn(t, {
        availableModels: WITH_FAST,
        configOptions: [effortOption(["high", "medium", "low"])],
        loadError: "session is already active"
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(state.models, [FAST]);
    assert.deepEqual(state.configs, []);
});
test("effort follows the options of the model session/set_model switched to", async (t) => {
    // set_model は成功して空の応答を返す。API キーの推論なしセッションには thought_level が無く、
    // fast へ切り替えたあとの一覧にだけ high がある。
    const gained = await runTurn(t, {
        availableModels: WITH_FAST,
        configOptions: [],
        configOptionsAfterModel: [effortOption(["xhigh", "high", "medium", "low"])]
    });
    assert.deepEqual(gained.state.models, [FAST]);
    assert.deepEqual(gained.state.loads, ["fake-session-1"]);
    assert.deepEqual(gained.state.configs, [{ configId: "reasoning_effort", value: "high" }]);
    assert.ok(gained.progress.some((message) => /Reasoning effort set to high/.test(message)));
    // 切替前には high があり、切替後のモデルには無い。high は送らない。
    const lost = await runTurn(t, {
        availableModels: WITH_FAST,
        configOptions: [effortOption(["high", "medium", "low"])],
        configOptionsAfterModel: [effortOption(["medium", "low"])]
    });
    assert.deepEqual(lost.state.models, [FAST]);
    assert.deepEqual(lost.state.loads, ["fake-session-1"]);
    assert.deepEqual(lost.state.configs, []);
    assert.deepEqual(effortMessages(lost.progress), []);
});
test("effort is judged on the configOptions returned after switching the model", async (t) => {
    // set_config_option 経路: 切替え前の項目には high が無く、切替え後の応答にだけ high がある。
    const before = [modelOption(["grok-fake-nonreasoning", FAST]), effortOption(["medium", "low"])];
    const after = [modelOption(["grok-fake-nonreasoning", FAST]), effortOption(["xhigh", "high", "medium", "low"])];
    const gained = await runTurn(t, {
        availableModels: WITH_FAST,
        setModelUnsupported: true,
        configOptions: before,
        configOptionsAfter: { [`model=${FAST}`]: after }
    });
    assert.deepEqual(gained.state.models, []);
    assert.deepEqual(gained.state.configs, [
        { configId: "model", value: FAST },
        { configId: "reasoning_effort", value: "high" }
    ]);
    // 逆に、切替え前には high があっても、切替え後に無ければ黙って流す。
    const lost = await runTurn(t, {
        availableModels: WITH_FAST,
        setModelUnsupported: true,
        configOptions: [modelOption(["grok-fake-nonreasoning", FAST]), effortOption(["high", "medium", "low"])],
        configOptionsAfter: { [`model=${FAST}`]: [modelOption(["grok-fake-nonreasoning", FAST]), effortOption(["medium", "low"])] }
    });
    assert.deepEqual(lost.state.configs, [{ configId: "model", value: FAST }]);
    assert.deepEqual(effortMessages(lost.progress), []);
});
test("review uses the same default model and effort", async (t) => {
    const cwd = makeTempDir("grok-model-defaults-review-");
    const fake = installFakeGrok({
        availableModels: WITH_FAST,
        configOptions: [effortOption(["xhigh", "high", "medium", "low"])],
        replies: [{ text: "{}" }]
    });
    t.after(() => {
        removeTempFixture(cwd, { recursive: true, force: true });
        removeTempFixture(fake.binDir, { recursive: true, force: true });
    });
    const env = { ...fake.env };
    delete env.GROK_PLUGIN_MODEL;
    const result = await runGrokReview(cwd, { env, instructions: "Review." });
    const state = fake.readState();
    assert.deepEqual(state.models, [FAST]);
    assert.deepEqual(state.configs, [{ configId: "reasoning_effort", value: "high" }]);
    assert.equal(result.model, FAST);
});
