import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { renderPresetTemplate } from "../../packages/contracts/src/preset-variables.mjs";
import { protectedText, qaCommandFailureDetail, registerQaSecret } from "./qa-secrets.mjs";

// Do not preserve raw causes, command output or assertion actual/expected fields.
export function devUpTestError(error) {
  const detail = qaCommandFailureDetail(error?.message ?? "Development proof failed", {});
  const result = new Error(detail || "Development proof failed");
  if (["ENOENT", "EACCES", "ELOOP", "EINVAL", "ETIMEDOUT"].includes(error?.code)) {
    result.code = error.code;
  } else if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255) {
    result.code = error.code;
  }
  if (["SIGTERM", "SIGKILL", "SIGINT"].includes(error?.signal)) {
    result.signal = error.signal;
  }
  return result;
}

// The returned test callback reads nothing until node:test selects this case.
export function withDevUpModelKey(keyFile, body) {
  return async (t) => {
    try {
      assert.ok(
        typeof keyFile === "string" && isAbsolute(keyFile),
        "OCC_TEST_DEV_UP_MODEL_KEY_FILE must name an absolute private file",
      );
      t.signal?.throwIfAborted();
      const modelKey = await protectedText(keyFile, "Development model API key");
      registerQaSecret(JSON.stringify(modelKey).slice(1, -1));
      assert.ok(
        !/[\s\u0000-\u001f\u007f]/u.test(modelKey) && !/^[{["]/u.test(modelKey),
        "Development model API key must be a single token, not a credential bundle",
      );
      t.signal?.throwIfAborted();
      await body(t, modelKey);
    } catch (error) {
      throw devUpTestError(error);
    }
  };
}

export async function provisionDevUpSandboxAgent({
  post,
  namespaceId,
  preset,
  modelKey,
  requestId,
}) {
  const secret = await post(
    `/namespaces/${namespaceId}/secrets`,
    { name: "Local sandbox proof", value: modelKey },
    201,
  );
  // Match the console's existing-Secret flow: the renderer never receives a key.
  const template = structuredClone(preset.template);
  template.agent.harnessAuth = { method: "api_key", source: secret.data.ref };
  const rendered = renderPresetTemplate(template, {
    name: "Local sandbox proof",
    model: "gpt-6-astra",
  });
  rendered.configuration.values.gateway.controlUi.enabled = false;
  return post(
    `/namespaces/${namespaceId}/agents/provision`,
    {
      requestId,
      ...rendered.agent,
      configuration: { kind: "agent", ...rendered.configuration },
    },
    202,
  );
}
