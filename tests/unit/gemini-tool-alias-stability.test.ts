import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

function hashedAlias(originalName: string, hashLength: number): string {
  const normalizedName = originalName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  const hash = createHash("sha256").update(originalName).digest("hex").slice(0, hashLength);
  return `${normalizedName}_${hash}`;
}

function pairedHistory(toolNames: string[]): Array<Record<string, unknown>> {
  return toolNames.flatMap((name, index) => {
    const id = `call-${index}`;
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: { name, arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: id,
        content: "ok",
      },
    ];
  });
}

test("current Gemini declarations keep stable aliases when replayed history occupies hash candidates", () => {
  const collidingName = "functions__exec";
  const occupiedAliases = [
    "functions_exec",
    ...Array.from({ length: 13 }, (_, index) => hashedAlias(collidingName, 8 + index * 2)),
  ];
  const body = {
    messages: [...pairedHistory(occupiedAliases), { role: "user", content: "continue" }],
    tools: [
      {
        type: "function",
        function: {
          name: "functions_exec",
          description: "Run a command",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: collidingName,
          description: "Run a namespaced command",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };

  const translate = () =>
    openaiToAntigravityRequest("gemini-3.7-flash-high", body, false, {
      projectId: "test-project",
    }) as {
      request: {
        tools?: Array<{ functionDeclarations?: Array<{ name: string }> }>;
      };
      _toolNameMap?: Map<string, string>;
    };

  const first = translate();
  const second = translate();
  const firstNames = first.request.tools?.flatMap((tool) =>
    (tool.functionDeclarations ?? []).map((declaration) => declaration.name)
  );
  const secondNames = second.request.tools?.flatMap((tool) =>
    (tool.functionDeclarations ?? []).map((declaration) => declaration.name)
  );

  assert.deepEqual(firstNames, secondNames);
  assert.deepEqual(firstNames, ["functions_exec", hashedAlias(collidingName, 8)]);
  assert.equal(first._toolNameMap?.get(hashedAlias(collidingName, 8)), collidingName);
});
