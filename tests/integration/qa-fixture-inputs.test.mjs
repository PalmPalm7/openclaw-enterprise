import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { protectedText } from "../helpers/qa-secrets.mjs";

test("QA credentials require a private regular file and reject symlink substitution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-credential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credential = join(directory, "credential");
  await writeFile(credential, " test-only-credential\n", { mode: 0o600 });
  assert.equal(await protectedText(credential, "test credential"), "test-only-credential");

  // A path replaced with a symlink must not redirect the credential read,
  // even when its target would pass the regular-file and permission checks.
  const link = join(directory, "substituted");
  await symlink(credential, link);
  await assert.rejects(protectedText(link, "test credential"), { code: "ELOOP" });
  await assert.rejects(protectedText(directory, "test credential"), /private regular file/);
  await chmod(credential, 0o644);
  await assert.rejects(protectedText(credential, "test credential"), /private regular file/);
  await chmod(credential, 0o600);
  await writeFile(credential, " \n");
  await assert.rejects(protectedText(credential, "test credential"), /must not be empty/);
});

test(
  "parallel QA stages publish complete outcomes, failures and timings",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "qa-report-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "matrix.json");
    const reportModule = new URL("../helpers/qa-report.mjs", import.meta.url).href;
    // Exercise the real reporter under node:test, including failed subtests.
    // A shared writeFile without a serialized snapshot can lose concurrent rows
    // or leave a trailing fragment of the previous JSON document.
    const source = `
    import test from 'node:test';
    import { createQaReport } from ${JSON.stringify(reportModule)};
    const report = createQaReport(${JSON.stringify(output)}, { scope: 'full', concurrency: 4 });
    test('parallel report', { concurrency: 4 }, async (t) => {
      await Promise.all(Array.from({length: 20}, (_, i) =>
        report.stage(t, 'compose/Codex', 'stage-' + i, async () => {
          if (i === 2) throw new Error('blocked by unavailable test prerequisite');
          if (i === 7) throw new Error('expected assertion failure');
        }, 'scenario-' + i)
      ));
      await report.save();
    });
  `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
    let diagnostic = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        diagnostic += chunk;
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 1, diagnostic);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.scope, "full");
    assert.equal(report.concurrency, 4);
    assert.equal(report.outcomes.length, 20);
    assert.equal(new Set(report.outcomes.map((row) => row.scenario)).size, 20);
    for (let i = 0; i < 20; i += 1) {
      const row = report.outcomes.find((value) => value.stage === `stage-${i}`);
      assert.equal(row.cell, "compose/Codex");
      assert.equal(row.scenario, `scenario-${i}`);
      let expectedOutcome = "passed";
      if (i === 2) {
        expectedOutcome = "blocked";
      } else if (i === 7) {
        expectedOutcome = "failed";
      }
      assert.equal(row.outcome, expectedOutcome);
      assert.ok(Number.isFinite(Date.parse(row.startedAt)));
      assert.ok(Number.isInteger(row.durationMs) && row.durationMs >= 0);
    }
    assert.match(report.outcomes.find((row) => row.stage === "stage-2").reason, /blocked by/);
    assert.match(
      report.outcomes.find((row) => row.stage === "stage-7").reason,
      /expected assertion/,
    );
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["matrix.json"]);
  },
);

