import { execFile, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createIndependentPrFixtureEnv } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const templateDirs = useAutoCleanupTempDirTracker(afterAll);
let fixtureTemplate: ReturnType<typeof createFixtureTemplate> | undefined;
let reviewFixtureTemplate: ReturnType<typeof createReviewFixtureTemplate> | undefined;
const repoRoot = process.cwd();
const commonScript = join(repoRoot, "scripts/pr-lib/common.sh");
const worktreeScript = join(repoRoot, "scripts/pr-lib/worktree.sh");
const reviewScript = join(repoRoot, "scripts/pr-lib/review.sh");
const describePosix = process.platform === "win32" ? describe.skip : describe;
// Directly sourced helpers need the same Darwin heredoc protection as scripts/pr.
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const execFileAsync = promisify(execFile);
// Inject Git failures below the locked adapter covered by pr-worktree-provision.test.ts.
const provisionWorktreeFixture =
  'provision_pr_worktree() { pr_git -C "$1" worktree add -- "$1/.worktrees/pr-$2" "temp/pr-$2"; }';

type Fixture = {
  root: string;
  mainSha: string;
  siblingBranch: string;
  siblingSha: string;
};

type ReviewFixture = Fixture & {
  prASha: string;
  prBSha: string;
};

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function initTemplate() {
  const root = templateDirs.make("openclaw-pr-worktree-template-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "OpenClaw Test");
  git(root, "config", "user.email", "test@openclaw.invalid");
  return root;
}

function commitFiles(root: string, message: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(root, path), contents);
  }
  git(root, "add", ".");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function createFixtureTemplate() {
  const root = initTemplate();
  const mainSha = commitFiles(root, "main fixture", { "fixture.txt": "main\n" });
  return { root, mainSha };
}

function cloneFixture<T extends { root: string; mainSha: string }>(template: T, review = false) {
  const root = tempDirs.make("openclaw-pr-worktree-containment-");
  // Copy complete history before worktrees exist; each case owns its fetch and refs.
  cpSync(template.root, root, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
  git(root, "remote", "add", "origin", root);
  git(root, "fetch", "origin");
  git(root, "checkout", "-b", "sibling/work");
  const path = review ? "sibling.txt" : "fixture.txt";
  writeFileSync(join(root, path), "sibling\n");
  git(root, "add", path);
  git(root, "commit", "-am", "sibling fixture");
  return {
    ...template,
    root,
    siblingBranch: git(root, "branch", "--show-current"),
    siblingSha: git(root, "rev-parse", "HEAD"),
  };
}

function createFixture(): Fixture {
  return cloneFixture((fixtureTemplate ??= createFixtureTemplate()));
}

function createReviewFixtureTemplate() {
  const root = initTemplate();
  const baseSha = commitFiles(root, "base fixture", {
    "transition-a.txt": "base-a\n",
    "transition-b.txt": "base-b\n",
    "overlap.txt": "base-overlap\n",
  });
  git(root, "checkout", "-b", "review/pr", baseSha);
  const prASha = commitFiles(root, "PR head A", {
    "transition-a.txt": "pr-a\n",
    "transition-b.txt": "pr-b\n",
    "overlap.txt": "pr-a-overlap\n",
    "pr-only.txt": "removed on main\n",
  });
  const prBSha = commitFiles(root, "PR head B", { "overlap.txt": "pr-b-overlap\n" });
  git(root, "update-ref", "refs/pull/42/head", prASha);

  git(root, "checkout", "main");
  const mainSha = commitFiles(root, "advance main fixture", { "main-only.txt": "main-only\n" });
  return { root, mainSha, prASha, prBSha };
}

function createReviewFixture(): ReviewFixture {
  return cloneFixture((reviewFixtureTemplate ??= createReviewFixtureTemplate()), true);
}

function reviewCase() {
  const fixture = createReviewFixture();
  return { fixture, worktree: join(fixture.root, ".worktrees", "pr-42") };
}

function expectSuccess(result: ReturnType<typeof runShell>) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function transitionSetup(mode = "detached", branch = "''") {
  return [
    "review_init 42",
    "review_checkout_pr 42",
    "source_sha=$(git rev-parse HEAD)",
    "target_sha=$(git rev-parse origin/main)",
    `write_review_transition_journal 42 "$source_sha" "$target_sha" ${mode} ${branch}`,
  ];
}

function expectRefused(fixture: Fixture, result: ReturnType<typeof runShell>, message: string) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  expect(result.stderr).toContain(message);
  expectCanonicalCheckoutUnchanged(fixture);
}

