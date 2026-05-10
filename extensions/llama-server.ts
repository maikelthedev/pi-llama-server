// ~/.pi/agent/extensions/llama-server.ts
// Pi extension for llama-server router integration
//
// Configure per-project via .pi/llama-server.json:
//   { "url": "http://10.0.0.5:9090", "apiKey": "your-key" }
//
// Or globally via env: LLAMA_SERVER_URL=http://host:port
// And optionally: LLAMA_SERVER_API_KEY=your-key
// Defaults to http://127.0.0.1:8080 with no API key

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function resolveConfig(cwd: string): { url: string; apiKey?: string } {
  // 1. per-project config
  try {
    const raw = readFileSync(join(cwd, ".pi", "llama-server.json"), "utf-8");
    const cfg = JSON.parse(raw);
    if (cfg.url) {
      return {
        url: cfg.url,
        apiKey: cfg.apiKey,
      };
    }
  } catch {
    // file doesn't exist or isn't valid JSON — that's fine
  }
  // 2. env, 3. default
  return {
    url: process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080",
    apiKey: process.env.LLAMA_SERVER_API_KEY,
  };
}

function rpc(base: string, method: string, body?: Record<string, unknown>, apiKey?: string) {
  const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return fetch(`${base}${method}`, {
    method: body ? "POST" : "GET",
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  });
}

interface ServerModel {
  id: string;
  status: { value: string };
}

async function listModels(base: string, apiKey?: string): Promise<ServerModel[]> {
  const data = (await rpc(base, "/models", undefined, apiKey)) as {
    data?: ServerModel[];
  };
  return (data.data ?? []).filter(
    (m) => m.id && m.id !== "llama-server" && m.id !== "main"
  );
}

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // ---- fetch & register ----
  const config = resolveConfig(cwd);
  const url = config.url;
  let serverModels: ServerModel[];

  try {
    serverModels = await listModels(url);
  } catch (e) {
    pi.registerCommand("models", {
      description: "llama-server models (offline)",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `llama-server unreachable at ${resolveUrl(ctx.cwd)}`,
          "error"
        );
      },
    });
    return;
  }

  const modelDefs = serverModels.map((m) => ({
    id: String(m.id),
    name: String(m.id),
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));

  if (modelDefs.length > 0) {
    pi.registerProvider("llama-server", {
      baseUrl: `${url}/v1`,
      api: "openai-completions",
      apiKey: config.apiKey || "not-needed",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: modelDefs,
    });
  }

  // ---- model_select: tell server to load ----
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider !== "llama-server") return;
    try {
      const config = resolveConfig(ctx.cwd);
      await rpc(config.url, "/models/load", {
        model: event.model.id,
      }, config.apiKey);
    } catch {
      // server may have autoload
    }
  });

  // ---- /models — live browser ----
  pi.registerCommand("models", {
    description: "Browse llama-server models (live status)",
    handler: async (_args, ctx) => {
      const config = resolveConfig(ctx.cwd);
      let models: ServerModel[];
      try {
        models = await listModels(config.url, config.apiKey);
      } catch (e) {
        ctx.ui.notify(`llama-server: ${e}`, "error");
        return;
      }

      const labels = models.map((m) => {
        const c =
          m.status.value === "loaded" ? "🟢"
          : m.status.value === "loading" ? "🟡"
          : m.status.value === "failed" ? "🔴"
          : "⚪";
        return `${c} ${m.id}`;
      });

      const choice = await ctx.ui.select("llama-server models:", labels);
      if (choice == null) return;

      const idx = labels.indexOf(choice);
      const model = models[idx];

      const actions =
        model.status.value === "loaded"
          ? ["Switch (use /model or Ctrl+P)", "Unload", "Cancel"]
          : ["Load & switch", "Cancel"];

      const action = await ctx.ui.select(`${model.id}`, actions);
      if (!action || action === "Cancel") return;

      if (action === "Unload") {
        await rpc(config.url, "/models/unload", { model: model.id }, config.apiKey);
        ctx.ui.notify(`Unloaded ${model.id}`, "success");
      } else {
        if (model.status.value !== "loaded") {
          await rpc(config.url, "/models/load", { model: model.id }, config.apiKey);
        }
        ctx.ui.notify(
          `Model ${model.id} ready — use /model or Ctrl+P to switch`,
          "info"
        );
      }
    },
  });
};