test("QA selection keeps prerequisite credentials and reports omitted coverage", async () => {
  const { selectQaMatrix, validateQaInputs } = await import("../helpers/qa-selection.mjs");
  const selected = selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,calendar" });
  assert.equal(selected.scope, "partial:selected");
  assert.deepEqual(
    selected.cells.map(({ cell, scenarios }) => ({ cell, scenarios })),
    [
      { cell: "compose/OpenClaw", scenarios: ["model-ui"] },
      { cell: "compose/Codex", scenarios: ["model-ui", "calendar"] },
      { cell: "kubernetes/OpenClaw", scenarios: ["model-ui"] },
      { cell: "kubernetes/Codex", scenarios: ["model-ui", "calendar"] },
    ],
  );
  assert.deepEqual(selected.cells[1].unselected, ["git-full", "git-read", "slack"]);
  assert.deepEqual(selected.cells[0].notApplicable, ["calendar", "git-read", "slack"]);
  assert.throws(() => validateQaInputs(selected, {}), /OPENAI_KEY_FILE is required/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,typo" }),
    /invalid QA scenario/,
  );
  assert.throws(() => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "" }), /invalid QA scenario/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "calendar", OCC_TEST_QA_PRESET: "OpenClaw" }),
    /not applicable/,
  );
  const calendar = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "calendar",
    OCC_TEST_QA_INSTALLATION: "compose",
  });
  assert.ok(!calendar.requiredEnv.includes("OCC_TEST_QA_OPENAI_KEY_FILE"));
  assert.deepEqual(calendar.cells[0].scenarios, []);
  const openclaw = selectQaMatrix({ OCC_TEST_QA_PRESET: "OpenClaw" });
  assert.deepEqual(openclaw.cells[0].scenarios, ["model-ui", "git-full"]);
  assert.ok(!openclaw.requiredEnv.some((name) => /CODEX|SLACK|CALENDAR/.test(name)));
  const full = selectQaMatrix({});
  assert.equal(full.scope, "full");
  assert.ok(full.repository);
  assert.throws(
    () =>
      validateQaInputs(full, Object.fromEntries(full.requiredEnv.map((name) => [name, "fixture"]))),
    /explicit authorization/,
  );
});

test("hosted QA materializes only selected credentials and rejects missing selected inputs", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../../scripts/ci/qa-matrix-credentials.mjs", import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "qa-hosted-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, "github-env");
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "model-ui,calendar",
      OPENAI_API_KEY: "synthetic-model-key",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      OCC_TEST_CODEX_CALENDAR_TOOL_NAME: "test.calendar.read",
      OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT: "email",
      // Even if a caller supplies unrelated credentials, do not write them.
      SLACK_APP_TOKEN: "unselected-secret",
      REPOSITORY_APP_KEY: "unselected-secret",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
  const privateDirectory = join(directory, "qa-matrix-credentials");
  assert.deepEqual((await readdir(privateDirectory)).sort(), ["codex", "openai"]);
  assert.equal(
    await protectedText(join(privateDirectory, "codex"), "Codex credential"),
    "synthetic-codex-token",
  );
  const exported = await readFile(githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_CODEX_TOKEN_FILE=/);
  assert.doesNotMatch(exported, /synthetic-|unselected-secret|SLACK|REPOSITORY/);
  await rm(privateDirectory, { recursive: true });
  await rm(githubEnv);
  const missing = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "calendar",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT: "email",
    },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CALENDAR_TOOL_NAME is required/);
  await assert.rejects(readFile(githubEnv), { code: "ENOENT" });
});

