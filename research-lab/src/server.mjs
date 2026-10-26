import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  LAB_ENVIRONMENT,
  MAX_BODY_BYTES,
} from "./constants.mjs";
import { LabStore, LabStoreError } from "./store.mjs";

export function createLabServer({ store, labKey }) {
  if (!(store instanceof LabStore)) throw new TypeError("store must be a LabStore");
  if (typeof labKey !== "string" || labKey.length < 32) throw new TypeError("labKey is too short");

  return createServer(async (request, response) => {
    try {
      setSecurityHeaders(response);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        return sendHomePage(response);
      }

      if (method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          status: "ok",
          environment: LAB_ENVIRONMENT,
          external_network_enabled: false,
          synthetic_identities_only: true,
        });
      }

      requireLabKey(request, labKey);

      if (method === "GET" && url.pathname === "/api/lab/accounts") {
        return sendData(response, 200, store.listAccounts());
      }

      if (method === "POST" && url.pathname === "/api/lab/accounts/batch") {
        const body = await readJson(request);
        return sendData(response, 201, store.createAccounts(body.count, body.quota_limit));
      }

      if (method === "POST" && url.pathname === "/api/lab/devices") {
        const body = await readJson(request);
        return sendData(response, 201, store.createVirtualDevice(body.label));
      }

      if (method === "POST" && url.pathname === "/api/lab/devices/rotate") {
        const body = await readJson(request);
        return sendData(response, 200, store.rotateVirtualDevice(body.current_virtual_device_id));
      }

      if (method === "POST" && url.pathname === "/api/lab/sessions/issue") {
        const body = await readJson(request);
        return sendData(
          response,
          201,
          store.issueSession(body.account_id, body.virtual_device_id ?? null),
        );
      }

      if (method === "POST" && url.pathname === "/api/lab/sessions/revoke") {
        return sendData(response, 200, store.revokeSession(bearerToken(request)));
      }

      if (method === "POST" && url.pathname === "/api/lab/usage/consume") {
        const body = await readJson(request);
        const token = bearerToken(request);
        return sendData(response, 200, store.consume(token, body.units));
      }

      if (method === "GET" && url.pathname.startsWith("/api/lab/usage/")) {
        const accountId = decodeURIComponent(url.pathname.slice("/api/lab/usage/".length));
        return sendData(response, 200, store.usage(accountId));
      }

      if (method === "POST" && url.pathname === "/api/lab/switch/next") {
        const body = await readJson(request);
        return sendData(
          response,
          200,
          store.switchNext(body.current_account_id ?? null, body.virtual_device_id),
        );
      }

      if (method === "POST" && url.pathname === "/api/lab/cycle/reset") {
        const body = await readJson(request);
        return sendData(response, 200, store.resetCycle(body.account_id ?? null));
      }

      if (method === "GET" && url.pathname === "/api/lab/audit") {
        return sendData(response, 200, store.auditEvents(url.searchParams.get("limit") ?? 100));
      }

      throw new HttpError(404, "LAB_ROUTE_NOT_FOUND", "本地实验接口不存在");
    } catch (error) {
      handleError(response, error);
    }
  });
}

class HttpError extends Error {
  constructor(status, code, message, shouldSwitch = false) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.shouldSwitch = shouldSwitch;
  }
}

function requireLabKey(request, expected) {
  const supplied = String(request.headers["x-lab-key"] ?? "");
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new HttpError(401, "LAB_UNAUTHORIZED", "缺少或错误的本地实验室密钥");
  }
}

function bearerToken(request) {
  const header = String(request.headers.authorization ?? "");
  if (!header.startsWith("Bearer ")) {
    throw new HttpError(401, "LAB_TOKEN_REQUIRED", "请提供本地实验室 Bearer Token");
  }
  return header.slice("Bearer ".length);
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "LAB_JSON_REQUIRED", "请求必须使用 application/json");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "LAB_BODY_TOO_LARGE", "请求体超过 64 KiB");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "LAB_INVALID_JSON", "JSON 格式无效");
  }
}

function handleError(response, error) {
  if (response.headersSent) return response.end();
  if (error instanceof HttpError) {
    return sendError(response, error.status, error.code, error.message, error.shouldSwitch);
  }
  if (error instanceof LabStoreError) {
    if (error.kind === "invalid") {
      return sendError(response, 400, "LAB_INVALID_INPUT", error.message);
    }
    if (error.kind === "not_found") {
      return sendError(response, 404, "LAB_NOT_FOUND", error.message);
    }
    if (error.kind === "quota") {
      const usage = error.extra.usage;
      return sendError(
        response,
        429,
        "LAB_QUOTA_EXHAUSTED",
        `模拟额度不足：已使用 ${usage.quota_used}/${usage.quota_limit}，剩余 ${usage.quota_remaining}`,
        true,
      );
    }
  }
  console.error("research-lab internal error", error instanceof Error ? error.message : error);
  return sendError(response, 500, "LAB_INTERNAL_ERROR", "本地实验服务发生内部错误");
}