function expectFile(root: string, path: string, content: string) {
  expect(readFileSync(join(root, path), "utf8")).toBe(content);
}

function expectPreserved(
  fixture: Fixture,
  worktree: string,
  command = "review_init 42",
  message = "Refusing scripts/pr transition for PR #42",
) {
  const before = reviewState(worktree);
  const result = runShell(fixture, [command]);
  expectRefused(fixture, result, message);
  expect(reviewState(worktree)).toEqual(before);
  return result;
}

function addSiblingWorktrees(fixture: Fixture) {
  const path = (pr: number) => join(fixture.root, `.worktrees/pr-${pr}`);
  for (const pr of [42, 99]) {
    git(fixture.root, "worktree", "add", "-b", `temp/pr-${pr}`, path(pr), fixture.mainSha);
  }
  return { worktree: path(42), sibling: path(99) };
}

function runShell(fixture: Fixture, commands: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(
    bash,
    [
      "-c",
      [
        "set -euo pipefail",
        'source "$1"',
        'source "$2"',
        'source "$3"',
        'fixture_root="$4"',
        'script_parent_dir="$fixture_root"',
        `pr_gh_plain() { [ "$*" = writer-login ] || return 99; printf 'fixture-user\\n'; }`,
        "mark_pr_operation_side_effects_started() { :; }",
        provisionWorktreeFixture,
        'pr_meta_json() { local head base; head=$(git rev-parse refs/pull/42/head); base=$(git rev-parse refs/heads/main); jq -cn --arg head "$head" --arg base "$base" \'{number:42,title:"fixture",url:"https://github.com/fixture/repo/pull/42",state:"OPEN",isDraft:false,author:{login:"fixture"},baseRefName:"main",baseRefOid:$base,baseRepository:{id:"R_fixture",databaseId:1,nameWithOwner:"fixture/repo",url:"https://github.com/fixture/repo"},isCrossRepository:false,headRefName:"review/pr",headRefOid:$head,headRepository:{nameWithOwner:"fixture/repo",url:""},headRepositoryOwner:{login:"fixture"},additions:1,deletions:0,changedFiles:3}\'; }',
        'pr_gh() { if [ "$#" = 5 ] && [ "$1 $2 $3 $4" = "pr view 42 --json" ]; then pr_meta_json 42 | jq --arg fields "$5" \'with_entries(select(.key as $key | $fields | split(",") | index($key)))\'; else echo "Unexpected fixture GitHub request" >&2; return 99; fi; }',
        ...commands,
      ].join("\n"),
      "pr-worktree-containment",
      commonScript,
      worktreeScript,
      reviewScript,
      fixture.root,
    ],
    { cwd: fixture.root, encoding: "utf8", env: { ...createIndependentPrFixtureEnv(), ...env } },
  );
}

function expectCanonicalCheckoutUnchanged(fixture: Fixture) {
  expect(git(fixture.root, "branch", "--show-current")).toBe(fixture.siblingBranch);
  expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.siblingSha);
}

function traceEntryCommands(failure: string, code = 73) {
  return [
    "trace_command() {",
    '  printf "%s\\n" "$*" >> "$fixture_root/commands.log"',
    `  if ${failure}; then`,
    '    printf "FAIL %s\\n" "$*" >> "$fixture_root/commands.log"',
    '    if [ "$1" = pwd ]; then command "$@"; fi',
    `    return ${code}`,
    "  fi",
    "}",
    ...["git", "cd", "pwd", "mkdir", "rm", "mv", "trash"].map(
      (name) =>
        `${name === "git" ? "pr_git" : name}() { trace_command ${name} "$@" || return $?; command ${name} "$@"; }`,
    ),
    "pr_gh_plain() {",
    "  local status=0",
    '  trace_command gh_plain "$@" || status=$?',
    '  if [ "$status" -ne 0 ]; then',
    "    echo 'Fixture writer identity unavailable.' >&2",
    '    return "$status"',
    "  fi",
    '  [ "$*" = writer-login ] || return 99',
    "  printf 'fixture-user\\n'",
    "}",
  ];
}

