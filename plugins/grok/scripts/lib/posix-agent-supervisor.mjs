import fs from "node:fs";
import childProcess from "node:child_process";
// このプロセスは自身が作られた専用プロセスグループの leader。
// fd 3 は停止要求と終了報告の双方向通信路で、親の SIGKILL 時にも EOF になる。
// detachedを実装しないruntimeではagentを作らず失敗する。
try {
    process.kill(-process.pid, 0);
}
catch {
    process.stderr.write("Could not establish the owned Grok process group.\n");
    process.exit(1);
}
const lifeline = fs.createReadStream(null, { fd: 3, autoClose: true });
let stopping = false;
function stopGroup() {
    if (stopping)
        return;
    stopping = true;
    // leader が生存している間だけ、自分のグループへ送る。
    try {
        process.kill(-process.pid, "SIGTERM");
    }
    catch { /* 期限後に再確認する。 */ }
    setTimeout(() => {
        try {
            process.kill(-process.pid, "SIGKILL");
        }
        catch {
            process.exit(1);
        }
    }, 500);
}
process.on("SIGTERM", stopGroup);
process.on("SIGINT", stopGroup);
lifeline.on("end", stopGroup);
lifeline.on("data", stopGroup);
lifeline.on("error", stopGroup);
lifeline.resume();
const agent = childProcess.spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
function reportExit(code, signal) {
    try {
        fs.writeSync(3, `${JSON.stringify({ code, signal })}\n`);
    }
    catch { /* 親が終了済みなら停止を続ける。 */ }
}
agent.on("error", (error) => {
    process.stderr.write(`Could not start Grok agent: ${error.message}\n`);
    reportExit(1, null);
    stopGroup();
});
// agent が先に自然終了しても孫を残さず、親の EOF との競合を避ける。
agent.on("exit", (code, signal) => { reportExit(code, signal); stopGroup(); });