function sendData(response, status, data) {
  sendJson(response, status, { environment: LAB_ENVIRONMENT, data });
}

function sendError(response, status, code, message, shouldSwitch = false) {
  sendJson(response, status, {
    environment: LAB_ENVIRONMENT,
    error: { code, message, should_switch: shouldSwitch },
  });
}

function sendJson(response, status, body) {
  const serialized = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(serialized));
  response.end(serialized);
}

function sendHomePage(response) {
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>本地研究沙盒</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, "PingFang SC", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6fb; color: #172033; }
    main { width: min(620px, calc(100% - 40px)); padding: 36px; border-radius: 20px; background: white; box-shadow: 0 18px 60px rgba(38, 52, 85, .12); }
    .status { display: inline-flex; gap: 8px; align-items: center; padding: 7px 12px; border-radius: 999px; background: #eaf8ef; color: #187a40; font-weight: 700; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #22a957; }
    h1 { margin: 22px 0 10px; font-size: 30px; }
    p { line-height: 1.75; color: #536078; }
    code { padding: 3px 7px; border-radius: 6px; background: #eef1f6; color: #2e3b55; }
    a { display: inline-block; margin-top: 12px; color: #315efb; font-weight: 700; text-decoration: none; }
    @media (prefers-color-scheme: dark) {
      body { background: #11151d; color: #eef3ff; }
      main { background: #1a202b; box-shadow: none; }
      p { color: #aeb9cc; }
      code { background: #2a3342; color: #e8edfa; }
      .status { background: #143522; color: #78d99a; }
    }
  </style>
</head>
<body>
  <main>
    <div class="status"><span class="dot"></span>服务运行正常</div>
    <h1>本地研究沙盒</h1>
    <p>这是仅在本机运行的合成账号、令牌、虚拟设备与额度状态机。它不连接 Cursor 或任何第三方服务。</p>
    <p>管理接口继续由 <code>X-Lab-Key</code> 保护，直接在浏览器地址栏访问管理接口会返回“未授权”，这是正常的安全行为。</p>
    <a href="/health">查看健康状态 →</a>
  </main>
</body>
</html>`;
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function setSecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-lab-only", "true");
}

function parseArgs(args) {
  const config = {
    port: DEFAULT_PORT,
    dataDir: resolve(".lab-data"),
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      config.port = Number(args[++index]);
      if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
        throw new Error("端口必须是 1024 到 65535 之间的整数");
      }
    } else if (argument === "--data-dir") {
      const value = args[++index];
      if (!value) throw new Error("--data-dir 缺少路径");
      config.dataDir = resolve(value);
    } else if (argument === "--help" || argument === "-h") {
      config.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return config;
}

function loadOrCreateLabKey(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "lab-key.txt");
  if (existsSync(path)) {
    const key = readFileSync(path, "utf8").trim();
    if (!key.startsWith("lab_admin_") || key.length < 32) {
      throw new Error("现有实验室密钥文件格式无效");
    }
    return { key, path };
  }
  const key = `lab_admin_${randomUUID().replaceAll("-", "")}`;
  writeFileSync(path, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs are managed by the OS; mode changes may be unavailable.
  }
  return { key, path };
}

function printHelp() {
  console.log(`usage-companion-research-lab

本地模拟账号、令牌、虚拟设备和额度服务。不会连接 Cursor 或任何第三方服务。

参数：
  --port <端口>       默认 17840，仅监听 127.0.0.1
  --data-dir <目录>   默认 ./.lab-data
  --help              显示帮助`);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) return printHelp();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const { key, path: keyPath } = loadOrCreateLabKey(config.dataDir);
  const databasePath = join(config.dataDir, "research-lab.sqlite3");
  const store = new LabStore(databasePath);
  const server = createLabServer({ store, labKey: key });

  server.listen(config.port, "127.0.0.1", () => {
    console.log("LOCAL RESEARCH LAB — synthetic identities only");
    console.log(`listening=http://127.0.0.1:${config.port}`);
    console.log(`key_file=${keyPath}`);
    console.log(`database=${databasePath}`);
    console.log("external_network=false");
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`研究沙盒启动失败：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