function expectEntryStopped(fixture: Fixture, result: ReturnType<typeof runShell>) {
  const commands = readFileSync(join(fixture.root, "commands.log"), "utf8").trim().split("\n");
  const failure = commands.findIndex((command) => command.startsWith("FAIL "));
  expect(failure, commands.join("\n")).toBeGreaterThanOrEqual(0);
  expect.soft(commands.slice(failure + 1), commands.join("\n")).toEqual([]);
  expect.soft(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  expectCanonicalCheckoutUnchanged(fixture);
}

function reviewState(worktree: string) {
  return {
    head: git(worktree, "rev-parse", "HEAD"),
    branch: git(worktree, "branch", "--show-current"),
    index: git(worktree, "write-tree"),
    resolveUndo: git(worktree, "ls-files", "--resolve-undo"),
    status: git(worktree, "status", "--porcelain=v1"),
    diff: git(worktree, "diff", "HEAD"),
    journal: existsSync(join(worktree, ".local", "review-transition.json"))
      ? readFileSync(join(worktree, ".local", "review-transition.json"), "utf8")
      : null,
  };
}

describePosix("scripts/pr worktree containment", () => {
  it("refreshes warm and cold PRs concurrently while another Git transaction owns shared main", async () => {
    const fixture = createFixture();
    git(fixture.root, "worktree", "add", "--detach", ".worktrees/pr-42", fixture.mainSha);
    git(fixture.root, "update-ref", "refs/heads/main", fixture.siblingSha);
    const fetchHead = join(fixture.root, ".git", "FETCH_HEAD");
    const previousFetch = readFileSync(fetchHead, "utf8");
    const writer = spawn("git", ["update-ref", "--stdin"], { cwd: fixture.root });
    let writerOutput = "";
    writer.stderr.on("data", (chunk) => {
      writerOutput += chunk;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("close", resolve);
    });
    const prepared = new Promise<void>((resolve) => {
      writer.stdout.on("data", (chunk) => {
        writerOutput += chunk;
        if (writerOutput.includes("prepare: ok\n")) {
          resolve();
        }
      });
    });
    writer.stdin.write(
      `start\nupdate refs/remotes/origin/main ${fixture.siblingSha} ${fixture.mainSha}\nprepare\n`,
    );
    try {
      await Promise.race([
        prepared,
        closed.then((code) => {
          throw new Error(
            `Shared ref transaction exited before preparation: ${code}\n${writerOutput}`,
          );
        }),
      ]);
      await Promise.all(
        [42, 43].map((pr) =>
          execFileAsync(
            bash,
            [
              "-c",
              `set -euo pipefail\nsource "$1"\nsource "$2"\nsource "$3"\nscript_parent_dir="$4"\npr_gh_plain() { [ "$*" = writer-login ] || return 99; printf 'fixture-user\\n'; }\nmark_pr_operation_side_effects_started() { :; }\n${provisionWorktreeFixture}\nreview_checkout_main "$5"`,
              "pr-concurrency",
              commonScript,
              worktreeScript,
              reviewScript,
              fixture.root,
              String(pr),
            ],
            { cwd: fixture.root, env: createIndependentPrFixtureEnv() },
          ),
        ),
      );
      expect(writer.exitCode).toBeNull();
      expect(readFileSync(fetchHead, "utf8")).toBe(previousFetch);
      expect(git(fixture.root, "rev-parse", "refs/remotes/origin/main")).toBe(fixture.mainSha);
      for (const pr of [42, 43]) {
        const worktree = join(fixture.root, ".worktrees", `pr-${pr}`);
        expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.siblingSha);
        expect(git(worktree, "status", "--porcelain", "--untracked-files=no")).toBe("");
      }
      expectCanonicalCheckoutUnchanged(fixture);
    } finally {
      writer.stdin.end("abort\n");
      await closed;
    }
  });

  it.each([
    {
      name: "private fetch interrupted",
      failure: '[[ "$*" == *" fetch "* ]] && [ "$PWD" = "$fixture_root/.worktrees/pr-42" ]',
      code: 130,
    },
    { name: "GitHub auth failure", failure: '[ "$1" = gh_plain ]', code: 1 },
  ])(`stops on $name without replaying a pending transition (OR list)`, ({ failure, code }) => {
    const { fixture, worktree } = reviewCase();
    const setup = runShell(fixture, [
      "review_init 42",
      "review_checkout_pr 42",
      "git checkout -B temp/pr-42",
      `write_review_transition_journal 42 ${fixture.prASha} ${fixture.mainSha} branch temp/pr-42`,
      `git restore --source=${fixture.mainSha} --staged --worktree -- transition-a.txt`,
    ]);
    expect(setup.status, `${setup.stdout}\n${setup.stderr}`).toBe(0);
    const before = reviewState(worktree);
    const result = runShell(fixture, [
      ...traceEntryCommands(failure, code),
      "enter_worktree 42 true || exit $?",
    ]);

    expectEntryStopped(fixture, result);
    expect(reviewState(worktree)).toEqual(before);
    if (failure.includes("gh_plain")) {
      expect(result.stderr).toContain("Fixture writer identity unavailable.");
    }
  });

  it("stops cold entry on second-fetch failure, retaining completed provisioning", () => {
    const fixture = createFixture();
    const worktree = join(fixture.root, ".worktrees", "pr-42");
    const result = runShell(fixture, [
      ...traceEntryCommands(
        '[[ "$*" == *" fetch "* ]] && [ "$PWD" = "$fixture_root/.worktrees/pr-42" ]',
        130,
      ),
      "enter_worktree 42 true || exit $?",
    ]);
    expectEntryStopped(fixture, result);
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(join(worktree, ".local"))).toBe(false);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.mainSha);
    expect(git(worktree, "branch", "--show-current")).toBe("temp/pr-42");
  });

  it.each([
    {
      name: "worktree cd",
      failure: '[ "$*" = "cd $fixture_root/.worktrees/pr-42" ] && [ "$BASH_SUBSHELL" = 0 ]',
      setup: [],
    },
    {
      name: "warm Git identity read",
      failure: '[ "$*" = "git rev-parse --path-format=absolute --git-dir --git-common-dir" ]',
      setup: ["git worktree add .worktrees/pr-42 -b temp/pr-42 origin/main"],
    },
  ])("stops required entry steps on $name failure in an OR list", ({ failure, setup }) => {
    const fixture = createFixture();
    const result = runShell(fixture, [
      ...setup,
      ...traceEntryCommands(failure),
      "enter_worktree 42 false || exit $?",
    ]);
    expectEntryStopped(fixture, result);
    expect(existsSync(join(fixture.root, ".worktrees", "pr-42", ".local"))).toBe(false);
  });

  it("preserves an unregistered orphan instead of trashing it during provisioning", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.root, ".worktrees/pr-42"), { recursive: true });
    const marker = join(fixture.root, ".worktrees", "pr-42", "foreign-note");
    writeFileSync(marker, "preserve me\n");
    const result = runShell(fixture, [
      ...traceEntryCommands("false"),
      "enter_worktree 42 true || exit $?",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    const commands = readFileSync(join(fixture.root, "commands.log"), "utf8");
    expect(commands).not.toMatch(/(?:worktree (?:prune|remove|add)|trash| fetch )/);
    expect(result.stderr).toContain("unregistered or ambiguous PR worktree");
    expectCanonicalCheckoutUnchanged(fixture);
    expectFile(fixture.root, ".worktrees/pr-42/foreign-note", "preserve me\n");
  });

  it("refuses a symlink alias pointing at another PR's worktree", () => {
    const fixture = createFixture();
    const worktrees = join(fixture.root, ".worktrees");
    mkdirSync(worktrees, { recursive: true });
    git(
      fixture.root,
      "worktree",
      "add",
      join(worktrees, "pr-99"),
      "-b",
      "temp/pr-99",
      "origin/main",
    );
    symlinkSync("pr-99", join(worktrees, "pr-42"), "dir");

    const result = runShell(fixture, ["enter_worktree 42 true"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-canonical PR-worktree path");
    expect(git(join(worktrees, "pr-99"), "branch", "--show-current")).toBe("temp/pr-99");
    expectCanonicalCheckoutUnchanged(fixture);
  });

  for (const operation of [
    { name: "ordinary entry", command: "enter_worktree 42 false", success: true },
    {
      name: "destructive cleanup",
      command: 'remove_worktree_if_present ".worktrees/pr-42"',
      success: false,
    },
  ]) {
    it.each(operation.success ? ["unreadable"] : ["missing", "unreadable"])(
      `${operation.name} preserves an unrelated worktree with a %s backlink`,
      (damage) => {
        const fixture = createReviewFixture();
        const { worktree, sibling } = addSiblingWorktrees(fixture);
        const admin = git(sibling, "rev-parse", "--absolute-git-dir");
        const backlink = join(admin, "gitdir");
        writeFileSync(join(sibling, "marker"), "preserve sibling\n");
        if (damage === "missing") {
          rmSync(backlink);
        } else {
          // Inject EACCES so this guard is also exercised when tests run as root.
          writeFileSync(
            join(fixture.root, "deny-backlink.cjs"),
            [
              'const fs = require("node:fs");',
              "const readFileSync = fs.readFileSync;",
              "fs.readFileSync = function(file, ...args) {",
              `  if (file === ${JSON.stringify(backlink)}) {`,
              '    throw Object.assign(new Error("fixture denied backlink"), { code: "EACCES" });',
              "  }",
              "  return readFileSync.call(this, file, ...args);",
              "};",
            ].join("\n"),
          );
        }
        const retainedBacklink = existsSync(backlink) ? readFileSync(backlink) : null;
        const result = runShell(fixture, [
          ...traceEntryCommands("false"),
          ...(damage === "unreadable"
            ? ['node() { command node --require "$fixture_root/deny-backlink.cjs" "$@"; }']
            : []),
          `${operation.command} || exit $?`,
          "echo operation-completed",
        ]);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(operation.success ? 0 : 1);
        expect(result.stdout.includes("operation-completed")).toBe(operation.success);
        const commands = readFileSync(join(fixture.root, "commands.log"), "utf8");
        expect(commands).not.toMatch(/worktree (?:prune|remove|add)|trash|branch -D/u);
        if (operation.success) {
          expect(commands).toContain("git worktree list --porcelain -z");
          expect(commands).toContain(
            "git rev-parse --path-format=absolute --git-dir --git-common-dir",
          );
          expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.mainSha);
        } else {
          expect(commands).not.toContain(" fetch ");
          expect(result.stderr).toContain(
            damage === "unreadable" ? "EACCES" : "damaged worktree metadata",
          );
        }
        expect(existsSync(worktree)).toBe(true);
        expect(existsSync(admin)).toBe(true);
        expect(existsSync(backlink) ? readFileSync(backlink) : null).toEqual(retainedBacklink);
        expect(git(sibling, "rev-parse", "HEAD")).toBe(fixture.mainSha);
        expect(git(sibling, "branch", "--show-current")).toBe("temp/pr-99");
        expectFile(sibling, "marker", "preserve sibling\n");
        expectCanonicalCheckoutUnchanged(fixture);
      },
    );
  }

  it.each(["gitfile-symlink", "other-admin", "backlink", "commondir"])(
    "refuses warm entry with invalid target-local identity (%s)",
    (fault) => {
      const fixture = createFixture();
      const { worktree, sibling } = addSiblingWorktrees(fixture);
      const admin = git(worktree, "rev-parse", "--absolute-git-dir");
      const siblingGitfile = readFileSync(join(sibling, ".git"));
      if (fault === "gitfile-symlink") {
        rmSync(join(worktree, ".git"));
        symlinkSync(join(sibling, ".git"), join(worktree, ".git"));
      } else if (fault === "other-admin") {
        writeFileSync(join(worktree, ".git"), siblingGitfile);
      } else if (fault === "backlink") {
        writeFileSync(join(admin, "gitdir"), `${sibling}/.git\n`);
      } else {
        writeFileSync(join(admin, "commondir"), `${fixture.root}/unrelated.git\n`);
      }
      const result = runShell(fixture, [
        ...traceEntryCommands("false"),
        "enter_worktree 42 true || exit $?",
        "echo unexpected-entry-completed",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(result.stdout).not.toContain("unexpected-entry-completed");
      expect(readFileSync(join(fixture.root, "commands.log"), "utf8")).not.toMatch(
        /worktree (?:prune|remove|add)|trash| fetch |checkout /u,
      );
      expect(readFileSync(join(sibling, ".git"))).toEqual(siblingGitfile);
      expect(git(sibling, "branch", "--show-current")).toBe("temp/pr-99");
      expectCanonicalCheckoutUnchanged(fixture);
    },
  );

  it("recovers an interrupted transition before repeated init, main, and PR checkout", () => {
    const { fixture, worktree } = reviewCase();

    const result = runShell(fixture, [
      "review_init 42",
      "review_checkout_main 42",
      "review_checkout_pr 42",
      'printf "preserve me\\n" > .local/review-note',
      "source_sha=$(git rev-parse HEAD)",
      "target_sha=$(git rev-parse origin/main)",
      'jq -cn --arg source "$source_sha" --arg target "$target_sha" \'{version:1,pr:42,source:$source,target:$target,mode:"detached",branch:null}\' > .local/review-transition.json',
      'git restore --source="$target_sha" --staged --worktree -- transition-a.txt main-only.txt',
      'git update-ref --no-deref HEAD "$target_sha" "$source_sha"',
      `git -C "$fixture_root" update-ref refs/pull/42/head ${fixture.prBSha}`,
      "review_init 42",
      "review_checkout_main 42",
      "review_checkout_pr 42",
    ]);

    expectSuccess(result);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.prBSha);
    expect(git(worktree, "status", "--short", "--untracked-files=no")).toBe("");
    expectFile(worktree, ".local/review-note", "preserve me\n");
    expect(existsSync(join(worktree, ".local/review-transition.json"))).toBe(false);
    expectCanonicalCheckoutUnchanged(fixture);
  });

  it.each([
    {
      name: "worktree writes before the index commit",
      setup: [
        'git restore --source="$target_sha" --worktree -- transition-a.txt main-only.txt pr-only.txt',
        'git diff --cached --quiet "$source_sha"',
      ],
    },
    {
      name: "partially restored index",
      setup: ['git restore --source="$target_sha" --staged --worktree -- pr-only.txt'],
    },
    {
      name: "interrupted recovery checkout",
      setup: [
        "original_pr_git=$(declare -f pr_git)",
        'pr_git() { if [ "${1:-}" = checkout ]; then return 73; fi; command git "$@"; }',
        "if recover_review_transition 42; then exit 1; fi",
        'eval "$original_pr_git"',
        'git diff --cached --quiet "$target_sha"',
      ],
    },
    {
      name: "target index with source worktree entries",
      setup: [
        'git restore --source="$target_sha" --staged -- .',
        'git diff --cached --quiet "$target_sha"',
        "test -f pr-only.txt",
        "test ! -e main-only.txt",
      ],
      sourceWorktree: true,
    },
  ])(`recovers $name (branch)`, ({ setup, sourceWorktree }) => {
    const { fixture, worktree } = reviewCase();
    const result = runShell(fixture, [
      ...transitionSetup("branch", "temp/pr-42"),
      'printf "preserve me\\n" > .local/review-note',
      ...setup,
      ...(sourceWorktree ? [] : ["test ! -e pr-only.txt"]),
      'test "$(git rev-parse HEAD)" = "$source_sha"',
      "test -f .local/review-transition.json",
      "recover_review_transition 42",
    ]);

    expectSuccess(result);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.mainSha);
    expect(git(worktree, "branch", "--show-current")).toBe("temp/pr-42");
    expect(git(worktree, "status", "--porcelain=v1", "--untracked-files=no")).toBe("");
    expect(existsSync(join(worktree, "pr-only.txt"))).toBe(false);
    expect(existsSync(join(worktree, ".local/review-transition.json"))).toBe(false);
    expectCanonicalCheckoutUnchanged(fixture);
    expectFile(worktree, ".local/review-note", "preserve me\n");
    if (sourceWorktree) {
      expectFile(worktree, "main-only.txt", "main-only\n");
    }
  });

  it.each([
    ["staged", "overlap.txt", "foreign staged", "M  overlap.txt"],
    ["unstaged", "overlap.txt", "foreign unstaged", "M overlap.txt"],
    ["untracked", "foreign.txt", "foreign untracked", "?? foreign.txt"],
    [
      "untracked target path with foreign bytes",
      "main-only.txt",
      "foreign addition",
      "?? main-only.txt",
    ],
    [
      "BOM-prefixed untracked target lookalike",
      "\ufeffmain-only.txt",
      "foreign BOM",
      "main-only.txt",
    ],
  ])("refuses and preserves %s foreign state", (name, path, content, expectedStatus) => {
    const { fixture, worktree } = reviewCase();
    const result = runShell(fixture, [
      ...transitionSetup(),
      'git restore --source="$target_sha" --staged --worktree -- transition-a.txt',
      ...(name.startsWith("BOM")
        ? ['printf "/.local/\\n" >> "$(git rev-parse --git-path info/exclude)"']
        : []),
      `printf '${content}\\n' > '${path}'`,
      ...(name === "staged" ? ["git add overlap.txt"] : []),
      "git status --porcelain=v1 > .local/expected-status",
      "review_init 42",
    ]);

    expectRefused(fixture, result, "Refusing scripts/pr transition for PR #42");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.prASha);
    expect(git(worktree, "status", "--porcelain=v1")).toBe(
      readFileSync(join(worktree, ".local", "expected-status"), "utf8").trim(),
    );
    expect(git(worktree, "status", "--short")).toContain(expectedStatus);
    expect(readFileSync(join(worktree, path), "utf8")).toBe(`${content}\n`);
    expect(existsSync(join(worktree, ".local", "review-transition.json"))).toBe(true);
  });

  it.each([
    "executable bit",
    "symlink",
    "assume-unchanged",
    "intent-to-add",
    "resolve-undo",
  ] as const)("refuses and preserves foreign %s metadata", (metadata) => {
    const { fixture, worktree } = reviewCase();
    if (metadata === "intent-to-add") {
      git(fixture.root, "checkout", "main");
      writeFileSync(join(fixture.root, "main-only.txt"), "");
      git(fixture.root, "commit", "-am", "empty target fixture");
      fixture.mainSha = git(fixture.root, "rev-parse", "HEAD");
      git(fixture.root, "checkout", fixture.siblingBranch);
    }
    const setups: Record<typeof metadata, string[]> = {
      "executable bit": ["chmod +x overlap.txt"],
      symlink: ["rm overlap.txt", "ln -s $'pr-a-overlap\\n' overlap.txt"],
      "assume-unchanged": [
        "git update-index --assume-unchanged overlap.txt",
        'printf "foreign hidden\\n" > overlap.txt',
      ],
      "intent-to-add": [": > main-only.txt", "git add --intent-to-add main-only.txt"],
      "resolve-undo": [
        `base_blob=$(git rev-parse ${fixture.mainSha}:overlap.txt)`,
        `ours_blob=$(git rev-parse ${fixture.prASha}:overlap.txt)`,
        'printf "0 %040d\\toverlap.txt\\n100644 %s 1\\toverlap.txt\\n100644 %s 2\\toverlap.txt\\n100644 %s 3\\toverlap.txt\\n" 0 "$base_blob" "$ours_blob" "$base_blob" | git update-index --index-info',
        "git add overlap.txt",
        'test -n "$(git ls-files --resolve-undo)"',
      ],
    };
    expectSuccess(runShell(fixture, [...transitionSetup(), ...setups[metadata]]));
    const pathname = join(worktree, "overlap.txt");
    const readOverlap = () =>
      metadata === "symlink" ? readlinkSync(pathname) : readFileSync(pathname, "utf8");
    const bytes = readOverlap();
    expectPreserved(fixture, worktree);
    expect(readOverlap()).toBe(bytes);
  });

  it.each([
    { name: "file" },
    { name: "file during recovery", recovery: true },
    { name: "dangling symlink", symlink: true },
    { name: "file ancestor", ancestor: true },
    { name: "dangling symlink ancestor", symlink: true, ancestor: true },
    { name: "directory symlink ancestor", symlink: true, ancestor: true, directoryTarget: true },
    {
      name: "directory containing ignored data",
      path: "main-only.txt/private.ignored",
      directory: true,
    },
  ])(
    "preserves an ignored $name before mutation",
    ({
      recovery = false,
      path = "main-only.txt",
      directory = false,
      symlink = false,
      ancestor = false,
      directoryTarget = false,
    }) => {
      const fixture = createReviewFixture();
      if (ancestor) {
        git(fixture.root, "checkout", "main");
        rmSync(join(fixture.root, "main-only.txt"));
        mkdirSync(join(fixture.root, "main-only.txt", "nested"), { recursive: true });
        writeFileSync(join(fixture.root, "main-only.txt", "nested", "child.txt"), "target\n");
        git(fixture.root, "add", "-A");
        git(fixture.root, "commit", "-m", "directory target fixture");
        fixture.mainSha = git(fixture.root, "rev-parse", "HEAD");
        git(fixture.root, "checkout", fixture.siblingBranch);
      }
      const linkTarget = directoryTarget ? ".local/link-target" : "missing";
      const worktree = join(fixture.root, ".worktrees", "pr-42");
      const setup = runShell(fixture, [
        "review_init 42",
        "review_checkout_pr 42",
        ...(recovery
          ? [
              `write_review_transition_journal 42 ${fixture.prASha} ${fixture.mainSha} detached ''`,
              `git restore --source=${fixture.mainSha} --staged --worktree -- transition-a.txt`,
            ]
          : []),
        `printf '%s\\n' '${path}' >> "$(git rev-parse --git-path info/exclude)"`,
        ...(directory ? ["mkdir main-only.txt"] : []),
        "mkdir -p .local/link-target",
        "printf 'unrelated target data\\n' > .local/link-target/private",
        symlink ? `ln -s '${linkTarget}' '${path}'` : `printf 'foreign ignored\\n' > '${path}'`,
      ]);
      expectSuccess(setup);
      expectPreserved(
        fixture,
        worktree,
        recovery ? "review_init 42" : "review_checkout_main 42",
        `ignored file '${path}' would be overwritten`,
      );
      const preserved = join(worktree, path);
      expect(symlink ? readlinkSync(preserved) : readFileSync(preserved, "utf8")).toBe(
        symlink ? linkTarget : "foreign ignored\n",
      );
      expectFile(worktree, ".local/link-target/private", "unrelated target data\n");
    },
  );

  it("refuses the reserved transition path .local/review-mode.env", () => {
    const path = ".local/review-mode.env";
    const fixture = createReviewFixture();
    git(fixture.root, "checkout", "review/pr");
    mkdirSync(join(fixture.root, ".local"));
    writeFileSync(join(fixture.root, path), "not an owned artifact\n");
    git(fixture.root, "add", "-f", "--", path);
    git(fixture.root, "commit", "-m", "reserved namespace fixture");
    git(fixture.root, "update-ref", "refs/pull/42/head", "HEAD");
    git(fixture.root, "checkout", fixture.siblingBranch);
    const setup = runShell(fixture, ["review_init 42"]);
    expect(setup.status, setup.stdout + setup.stderr).toBe(0);
    const worktree = join(fixture.root, ".worktrees", "pr-42");
    const before = reviewState(worktree);
    const artifact = readFileSync(join(worktree, ".local", "review-mode.env"), "utf8");
    const result = runShell(fixture, ["review_checkout_pr 42"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reserved .local artifact namespace");
    expect(reviewState(worktree)).toEqual(before);
    expectFile(worktree, ".local/review-mode.env", artifact);
    expectCanonicalCheckoutUnchanged(fixture);
  });

  it.each([false, true])("bounds literal transition queries (collision=%s)", (collision) => {
    const fixture = createReviewFixture();
    git(fixture.root, "checkout", "review/pr");
    for (let index = 0; index < 192; index += 1) {
      const name = `transition-batch-${index}-${"x".repeat(180)}.txt`;
      writeFileSync(join(fixture.root, name), `${index}\n`);
    }
    const literalPath = "zz-transition-[literal]*?\n雪\\name.txt";
    writeFileSync(join(fixture.root, literalPath), "literal path\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "add transition batch");
    git(fixture.root, "update-ref", "refs/pull/42/head", "HEAD");
    git(fixture.root, "checkout", fixture.siblingBranch);

    const worktree = join(fixture.root, ".worktrees", "pr-42");
    const setup = runShell(fixture, ["review_init 42"]);
    expect(setup.status, setup.stdout + setup.stderr).toBe(0);
    writeFileSync(git(worktree, "rev-parse", "--git-path", "info/exclude"), "zz-*\n");
    const lookalike = join(worktree, "zz-transition-literal1\n雪\\name.txt");
    writeFileSync(lookalike, "unrelated ignored data\n");
    if (collision) {
      writeFileSync(join(worktree, literalPath), "foreign ignored\n");
    }
    const before = reviewState(worktree);
    const tools = join(fixture.root, "tools");
    const commandLog = join(fixture.root, "git-commands.log");
    mkdirSync(tools);
    const realGit = spawnSync("bash", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      join(tools, "git"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$1" >> "$GIT_COMMAND_LOG"',
        'if [ "${1:-}" = ls-files ] && [ "${3:-}" = --ignored ]; then',
        '  printf "ignored-query\\n" >> "$GIT_COMMAND_LOG"',
        '  bytes=0; for arg in "$@"; do bytes=$((bytes + ${#arg} + 1)); done',
        '  if [ "$bytes" -gt 32768 ]; then exit 126; fi',
        "fi",
        'if [[ ( "${1:-}" == "restore" || "${2:-}" == "restore" ) && "$#" -gt 12 ]]; then',
        '  printf "%s\\n" "Argument list too long" >&2',
        "  exit 126",
        "fi",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
    );
    chmodSync(join(tools, "git"), 0o755);

    const result = runShell(fixture, ["review_checkout_pr 42"], {
      GIT_COMMAND_LOG: commandLog,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      REAL_GIT: realGit,
      LC_ALL: "C",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(collision ? 1 : 0);
    const commands = readFileSync(commandLog, "utf8").trim().split("\n");
    const queries = commands.filter((command) => command === "ignored-query").length;
    expect(queries).toBeGreaterThan(1);
    expect(queries).toBeLessThan(16);
    expectFile(worktree, literalPath, collision ? "foreign ignored\n" : "literal path\n");
    expect(readFileSync(lookalike, "utf8")).toBe("unrelated ignored data\n");
    if (collision) {
      expect(result.stderr).toContain(`ignored file '${literalPath}' would be overwritten`);
      expect(reviewState(worktree)).toEqual(before);
    }
    expectCanonicalCheckoutUnchanged(fixture);
  });
});
