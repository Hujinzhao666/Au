/**
 * Aurora AI 原生直连适配器
 *
 * 作用：
 * 1. 安卓/iOS 原生应用使用 CapacitorHttp 发起请求，避开浏览器 CORS。
 * 2. 当目标是 tokenclub.info 时，把前端的 Chat Completions 请求转换为
 *    Responses 请求，再把上游结果转换回前端能够识别的格式。
 * 3. 不保存、不打印 API 密钥和聊天内容。
 *
 * 网页/PWA 环境不会启用本适配器，仍可继续使用 Cloudflare Worker。
 */
(function installAuroraNativeAdapter() {
  "use strict";

  var capacitor = window.Capacitor;
  var isNative = Boolean(
    capacitor &&
      typeof capacitor.isNativePlatform === "function" &&
      capacitor.isNativePlatform()
  );

  window.AuroraNative = Object.freeze({
    enabled: isNative,
    platform:
      capacitor && typeof capacitor.getPlatform === "function"
        ? capacitor.getPlatform()
        : "web",
    adapterVersion: "1.3.0",
  });

  window.AuroraNativeReady = isNative
    ? seedNativeDefaults().catch(function (error) {
        console.warn("[AuroraNative] default_config_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
    : Promise.resolve();

  if (!isNative || typeof window.fetch !== "function") return;

  var nativeFetch = window.fetch.bind(window);

  window.fetch = async function auroraFetch(input, init) {
    var requestUrl = getRequestUrl(input);

    if (!shouldConvertTokenClubRequest(requestUrl, init)) {
      return nativeFetch(input, init);
    }

    var startedAt = Date.now();

    try {
      var chatBody = readJsonBody(init && init.body);
      var responsesBody = chatToResponses(chatBody);
      var upstreamUrl = new URL("/responses", requestUrl).href;
      var useBackground = ["high", "xhigh", "max"].includes(
        responsesBody.reasoning && responsesBody.reasoning.effort
      );
      var backgroundActive = useBackground;
      var cacheDisabled = false;
      var upstreamInit = Object.assign({}, init, {
        method: "POST",
        headers: copyHeaders(init && init.headers),
      });

      console.info("[AuroraNative] request_start", {
        provider: "tokenclub",
        model: responsesBody.model,
        stream: false,
      });

      var response = await nativeFetch(
        upstreamUrl,
        Object.assign({}, upstreamInit, {
          body: JSON.stringify(
            backgroundActive
              ? Object.assign({}, responsesBody, { background: true })
              : responsesBody
          ),
        })
      );
      var text = await response.text();
      var data = safeJson(text);

      if (
        useBackground &&
        !response.ok &&
        backgroundUnsupported(response.status, data, text)
      ) {
        console.info("[AuroraNative] background_fallback", {
          provider: "tokenclub",
          status: response.status,
        });
        response = await nativeFetch(
          upstreamUrl,
          Object.assign({}, upstreamInit, {
            body: JSON.stringify(responsesBody),
          })
        );
        text = await response.text();
        data = safeJson(text);
        backgroundActive = false;
      }

      if (
        !response.ok &&
        unsupportedOption(data, text, "prompt_cache_key")
      ) {
        var compatibleBody = Object.assign({}, responsesBody);
        delete compatibleBody.prompt_cache_key;
        cacheDisabled = true;
        if (backgroundActive) compatibleBody.background = true;
        response = await nativeFetch(
          upstreamUrl,
          Object.assign({}, upstreamInit, {
            body: JSON.stringify(compatibleBody),
          })
        );
        text = await response.text();
        data = safeJson(text);
      }

      if (
        backgroundActive &&
        !response.ok &&
        backgroundUnsupported(response.status, data, text)
      ) {
        var synchronousBody = Object.assign({}, responsesBody);
        if (
          cacheDisabled ||
          unsupportedOption(data, text, "prompt_cache_key")
        ) {
          delete synchronousBody.prompt_cache_key;
        }
        response = await nativeFetch(
          upstreamUrl,
          Object.assign({}, upstreamInit, {
            body: JSON.stringify(synchronousBody),
          })
        );
        text = await response.text();
        data = safeJson(text);
        backgroundActive = false;
      }

      if (
        response.ok &&
        data &&
        data.id &&
        ["queued", "in_progress"].includes(data.status)
      ) {
        data = await pollBackgroundResponse(
          requestUrl,
          data.id,
          upstreamInit.headers
        );
        text = JSON.stringify(data);
      }

      console.info("[AuroraNative] request_end", {
        provider: "tokenclub",
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });

      if (!response.ok || !data) {
        return makeResponse(
          text ||
            JSON.stringify({
              error: {
                message: "中转站没有返回有效内容",
                type: "invalid_upstream_response",
              },
            }),
          response.status || 502,
          response.headers
        );
      }

      if (Array.isArray(data.choices)) {
        return makeResponse(
          JSON.stringify(data),
          response.status,
          response.headers
        );
      }

      return makeResponse(
        JSON.stringify(responsesToChat(data, responsesBody.model)),
        response.status,
        response.headers
      );
    } catch (error) {
      console.error("[AuroraNative] request_failed", {
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  function shouldConvertTokenClubRequest(url, init) {
    if (
      !url ||
      !init ||
      String(init.method || "GET").toUpperCase() !== "POST"
    ) {
      return false;
    }

    try {
      var parsed = new URL(url);
      return (
        parsed.hostname.toLowerCase() === "tokenclub.info" &&
        /\/chat\/completions\/?$/i.test(parsed.pathname)
      );
    } catch (_) {
      return false;
    }
  }

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function readJsonBody(body) {
    if (typeof body === "string") {
      var parsed = safeJson(body);
      if (parsed) return parsed;
    }
    if (body && typeof body === "object" && !(body instanceof FormData)) {
      return body;
    }
    throw new Error("无法识别前端发送的请求格式");
  }

  function copyHeaders(source) {
    var headers = new Headers(source || {});
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    return headers;
  }

  function backgroundUnsupported(status, data, text) {
    if (![400, 404, 405, 422].includes(Number(status))) return false;
    var message = String(
      (data && data.error && data.error.message) ||
        (data && data.message) ||
        text ||
        ""
    ).toLowerCase();
    return [404, 405].includes(Number(status)) || message.includes("background");
  }

  function unsupportedOption(data, text, optionName) {
    var message = String(
      (data && data.error && data.error.message) ||
        (data && data.message) ||
        text ||
        ""
    ).toLowerCase();
    return message.includes(String(optionName).toLowerCase());
  }

  async function pollBackgroundResponse(requestUrl, responseId, headers) {
    var pollUrl = new URL(
      "/responses/" + encodeURIComponent(responseId),
      requestUrl
    ).href;
    var deadline = Date.now() + 30 * 60 * 1000;
    var consecutiveFailures = 0;

    while (Date.now() < deadline) {
      await delay(2500);

      try {
        var response = await nativeFetch(pollUrl, {
          method: "GET",
          headers: copyHeaders(headers),
        });
        var text = await response.text();
        var data = safeJson(text);

        if (!response.ok || !data) {
          consecutiveFailures += 1;
          if (consecutiveFailures <= 8) continue;
          throw new Error(
            (data && data.error && data.error.message) ||
              "后台任务查询连续失败，请稍后重试"
          );
        }

        consecutiveFailures = 0;

        if (["queued", "in_progress"].includes(data.status)) continue;
        if (data.status === "completed" || !data.status) return data;

        throw new Error(
          (data.error && data.error.message) ||
            "后台任务已结束，但状态为 " +
              String(data.status || "unknown")
        );
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures <= 8) continue;
        throw error;
      }
    }

    throw new Error("深度思考超过30分钟，任务仍未完成，请降低思考强度后重试");
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  function chatToResponses(chat) {
    if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) {
      throw new Error("messages 必须是非空数组");
    }

    var input = [];

    chat.messages.forEach(function (message) {
      if (!message || typeof message.role !== "string") return;

      if (message.role === "tool" || message.role === "function") {
        var callId = message.tool_call_id || message.call_id || message.name;
        if (!callId) return;
        input.push({
          type: "function_call_output",
          call_id: String(callId),
          output: stringify(message.content),
        });
        return;
      }

      var role = ["system", "developer", "user", "assistant"].includes(
        message.role
      )
        ? message.role
        : "user";
      var content = convertContent(message.content, role);

      if (content !== "" && !(Array.isArray(content) && content.length === 0)) {
        input.push({ role: role, content: content });
      }

      if (role === "assistant" && Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach(function (call) {
          if (
            !call ||
            call.type !== "function" ||
            !call.function ||
            !call.function.name
          ) {
            return;
          }
          input.push({
            type: "function_call",
            call_id: call.id || randomId("call_"),
            name: call.function.name,
            arguments: String(call.function.arguments || "{}"),
          });
        });
      }
    });

    var result = {
      model: String(chat.model || "gpt-5.6-sol"),
      input: input,
      stream: false,
      store: false,
      reasoning: {
        effort: normalizeReasoningEffort(chat.reasoning_effort),
      },
      prompt_cache_key:
        String(chat.prompt_cache_key || "aurora-core-v2") +
        ":" +
        String(chat.model || "gpt-5.6-sol"),
    };

    var maxTokens = Number(chat.max_completion_tokens || chat.max_tokens || 0);
    if (Number.isInteger(maxTokens) && maxTokens > 0) {
      result.max_output_tokens = maxTokens;
    }

    if (Array.isArray(chat.tools)) {
      result.tools = chat.tools.map(function (tool) {
        if (!tool || tool.type !== "function" || !tool.function) return tool;
        return compact({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters || {
            type: "object",
            properties: {},
          },
          strict: tool.function.strict,
        });
      });
    }

    if (chat.tool_choice != null) {
      result.tool_choice =
        chat.tool_choice.type === "function" && chat.tool_choice.function
          ? { type: "function", name: chat.tool_choice.function.name }
          : chat.tool_choice;
    }

    return result;
  }

  function normalizeReasoningEffort(value) {
    var effort = String(value || "medium").toLowerCase();
    return ["none", "low", "medium", "high", "xhigh", "max"].includes(
      effort
    )
      ? effort
      : "medium";
  }

  function convertContent(content, role) {
    if (typeof content === "string") return content;
    if (content == null) return "";
    if (!Array.isArray(content)) return JSON.stringify(content);

    return content
      .map(function (part) {
        if (typeof part === "string") {
          return {
            type: role === "assistant" ? "output_text" : "input_text",
            text: part,
          };
        }

        if (!part || typeof part !== "object") return null;

        if (["text", "input_text", "output_text"].includes(part.type)) {
          return {
            type: role === "assistant" ? "output_text" : "input_text",
            text: String(part.text || ""),
          };
        }

        if (["image_url", "input_image"].includes(part.type)) {
          var imageUrl =
            typeof part.image_url === "string"
              ? part.image_url
              : part.image_url && part.image_url.url;
          if (!imageUrl) return null;
          return compact({
            type: "input_image",
            image_url: imageUrl,
            detail: (part.image_url && part.image_url.detail) || part.detail,
          });
        }

        if (["file", "input_file"].includes(part.type)) {
          var file =
            part.file && typeof part.file === "object" ? part.file : part;
          var fileData = file.file_data || part.file_data;
          var filename = file.filename || part.filename;
          var fileId = file.file_id || part.file_id;
          var fileUrl = file.file_url || part.file_url;
          if (!fileData && !fileId && !fileUrl) return null;
          return compact({
            type: "input_file",
            filename: filename,
            file_data: fileData,
            file_id: fileId,
            file_url: fileUrl,
            detail: file.detail || part.detail,
          });
        }

        return null;
      })
      .filter(Boolean);
  }

  function responsesToChat(data, requestedModel) {
    if (data && data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    var textParts = [];
    var refusals = [];
    var toolCalls = [];

    if (typeof data.output_text === "string") textParts.push(data.output_text);

    (Array.isArray(data.output) ? data.output : []).forEach(function (item) {
      if (item && item.type === "message") {
        (Array.isArray(item.content) ? item.content : []).forEach(function (
          part
        ) {
          if (
            part &&
            ["output_text", "text"].includes(part.type) &&
            typeof part.text === "string"
          ) {
            textParts.push(part.text);
          }
          if (
            part &&
            part.type === "refusal" &&
            typeof part.refusal === "string"
          ) {
            refusals.push(part.refusal);
          }
        });
      }

      if (item && item.type === "function_call") {
        toolCalls.push({
          id: item.call_id || item.id || randomId("call_"),
          type: "function",
          function: {
            name: item.name || "unknown_function",
            arguments:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments || {}),
          },
        });
      }
    });

    var content = textParts.join("") || refusals.join("");
    if (!content && toolCalls.length === 0) {
      throw new Error("中转站返回成功，但没有找到回答内容");
    }

    var message = {
      role: "assistant",
      content: content || null,
    };
    if (toolCalls.length) message.tool_calls = toolCalls;

    var inputTokens = Number(data.usage && data.usage.input_tokens) || 0;
    var outputTokens = Number(data.usage && data.usage.output_tokens) || 0;
    var cachedTokens =
      Number(
        data.usage &&
          data.usage.input_tokens_details &&
          data.usage.input_tokens_details.cached_tokens
      ) || 0;

    return {
      id: data.id
        ? String(data.id).replace(/^resp_/, "chatcmpl_")
        : randomId("chatcmpl_"),
      object: "chat.completion",
      created: data.created_at || Math.floor(Date.now() / 1000),
      model: data.model || requestedModel,
      choices: [
        {
          index: 0,
          message: message,
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens:
          Number(data.usage && data.usage.total_tokens) ||
          inputTokens + outputTokens,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      },
      proxy_metadata: {
        transport: "native-direct",
        requested_model: requestedModel,
        upstream_reported_model: data.model || null,
        upstream_response_id: data.id || null,
        cached_input_tokens: cachedTokens,
      },
    };
  }

  function makeResponse(body, status, sourceHeaders) {
    var headers = new Headers(sourceHeaders || {});
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(body, { status: status, headers: headers });
  }

  function safeJson(value) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  function stringify(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    return JSON.stringify(value);
  }

  function compact(object) {
    return Object.fromEntries(
      Object.entries(object).filter(function (entry) {
        return entry[1] !== undefined;
      })
    );
  }

  function randomId(prefix) {
    if (crypto && typeof crypto.randomUUID === "function") {
      return prefix + crypto.randomUUID();
    }
    return (
      prefix + Date.now().toString(36) + Math.random().toString(36).slice(2)
    );
  }

  function seedNativeDefaults() {
    if (typeof indexedDB === "undefined") return Promise.resolve();

    return new Promise(function (resolve, reject) {
      var opening = indexedDB.open("aurora-local-ai", 1);

      opening.onupgradeneeded = function () {
        if (!opening.result.objectStoreNames.contains("workspace")) {
          opening.result.createObjectStore("workspace");
        }
      };

      opening.onerror = function () {
        reject(opening.error || new Error("无法打开应用本地数据库"));
      };

      opening.onsuccess = function () {
        var database = opening.result;
        var transaction = database.transaction("workspace", "readwrite");
        var store = transaction.objectStore("workspace");
        var reading = store.get("providers");

        reading.onerror = function () {
          reject(reading.error || new Error("无法读取应用配置"));
        };

        reading.onsuccess = function () {
          if (reading.result == null) {
            store.put(
              [
                {
                  id: "gpt",
                  model: "gpt-5.6-sol",
                  baseUrl: "https://tokenclub.info",
                },
                {
                  id: "relay",
                  model: "gpt-5.6-sol",
                  baseUrl: "https://tokenclub.info",
                },
              ],
              "providers"
            );
          }
        };

        transaction.oncomplete = function () {
          database.close();
          resolve();
        };

        transaction.onerror = function () {
          reject(transaction.error || new Error("无法保存应用默认配置"));
        };
      };
    });
  }
})();
