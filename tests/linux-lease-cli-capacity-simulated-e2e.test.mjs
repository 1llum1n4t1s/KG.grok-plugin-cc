import test from "node:test";
import { runCapacity } from "./fixtures/linux-lease-cli-capacity-native-helper.mjs";

// Linux 実機の 256 枠を使う。Mac は /proc と flock がないため対象外。
test("Linux CLI completes a 257th task after reclaiming completed leases", {
  skip: process.platform !== "linux" ? "requires Linux /proc and flock" : false, timeout: 1800000
}, t => runCapacity(t, false));
