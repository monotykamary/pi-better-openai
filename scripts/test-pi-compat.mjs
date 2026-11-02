import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = await mkdtemp(join(tmpdir(), "pi-extension-compat-"));
const previousHome = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
const previousDecisionsKey = process.env.OPENAI_DECISIONS_API_KEY;
process.env.OPENAI_DECISIONS_API_KEY = "synthetic-decisions-key";
process.env.PI_CODING_AGENT_DIR = home;
globalThis.fetch = async () => new Response("", { status: 503 });
let session;
try {
  const {
    createAgentSession,
    createCodemodeExtension,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    VERSION,
  } = await import("@earendil-works/pi-coding-agent");
  assert.equal(VERSION, "1.5.0", "test the actual pinned Pi host, not a stale override");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(
      manifest.dependencies?.[name],
      undefined,
      `${name}: host packages must not be runtime dependencies`,
    );
    if (manifest.peerDependencies?.[name] !== undefined)
      assert.equal(manifest.peerDependencies[name], "*");
  }
  const settingsManager = SettingsManager.inMemory({
    packages: [root],
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: home,
    agentDir: home,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.ok(loaded.extensions.length > 0, "manifest entrypoints must load");
  // Synthetic direct-OpenAI credentials only; never read the user's auth store.
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "synthetic-openai-subscription-token",
        refresh: "synthetic-refresh",
        expires: Date.now() + 3600000,
        clientId: "synthetic-client",
        scopes: ["chatgpt.tokens.use.direct"],
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(home, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(home, "models-cache"),
    allowModelNetwork: false,
  });
  ({ session } = await createAgentSession({
    cwd: home,
    agentDir: home,
    resourceLoader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(home),
  }));
  const errors = [];
  session.extensionRunner.onError((error) => errors.push(error));
  await session.bindExtensions({});
  const commands = loaded.extensions[0].commands;
  const tierCompletions = await commands.get("openai-tier").getArgumentCompletions("ultra");
  assert.equal(tierCompletions[0].value, "ultrafast");
  const modelCompletions = await commands
    .get("openai-decisions")
    .getArgumentCompletions("use openai-d");
  assert.deepEqual(
    modelCompletions.map((item) => item.value),
    ["use openai-decisions/gpt-6-luna"],
  );
  assert.equal(modelRuntime.getProvider("openai")?.auth?.oauth?.isSubscription, true);
  assert.match(modelRuntime.getProvider("openai-codex")?.name ?? "", /legacy/i);
  const decisionsModel = modelRuntime.getModelOfType("classifier", "openai", "gpt-6-luna");
  assert.equal(decisionsModel?.api, "openai-decisions");
  assert.deepEqual(
    await modelRuntime.getAvailableOfType("classifier", "openai"),
    [],
    "Decisions is not subscription access",
  );
  assert.equal(modelRuntime.isUsingOAuth("openai"), true);
  assert.equal(modelRuntime.isUsingSubscription("openai"), true);
  assert.equal(
    (await modelRuntime.getAuth("openai"))?.auth.apiKey,
    "synthetic-openai-subscription-token",
  );
  assert.equal(
    await modelRuntime.getAuth("openai-codex"),
    undefined,
    "OpenAI OAuth is not Codex backend auth",
  );
  const openaiModel = modelRuntime.getModel("openai", "gpt-6-astra");
  assert.equal(openaiModel?.api, "openai-responses");
  assert.equal(openaiModel?.baseUrl, "https://api.openai.com/v1");
  for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
    assert.ok(
      (await modelRuntime.getAvailableOfType("chat", "openai")).some(
        (model) => model.id === id && model.api === "openai-responses",
      ),
      `${id}: direct OpenAI subscription model must remain available without Codex auth`,
    );
  }
  assert.ok(
    modelRuntime.getModel("openai-codex", "gpt-6.1-sol"),
    "legacy fallback models remain registered",
  );
  const separateDecisions = modelRuntime.getModelOfType(
    "classifier",
    "openai-decisions",
    "gpt-6-luna",
  );
  assert.ok(separateDecisions, "separate API-only Decisions model is registered");
  assert.deepEqual(await modelRuntime.getAvailableOfType("classifier", "openai-decisions"), [
    separateDecisions,
  ]);
  assert.deepEqual(modelRuntime.getProvider("openai-decisions").getModels(), []);
  const separateResult = await modelRuntime.classify(
    separateDecisions,
    {
      state: { approved: true },
      questions: {
        approved: {
          type: "bool",
          instructions: "Is it approved?",
          criteria: { true: "Approved", false: "Not approved" },
        },
      },
    },
    {
      fetch: async (url, init) => {
        assert.equal(String(url), "https://api.openai.com/v1/decisions");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer synthetic-decisions-key",
        );
        return Response.json({
          answers: [{ name: "approved", type: "predicate", probability: 0.9 }],
          usage: { input_tokens: 20, output_tokens: 0 },
        });
      },
    },
  );
  assert.equal(separateResult.stopReason, "stop");
  assert.equal(separateResult.provider, "openai-decisions");
  assert.equal(
    modelRuntime.isUsingOAuth("openai"),
    true,
    "Decisions API billing must not change chat auth",
  );
  assert.equal(
    (await modelRuntime.getAuth("openai"))?.auth.apiKey,
    "synthetic-openai-subscription-token",
  );
  assert.deepEqual(await modelRuntime.getAvailableOfType("classifier", "openai"), []);
  await modelRuntime.setRuntimeApiKey("openai", "synthetic-api-key");
  assert.equal(
    modelRuntime.isUsingOAuth("openai"),
    false,
    "API key overrides must remain API-only",
  );
  assert.ok(
    (await modelRuntime.getAvailableOfType("classifier", "openai")).some(
      (model) => model.id === "gpt-6-luna",
    ),
  );
  for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
    assert.ok(
      (await modelRuntime.getAvailableOfType("chat", "openai")).some(
        (model) => model.id === id && model.baseUrl === "https://api.openai.com/v1",
      ),
      `${id}: API-key access must stay on the native OpenAI route`,
    );
  }
  const decisionRequests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/decisions");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-api-key");
    decisionRequests.push(JSON.parse(init.body));
    return Response.json({
      answers: [{ name: "approved", type: "predicate", probability: 0.9 }],
      usage: { input_tokens: 20, output_tokens: 0 },
    });
  };
  let codemode;
  createCodemodeExtension()({
    registerTool: (tool) => {
      codemode = tool;
    },
    appendEntry() {},
    getSettings: () => ({}),
    getAllTools: () => [],
  });
  for (const images of [[], [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]]) {
    const input = {
      state: { approved: true },
      questions: {
        approved: {
          type: "bool",
          instructions: "Is it approved?",
          criteria: { true: "Approved", false: "Not approved" },
        },
      },
      images,
    };
    const result = await codemode.execute(
      "decisions-codemode-probe",
      {
        code: `const available = await models.getAvailableOfType("classifier", "openai"); const model = available.find(m => m.id === "gpt-6-luna"); if (!model) throw new Error("missing classifier"); return await models.classify(model, ${JSON.stringify(input)});`,
      },
      undefined,
      undefined,
      session.extensionRunner.createToolContext("decisions-codemode-probe", undefined),
    );
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(text, /Script completed/);
    assert.match(text, /"probability":\s*0\.9/);
    assert.equal(result.usage.input, 20);
    assert.ok(Math.abs(result.usage.cost.total - 0.000002) < 1e-15);
  }
  assert.equal(decisionRequests.length, 2);
  assert.equal(typeof decisionRequests[0].input, "string");
  assert.equal(decisionRequests[1].input[0].content[1].image_url, "data:image/png;base64,aW1hZ2U=");
  await modelRuntime.removeRuntimeApiKey("openai");
  assert.equal(modelRuntime.isUsingOAuth("openai"), true);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/decisions");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-decisions-key");
    return Response.json({
      answers: [{ name: "approved", type: "predicate", probability: 0.9 }],
      usage: { input_tokens: 20, output_tokens: 0 },
    });
  };
  const splitResult = await codemode.execute(
    "split-billing-probe",
    {
      code: `const available = await models.getAvailableOfType("classifier", "openai-decisions"); const model = available.find(m => m.id === "gpt-6-luna"); if (!model) throw new Error("missing API-only classifier"); return await models.classify(model, { state: { approved: true }, questions: { approved: { type: "bool", instructions: "Is it approved?", criteria: { true: "Approved", false: "Not approved" } } } });`,
    },
    undefined,
    undefined,
    session.extensionRunner.createToolContext("split-billing-probe", undefined),
  );
  const splitText = splitResult.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(splitText, /Script completed/);
  assert.match(splitText, /"probability":\s*0\.9/);
  assert.equal(splitResult.usage.input, 20);
  assert.equal(modelRuntime.isUsingOAuth("openai"), true);
  assert.equal(
    (await modelRuntime.getAuth("openai"))?.auth.apiKey,
    "synthetic-openai-subscription-token",
  );
  globalThis.fetch = async () => new Response("", { status: 503 });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(errors, [], "real session startup and shutdown must succeed");
  const names = new Set();
  for (const extension of loaded.extensions) {
    for (const [name, { definition }] of extension.tools) {
      assert.equal(definition.name, name);
      assert.equal(typeof definition.execute, "function");
      assert.equal(typeof definition.parameters, "object");
      assert.ok(!names.has(name), `duplicate tool ${name}`);
      names.add(name);
      assert.ok(
        session.getAllTools().some((tool) => tool.name === name),
        `${name}: tool must be installed in the real session`,
      );
    }
  }
  console.log(
    `${manifest.name}: Pi ${VERSION} warning-free manifest load; ${loaded.extensions.length} extensions, ${names.size} tools registered; OpenAI auth isolation and native codemode text/image Decisions verified (mock HTTP)`,
  );
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  globalThis.fetch = previousFetch;
  if (previousDecisionsKey === undefined) delete process.env.OPENAI_DECISIONS_API_KEY;
  else process.env.OPENAI_DECISIONS_API_KEY = previousDecisionsKey;
  if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousHome;
  await rm(home, { recursive: true, force: true });
}
