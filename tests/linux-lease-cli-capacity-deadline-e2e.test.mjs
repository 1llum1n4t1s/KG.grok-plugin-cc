import test from "node:test";
import { runCapacity } from "./fixtures/linux-lease-cli-capacity-native-helper.mjs";

// Linux 実機の満杯状態で期限切れと回収再開を確認する。Mac は対象外。
test("Linux CLI preserves and resumes a reclaim interrupted by its deadline", {
  skip: process.platform !== "linux" ? "requires Linux /proc and flock" : false, timeout: 3600000
}, t => runCapacity(t, true));