test("QA command diagnostics retain the error while hiding generated and environment secrets", async () => {
  const { qaCommandFailureDetail, registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  registerQaSecret("generated-private-value");
  const output = qaCommandFailureDetail(
    "earlier detail\n".repeat(12) +
      "Docker service could not start: generated-private-value and process-private-value\nAuthorization: Bearer example-private-value\n",
    { PRIVATE_INPUT: "process-private-value" },
  );
  assert.match(output, /Docker service could not start/);
  assert.ok(output.split("\n").length <= 8);
  assert.doesNotMatch(
    output,
    /generated-private-value|process-private-value|example-private-value/,
  );
});

test("QA waits report the last observation when they time out", async () => {
  const { waitFor } = await import("../helpers/qa-utils.mjs");
  let observations = 0;
  let last;
  await assert.rejects(
    waitFor(
      "fake condition",
      async () => {
        observations += 1;
        last = { observation: observations, pods: ["runtime-0"] };
        return false;
      },
      200,
      { describe: () => JSON.stringify(last), interval: 5 },
    ),
    (error) => {
      assert.equal(
        error.message,
        `Timed out: fake condition; last observation: {"observation":${observations},"pods":["runtime-0"]}`,
      );
      return true;
    },
  );
  assert.ok(observations >= 2, "the wait observed more than once");
  // Without `describe` the message is unchanged; a failing `describe` keeps the timeout.
  await assert.rejects(
    waitFor("plain condition", async () => false, 10, { interval: 5 }),
    (error) => error.message === "Timed out: plain condition",
  );
  await assert.rejects(
    waitFor("broken describe", async () => false, 10, {
      interval: 5,
      describe: () => {
        throw new Error("no state");
      },
    }),
    (error) =>
      error.message === "Timed out: broken describe; last observation unavailable (no state)",
  );
  assert.equal(
    await waitFor("ready", async () => "value", 10, { describe: () => "unused" }),
    "value",
  );
});

test("a QA Agent stop timeout names the remaining Pods and keeps redacted platform logs", async () => {
  const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const { stopQaAgent, describeStopObservation } = await import("../helpers/qa-repository.mjs");
  registerQaSecret("stop-fixture-service-key");
  const agent = { id: "agent-1", namespaceId: "namespace-1" };
  const pod = {
    metadata: {
      namespace: "oce-agent-1",
      name: "agent-1-gateway-0",
      deletionTimestamp: "2026-10-11T01:37:00Z",
      finalizers: ["openclaw.dev/runtime"],
      labels: { "openclaw.dev/agent": "agent-1" },
    },
    spec: { containers: [{ env: [{ name: "GATEWAY_PASSWORD", value: "spec-private-value" }] }] },
    status: { phase: "Running" },
  };
  const calls = [];
  const records = new Map();
  const f = {
    controlPlane: "kubernetes",
    env: {
      PRIVATE_INPUT: "launcher-private-value",
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    },
    state: { platformNamespace: "oce-system" },
    async api(method, path) {
      calls.push(["api", method, path]);
      return method === "GET"
        ? { desiredRuntimeState: "stopped", activeRevisionId: "revision-1" }
        : undefined;
    },
    async kubectl(...args) {
      calls.push(["kubectl", ...args]);
      if (args[0] === "get") {
        return JSON.stringify({ items: [pod] });
      }
      if (args.includes("deployment/openclaw-enterprise-worker")) {
        throw new Error("kubectl failed (exit 1); stderr: launcher-private-value unreachable");
      }
      return (
        "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1\n" +
        "2026-10-11T01:36:01Z authenticated with stop-fixture-service-key\n" +
        "2026-10-11T01:36:02Z Authorization: Bearer abcdefghijklmnop\n"
      );
    },
    async record(name, value) {
      records.set(name, value);
      return `${this.controlPlane}-${name}.json`;
    },
  };
  await assert.rejects(stopQaAgent(f, agent, { timeout: 10 }), (error) => {
    assert.match(error.message, /^Timed out: ordinary Agent stop removes every runtime Pod; /);
    const observation = JSON.parse(
      /; last observation: (\{.*\}); API and worker logs: /.exec(error.message)[1],
    );
    assert.deepEqual(observation, {
      desiredRuntimeState: "stopped",
      activeRevisionId: "revision-1",
      pods: [
        {
          namespace: "oce-agent-1",
          name: "agent-1-gateway-0",
          phase: "Running",
          deletionTimestamp: "2026-10-11T01:37:00Z",
          finalizers: ["openclaw.dev/runtime"],
        },
      ],
    });
    assert.match(
      error.message,
      /API and worker logs: kubernetes-agent-1-stop-timeout-platform-logs\.json$/,
    );
    assert.doesNotMatch(error.message, /spec-private-value/);
    return true;
  });
  assert.equal(agent.stopped, undefined);
  assert.deepEqual(calls[0], ["api", "POST", "/namespaces/namespace-1/agents/agent-1/stop"]);
  const logCall = calls.find((call) => call.includes("deployment/openclaw-enterprise-api"));
  assert.deepEqual(logCall.slice(1, 7), [
    "-n",
    "oce-system",
    "logs",
    "deployment/openclaw-enterprise-api",
    "--container",
    "api",
  ]);
  assert.ok(
    logCall.some((argument) => /^--tail=\d+$/.test(argument)),
    "the log tail is bounded",
  );
  const { logs } = records.get("agent-1-stop-timeout-platform-logs");
  assert.equal(logs.api[0], "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1");
  assert.doesNotMatch(
    JSON.stringify(logs),
    /stop-fixture-service-key|abcdefghijklmnop|launcher-private-value/,
  );
  assert.equal(logs.api.length, 3);
  assert.match(logs.worker.unavailable.join("\n"), /unreachable/);
  assert.equal(describeStopObservation(undefined), "none");

  // A Compose control plane keeps the observation but has no in-cluster platform logs.
  records.clear();
  const composeAgent = { id: "agent-2", namespaceId: "namespace-1" };
  await assert.rejects(
    stopQaAgent({ ...f, controlPlane: "compose" }, composeAgent, { timeout: 10 }),
    (error) =>
      /; last observation: \{.*"pods":\[\{/.test(error.message) &&
      !/API and worker logs/.test(error.message),
  );
  assert.equal(records.size, 0);
});

test("QA log redaction hides each line of a registered multi-line secret", async () => {
  const { redactedQaTail, registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const body = ["MIIEfixtureLineOneAAAAAAAA", "fixtureLineTwoBBBBBBBBBBBB"];
  registerQaSecret(
    ["-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----"].join("\n"),
  );
  const lines = redactedQaTail(
    `reading key\n${body[0]}\n${body[1]}\ndone\n`,
    {},
    {
      lines: 10,
      lineChars: 200,
    },
  );
  assert.deepEqual(lines[0], "reading key");
  assert.equal(lines.at(-1), "done");
  assert.doesNotMatch(lines.join("\n"), /fixtureLine/);
});

test("development proof key admission precedes the selected case body", async (t) => {
  const { withDevUpModelKey } = await import("../helpers/dev-up-test-auth.mjs");
  const directory = await mkdtemp(join(tmpdir(), "dev-up-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "key");
  let calls = 0;
  const body = async (_context, key) => {
    calls += 1;
    assert.equal(key, "synthetic-development-token");
  };
  // Registration must not read the key: excluded node:test cases remain key-free.
  const unselected = withDevUpModelKey(join(directory, "missing"), body);
  assert.equal(typeof unselected, "function");
  for (const path of [undefined, "relative-key", join(directory, "missing")]) {
    await assert.rejects(withDevUpModelKey(path, body)(t));
  }
  await writeFile(keyFile, "synthetic-development-token\n", { mode: 0o600 });
  const link = join(directory, "link");
  await symlink(keyFile, link);
  await assert.rejects(withDevUpModelKey(link, body)(t), { code: "ELOOP" });
  await assert.rejects(withDevUpModelKey(directory, body)(t), /private regular file/);
  await chmod(keyFile, 0o644);
  await assert.rejects(withDevUpModelKey(keyFile, body)(t), /private regular file/);
  await chmod(keyFile, 0o600);
  for (const value of [
    "",
    " \n",
    "two tokens",
    "line\nbreak",
    "nul\0byte",
    '{"key":"bundle"}',
    '["bundle"]',
    '"quoted"',
  ]) {
    await writeFile(keyFile, value);
    await assert.rejects(withDevUpModelKey(keyFile, body)(t));
  }
  assert.equal(calls, 0, "invalid input cannot admit any startup or port allocation");
  await writeFile(keyFile, " synthetic-development-token\n");
  const before = await stat(keyFile);
  await withDevUpModelKey(keyFile, body)(t);
  assert.equal(calls, 1);
  assert.equal(await readFile(keyFile, "utf8"), " synthetic-development-token\n");
  assert.equal((await stat(keyFile)).ino, before.ino);
  assert.equal((await stat(keyFile)).mode, before.mode);
  const cancelled = new AbortController();
  const pending = withDevUpModelKey(keyFile, body)({ signal: cancelled.signal });
  cancelled.abort(new Error("preflight cancelled"));
  await assert.rejects(pending, /preflight cancelled/);
  assert.equal(calls, 1, "cancellation during file admission cannot start the body");
});

test("development proof sends the key only to Secret creation and renders the genuine preset by reference", async () => {
  const { provisionDevUpSandboxAgent } = await import("../helpers/dev-up-test-auth.mjs");
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const original = structuredClone(preset);
  const modelKey = "synthetic-routing-token";
  const ref = { kind: "secret", namespaceId: "namespace-1", id: "secret-1" };
  const calls = [];
  const result = await provisionDevUpSandboxAgent({
    namespaceId: "namespace-1",
    preset,
    modelKey,
    requestId: "request-1",
    async post(path, body, expected) {
      calls.push({ path, body, expected });
      return calls.length === 1 ? { data: { ref } } : { data: { workId: "work-1" } };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    path: "/namespaces/namespace-1/secrets",
    body: { name: "Local sandbox proof", value: modelKey },
    expected: 201,
  });
  const provision = calls[1];
  assert.equal(provision.path, "/namespaces/namespace-1/agents/provision");
  assert.equal(provision.expected, 202);
  assert.deepEqual(provision.body.harnessAuth, { method: "api_key", source: ref });
  assert.equal(provision.body.executionMode, "dedicated");
  assert.equal(provision.body.requestId, "request-1");
  assert.equal(provision.body.configuration.values.agents.defaults.model, "codex/gpt-6-astra");
  assert.equal(provision.body.configuration.values.gateway.controlUi.enabled, false);
  assert.equal(
    provision.body.configuration.values.plugins.entries.codex.config.appServer.sandbox,
    "workspace-write",
  );
  const configuration = structuredClone(original.template.configuration);
  configuration.values.gateway.controlUi.enabled = false;
  configuration.values.agents.defaults.model = "codex/gpt-6-astra";
  configuration.values.agents.defaults.models = {
    "codex/gpt-6-astra": configuration.values.agents.defaults.models["codex/{{ vars.model }}"],
  };
  configuration.values.models.providers.codex.models[0] = {
    id: "gpt-6-astra",
    name: "gpt-6-astra",
  };
  assert.deepEqual(provision.body.configuration, { kind: "agent", ...configuration });
  assert.ok(!JSON.stringify(provision).includes(modelKey));
  assert.deepEqual(preset, original);
  assert.deepEqual(result, { data: { workId: "work-1" } });
});

test("development proof never submits a dependent or duplicate request after an unknown response", async () => {
  const { provisionDevUpSandboxAgent } = await import("../helpers/dev-up-test-auth.mjs");
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  for (const failedCall of [1, 2]) {
    let calls = 0;
    const unknown = new Error("transport ended without a response");
    await assert.rejects(
      provisionDevUpSandboxAgent({
        namespaceId: "namespace-1",
        preset,
        modelKey: "synthetic-unknown-token",
        requestId: "request-1",
        async post() {
          calls += 1;
          if (calls === failedCall) {
            throw unknown;
          }
          return { data: { ref: { kind: "secret", namespaceId: "namespace-1", id: "secret-1" } } };
        },
      }),
      (error) => error === unknown,
    );
    assert.equal(calls, failedCall);
  }
});

test(
  "development proof errors omit secret-bearing fields from actual node:test output",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dev-up-error-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const keyFile = join(directory, "key");
    const value = 'synthetic-token-quote"-backslash\\-end';
    await writeFile(keyFile, value, { mode: 0o600 });
    const helper = new URL("../helpers/dev-up-test-auth.mjs", import.meta.url).href;
    const source = `
    import test from 'node:test';
    import { withDevUpModelKey, devUpTestError } from ${JSON.stringify(helper)};
    test('intentional synthetic failure', withDevUpModelKey(${JSON.stringify(keyFile)}, async (_t, key) => {
      const error = Object.assign(new Error('cleanup failed: ' + key + ' ' + JSON.stringify(key)), {
        code: 'EACCES', signal: 'SIGTERM', cause: new Error(key), stdout: key, stderr: key, actual: key, expected: key,
      });
      const safe = devUpTestError(error);
      process.stdout.write(JSON.stringify(safe) + '\\n');
      throw error;
    }));
  `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 1);
    assert.ok(!output.includes(value));
    assert.ok(!output.includes(JSON.stringify(value).slice(1, -1)));
    assert.match(output, /cleanup failed/);
    assert.match(output, /EACCES/);
    assert.match(output, /SIGTERM/);
    assert.ok(
      !output.includes('"cause"') && !output.includes('"stdout"') && !output.includes('"actual"'),
    );
  },
);
