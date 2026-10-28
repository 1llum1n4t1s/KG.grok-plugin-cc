import fs from "node:fs";
const shadow = Object.create(fs);
const constants = { ...fs.constants };
if (process.env.GROK_TEST_MISSING_FLAG === "no-follow") constants.O_NOFOLLOW = 0;
if (process.env.GROK_TEST_MISSING_FLAG === "nonblock") constants.O_NONBLOCK = 0;
Object.defineProperty(shadow, "constants", { value: constants });
export default shadow;
