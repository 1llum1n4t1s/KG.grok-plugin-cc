import { AsyncLocalStorage } from "node:async_hooks";
import { ensureGitRepository } from "./git.mjs";

const WORKSPACE_DEADLINE = new AsyncLocalStorage();

/**
 * 同じ非同期処理からの間接的なGit再照会にも絶対期限を継承する。
 * scope外の処理には適用せず、入れ子から親の期限を延長しない。
 */
export function withWorkspaceDeadline(deadline, run) {
  if (!Number.isFinite(deadline)) throw new TypeError("Workspace deadline must be finite");
  const inherited = WORKSPACE_DEADLINE.getStore();
  return WORKSPACE_DEADLINE.run(Math.min(deadline, inherited ?? Infinity), run);
}

/** @param {{ deadline?: number, strict?: boolean }} options */
export function resolveWorkspaceRoot(cwd, options = {}) {
  const inherited = WORKSPACE_DEADLINE.getStore();
  if (inherited !== undefined) {
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
      throw new TypeError("Workspace deadline must be finite");
    }
    options = { ...options, deadline: Math.min(options.deadline ?? Infinity, inherited) };
  }
  try {
    return ensureGitRepository(cwd, options);
  } catch (error) {
    // 厳密な解決や期限付き解決の失敗で保存先をcwdへ変えてはならない。
    if ((options.strict || options.deadline !== undefined) && error?.code !== "GROK_NOT_GIT_REPOSITORY") throw error;
    return cwd;
  }
}
