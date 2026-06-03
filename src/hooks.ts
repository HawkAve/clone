import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";

// A transaction hook, modelled on alpm-hooks(5). Lives as a JSON file in the
// hooks dir (~/.config/clone/hooks/*.json):
//   {
//     "description": "refresh font cache",
//     "on": ["install", "update"],   // events to match
//     "when": "post",                 // "pre" | "post"  (default "post")
//     "exec": "fc-cache -f",          // shell command (sh -c)
//     "abortOnFail": false            // pre-only: abort the transaction if it fails
//   }
// The command runs with $CLONE_REPO, $CLONE_EVENT, $CLONE_WHEN in its env, and
// cwd = the repo dir when available.
export type HookEvent = "install" | "update" | "remove";
export type HookWhen = "pre" | "post";

export interface Hook {
  name: string;
  description?: string;
  on: HookEvent[];
  when: HookWhen;
  exec: string;
  abortOnFail?: boolean;
}

export function loadHooks(hooksDir: string): Hook[] {
  if (!existsSync(hooksDir)) return [];
  const hooks: Hook[] = [];
  for (const file of readdirSync(hooksDir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(hooksDir, file), "utf-8"));
      const on = (Array.isArray(raw.on) ? raw.on : [raw.on]).filter(
        (e: any): e is HookEvent =>
          e === "install" || e === "update" || e === "remove"
      );
      if (!on.length || typeof raw.exec !== "string") continue;
      hooks.push({
        name: file,
        description: typeof raw.description === "string" ? raw.description : undefined,
        on,
        when: raw.when === "pre" ? "pre" : "post",
        exec: raw.exec,
        abortOnFail: !!raw.abortOnFail,
      });
    } catch {
      console.error(chalk.yellow(`  hook: skipping malformed ${file}`));
    }
  }
  return hooks;
}

// Run hooks matching (event, when). Returns false only if a `pre` hook with
// abortOnFail fails — the caller should then abort the transaction. `post` hooks
// must only be invoked after the transaction succeeds (alpm-hooks semantics).
export function runHooks(
  hooks: Hook[],
  event: HookEvent,
  when: HookWhen,
  ctx: { repo: string; cwd?: string }
): boolean {
  const matching = hooks.filter((h) => h.when === when && h.on.includes(event));
  for (const h of matching) {
    console.log(
      chalk.dim(`  hook(${when} ${event}): ${h.description || h.name}`)
    );
    try {
      execSync(h.exec, {
        stdio: "inherit",
        cwd: ctx.cwd && existsSync(ctx.cwd) ? ctx.cwd : process.cwd(),
        env: {
          ...process.env,
          CLONE_REPO: ctx.repo,
          CLONE_EVENT: event,
          CLONE_WHEN: when,
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (when === "pre" && h.abortOnFail) {
        console.error(chalk.red(`  hook ${h.name} failed (abortOnFail): ${msg}`));
        return false;
      }
      console.error(chalk.yellow(`  hook ${h.name} failed: ${msg}`));
    }
  }
  return true;
}
