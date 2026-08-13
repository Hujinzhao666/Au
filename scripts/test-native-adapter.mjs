import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(
  new URL("../www/native-adapter.js", import.meta.url),
  "utf8",
);

let capturedUrl = "";
let capturedInit = null;

const nativeFetch = async (url, init) => {
  capturedUrl = String(url);
  capturedInit = init;
  return new Response(
    JSON.stringify({
      id: "resp_test",
      created_at: 123,
      model: "gpt-5.6-sol",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "转换成功" }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const window = {
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  },
  fetch: nativeFetch,
};

const context = vm.createContext({
  window,
  URL,
  Headers,
  Response,
  FormData,
  crypto,
  console,
  Date,
  Math,
  JSON,
  Object,
  String,
  Number,
  Boolean,
  Array,
  Error,
});

new vm.Script(source, { filename: "native-adapter.js" }).runInContext(context);

const response = await window.fetch("https://tokenclub.info/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer sk-test",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.6-sol",
    messages: [
      { role: "system", content: "测试" },
      { role: "user", content: "你好" },
    ],
  }),
});

const result = await response.json();
const upstreamBody = JSON.parse(capturedInit.body);

assert.equal(capturedUrl, "https://tokenclub.info/responses");
assert.equal(upstreamBody.model, "gpt-5.6-sol");
assert.equal(upstreamBody.store, false);
assert.equal(upstreamBody.reasoning.effort, "medium");
assert.equal(result.choices[0].message.content, "转换成功");
assert.equal(result.usage.total_tokens, 5);
assert.equal(window.AuroraNative.enabled, true);

console.log("Native TokenClub protocol conversion: PASS");
