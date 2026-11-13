/**
 * `stopAtFirstPositional` を立てると、最初の非オプションが出た時点で
 * 解析を打ち切り、残りを丸ごと positionals にする。自由記述を受け取る
 * コマンド（review / audit / rescue）で使う。これが無いと、利用者が
 * 本文中に書いた `--write` のような語がフラグとして解釈され、
 * 読み取り専用のつもりの実行が書き込み許可へ昇格してしまう。
 */
export function parseArgs(argv, config = {}) {
    const valueOptions = new Set(config.valueOptions ?? []);
    const booleanOptions = new Set(config.booleanOptions ?? []);
    const aliasMap = config.aliasMap ?? {};
    const stopAtFirstPositional = config.stopAtFirstPositional === true;
    const options = {};
    const positionals = [];
    let passthrough = false;
    // 位置引数を記録し、stopAtFirstPositional なら以後を丸ごと本文として扱う。
    // ループの制御（continue）は呼び出し側に残し、ここでは状態更新だけを行う。
    const pushPositional = (token) => {
        positionals.push(token);
        if (stopAtFirstPositional) {
            passthrough = true;
        }
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (passthrough) {
            positionals.push(token);
            continue;
        }
        if (token === "--") {
            passthrough = true;
            continue;
        }
        if (!token.startsWith("-") || token === "-") {
            pushPositional(token);
            continue;
        }
        if (token.startsWith("--")) {
            const separator = token.indexOf("=");
            const rawKey = token.slice(2, separator === -1 ? undefined : separator);
            const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
            const key = aliasMap[rawKey] ?? rawKey;
            if (booleanOptions.has(key)) {
                options[key] = inlineValue === undefined ? true : inlineValue !== "false";
                continue;
            }
            if (valueOptions.has(key)) {
                const nextValue = inlineValue ?? argv[index + 1];
                if (nextValue === undefined) {
                    throw new Error(`Missing value for --${rawKey}`);
                }
                options[key] = nextValue;
                if (inlineValue === undefined) {
                    index += 1;
                }
                continue;
            }
            // 未知の長いオプションは本文の始まりとみなす。以後のトークンからフラグを
            // 取り出すと、本文中の `--write` 等が解釈されてしまう（codex-runtime 契約）。
            pushPositional(token);
            continue;
        }
        const shortKey = token.slice(1);
        const key = aliasMap[shortKey] ?? shortKey;
        if (booleanOptions.has(key)) {
            options[key] = true;
            continue;
        }
        if (valueOptions.has(key)) {
            const nextValue = argv[index + 1];
            if (nextValue === undefined) {
                throw new Error(`Missing value for -${shortKey}`);
            }
            options[key] = nextValue;
            index += 1;
            continue;
        }
        // 未知の短いオプションも長いオプションと同様に本文の始まりとして扱う。
        pushPositional(token);
    }
    return { options: options, positionals };
}
export function splitRawArgumentString(raw) {
    const tokens = [];
    let current = "";
    let quote = null;
    for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index];
        if (character === "\\") {
            const next = raw[index + 1];
            // Windows のパス区切りは通常文字として保持する。引用符・空白・
            // バックスラッシュを明示的に escape した場合だけ escape と解釈する。
            if (next === "\\" || next === quote || (!quote && (next === "\"" || next === "'" || /\s/.test(next ?? "")))) {
                current += next;
                index += 1;
            }
            else {
                current += character;
            }
            continue;
        }
        if (quote) {
            if (character === quote) {
                quote = null;
            }
            else {
                current += character;
            }
            continue;
        }
        if (character === "'" || character === "\"") {
            quote = character;
            continue;
        }
        if (/\s/.test(character)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += character;
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}
