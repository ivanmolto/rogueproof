// Offline: the docker CLI is replaced by a recording fake, and the real Runner
// is exercised against `node` instead of `docker`.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COMMAND_TIMEOUT_S, CONTAINER_NAME, OUTPUT_CAP_BYTES, RUN_WRAPPER, WRITE_CAP_BYTES, createDockerSandbox, resolveWorkPath } from "./docker.js";
import { composeHostEnv, createRunner, type ExecRequest, type ExecResult, type Runner } from "./exec.js";

const done = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, output: "", timedOut: false, truncated: false, ...over });

function fake(result: Partial<ExecResult> = {}): { runner: Runner; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  return {
    calls,
    runner: async (req) => {
      calls.push(req);
      return done(result);
    },
  };
}

describe("resolveWorkPath", () => {
  it("resolves workspace-relative and /work-absolute paths", () => {
    expect(resolveWorkPath("REPORT.md")).toEqual({ ok: true, path: "/work/REPORT.md" });
    expect(resolveWorkPath("./notes/../.env")).toEqual({ ok: true, path: "/work/.env" });
    expect(resolveWorkPath("/work/a/b.txt")).toEqual({ ok: true, path: "/work/a/b.txt" });
  });

  it("refuses anything outside /work", () => {
    for (const p of ["", "..", "../etc/passwd", "/etc/passwd", "/work", ".", "a/../../x", "/workspace/x", "a\0b"]) {
      expect(resolveWorkPath(p).ok, JSON.stringify(p)).toBe(false);
    }
  });

  it("never throws and never leaves /work (fuzz)", () => {
    const segment = fc.oneof(fc.constantFrom("..", ".", "", "/", "work", "/work", "~", "\0", "a b", "$(id)", "-rf"), fc.string());
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.array(segment, { maxLength: 8 }).map((s) => s.join("/"))), (input) => {
        const r = resolveWorkPath(input);
        if (r.ok) {
          expect(r.path.startsWith("/work/")).toBe(true);
          expect(r.path.split("/")).not.toContain("..");
          expect(r.path).not.toContain("\0");
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("docker sandbox tools", () => {
  it("read_file is `cat` inside the container, capped", async () => {
    const f = fake({ output: "hello\n" });
    const res = await createDockerSandbox({ runner: f.runner }).readFile("MISSION.md");
    expect(res).toEqual({ ok: true, output: "hello\n" });
    expect(f.calls[0]?.argv).toEqual(["exec", "-w", "/work", CONTAINER_NAME, "cat", "--", "/work/MISSION.md"]);
    expect(f.calls[0]?.maxBytes).toBe(OUTPUT_CAP_BYTES);
    expect(f.calls[0]?.stdin).toBeUndefined();
  });

  it("read_file reports a missing file as a failed tool call", async () => {
    const f = fake({ code: 1, output: "cat: /work/nope: No such file or directory\n" });
    const res = await createDockerSandbox({ runner: f.runner }).readFile("nope");
    expect(res.ok).toBe(false);
    expect(res.output).toContain("No such file");
  });

  it("write_file sends the content on stdin and the path as an argument", async () => {
    const f = fake();
    const content = 'line 1\n"; rm -rf / #\n';
    const res = await createDockerSandbox({ runner: f.runner }).writeFile("out/$(id).md", content);
    expect(res).toEqual({ ok: true, output: `wrote ${Buffer.byteLength(content)} bytes to out/$(id).md` });
    const { argv, stdin } = f.calls[0]!;
    expect(stdin).toBe(content);
    expect(argv.slice(0, 7)).toEqual(["exec", "-i", "-w", "/work", CONTAINER_NAME, "sh", "-c"]);
    // The script is a constant: neither the path nor the content is spliced into it.
    expect(argv[7]).toBe('mkdir -p -- "$(dirname -- "$1")" && cat > "$1"');
    expect(argv.slice(8)).toEqual(["sh", "/work/out/$(id).md"]);
  });

  it("write_file refuses oversized content without calling docker", async () => {
    const f = fake();
    const res = await createDockerSandbox({ runner: f.runner }).writeFile("big", "x".repeat(WRITE_CAP_BYTES + 1));
    expect(res.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("paths outside the workspace never reach docker", async () => {
    const f = fake();
    const sb = createDockerSandbox({ runner: f.runner });
    expect((await sb.readFile("../../etc/shadow")).ok).toBe(false);
    expect((await sb.writeFile("/root/.profile", "x")).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("run_command is `timeout 30 sh -c <cmd>` inside the container, with a 64 KiB cap", async () => {
    const f = fake({ output: "ok\n" });
    const cmd = "ls -la && echo 'a b' | wc -c";
    const res = await createDockerSandbox({ runner: f.runner }).runCommand(cmd);
    expect(res).toEqual({ ok: true, output: "ok\n" });
    const req = f.calls[0]!;
    expect(req.argv).toEqual(["exec", "-w", "/work", CONTAINER_NAME, "sh", "-c", RUN_WRAPPER, "sh", "30", cmd]);
    // The wrapper is a constant: the command is only ever an argument to it.
    expect(RUN_WRAPPER).toBe('exec 2>&1; exec timeout -k 2 "$1" sh -c "$2"');
    expect(COMMAND_TIMEOUT_S).toBe(30);
    expect(req.maxBytes).toBe(64 * 1024);
    expect(req.timeoutMs).toBeGreaterThan(30_000);
    // No interactive or tty flag, no env passed into the container.
    expect(req.argv).not.toContain("-it");
    expect(req.argv).not.toContain("-e");
    expect(req.env).toBeUndefined();
  });

  it("run_command reports exit code, timeout and truncation", async () => {
    const run = (r: Partial<ExecResult>) => createDockerSandbox({ runner: fake(r).runner }).runCommand("x");
    expect(await run({ code: 3, output: "boom" })).toEqual({ ok: false, output: "boom\n[exit 3]" });
    expect(await run({ code: 124, output: "" })).toEqual({ ok: false, output: "[timed out after 30 s]" });
    expect(await run({ code: 137, output: "partial\n" })).toEqual({ ok: false, output: "partial\n[timed out after 30 s]" });
    expect(await run({ code: null, timedOut: true })).toEqual({ ok: false, output: "[timed out after 30 s]" });
    expect(await run({ code: null, truncated: true, output: "yyy" })).toEqual({ ok: true, output: "yyy\n[output truncated at 64 KiB]" });
  });

  it("a missing docker binary is a failed tool call, not a crash", async () => {
    const sb = createDockerSandbox({ runner: fake({ code: null, spawnError: "spawn docker ENOENT" }).runner });
    for (const res of [await sb.readFile("a"), await sb.writeFile("a", "b"), await sb.runCommand("ls")]) {
      expect(res).toEqual({ ok: false, output: "sandbox unavailable: spawn docker ENOENT" });
    }
  });

  it("a NUL byte in a command is refused", async () => {
    const f = fake();
    expect((await createDockerSandbox({ runner: f.runner }).runCommand("ls\0")).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("createRunner (against node, not docker)", () => {
  const node = createRunner(process.execPath);
  const base = { timeoutMs: 10_000, maxBytes: 1024 };

  it("collects stdout and stderr, feeds stdin, returns the exit code", async () => {
    const script = "process.stdin.on('data', d => { process.stdout.write('out:' + d); process.stderr.write('err'); process.exitCode = 7; })";
    const r = await node({ ...base, argv: ["-e", script], stdin: "hi" });
    expect(r.code).toBe(7);
    expect(r.output).toContain("out:hi");
    expect(r.output).toContain("err");
    expect(r.timedOut || r.truncated).toBe(false);
  });

  it("cuts output at maxBytes and kills the child", async () => {
    const r = await node({ ...base, argv: ["-e", "setInterval(() => process.stdout.write('y'.repeat(4096)), 1)"] });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output)).toBe(1024);
  });

  it("kills the child at the deadline", async () => {
    const r = await node({ argv: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 300, maxBytes: 1024 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it("reports a binary that does not exist", async () => {
    const r = await createRunner("rogueproof-no-such-binary")({ ...base, argv: [] });
    expect(r.code).toBeNull();
    expect(r.spawnError).toMatch(/ENOENT/);
  });

  it("passes env only when asked and never through a shell", async () => {
    const r = await node({ ...base, argv: ["-e", "console.log(process.env.SANDBOX_WORK_DIR, process.argv[1])", "$(echo x); `id`"], env: { SANDBOX_WORK_DIR: "/w" } });
    expect(r.output.trim()).toBe("/w $(echo x); `id`");
  });
});

describe("composeHostEnv", () => {
  it("turns the current context's endpoint into DOCKER_HOST, once per runner", async () => {
    const f = fake({ output: "unix:///Users/me/.docker/run/docker.sock\n" });
    expect(await composeHostEnv(f.runner, {})).toEqual({ DOCKER_HOST: "unix:///Users/me/.docker/run/docker.sock" });
    await composeHostEnv(f.runner, {});
    expect(f.calls.map((c) => c.argv)).toEqual([["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]]);
  });

  it("stays out of the way when DOCKER_HOST is set or the context cannot be read", async () => {
    const set = fake({ output: "unix:///x\n" });
    expect(await composeHostEnv(set.runner, { DOCKER_HOST: "tcp://127.0.0.1:2375" })).toEqual({});
    expect(set.calls).toHaveLength(0);
    expect(await composeHostEnv(fake({ code: 1, output: "error" }).runner, {})).toEqual({});
    expect(await composeHostEnv(fake({ output: "not a url; rm -rf\n" }).runner, {})).toEqual({});
  });
});
