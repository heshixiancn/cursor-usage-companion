import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LAB_TOKEN_PREFIX, VIRTUAL_DEVICE_PREFIX } from "./constants.mjs";

export class LabStoreError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "LabStoreError";
    this.kind = kind;
    this.extra = extra;
  }
}

export class LabStore {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        quota_limit INTEGER NOT NULL,
        quota_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS virtual_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        generation INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        virtual_device_id TEXT NOT NULL REFERENCES virtual_devices(id),
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        account_id TEXT,
        virtual_device_id TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!sessionColumns.some((column) => column.name === "expires_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
      this.db.exec("UPDATE sessions SET revoked = 1, expires_at = created_at WHERE expires_at IS NULL");
    }
  }

  close() {
    this.db.close();
  }

  createAccounts(count, quotaLimit) {
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new LabStoreError("invalid", "每次只能生成 1 到 20 个模拟账号");
    }
    if (!Number.isInteger(quotaLimit) || quotaLimit < 10 || quotaLimit > 1_000_000) {
      throw new LabStoreError("invalid", "模拟额度必须在 10 到 1,000,000 之间");
    }
    const insert = this.db.prepare(`
      INSERT INTO accounts (id, label, email, status, quota_limit, quota_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const accounts = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < count; index += 1) {
        const suffix = compactId(12);
        const account = {
          id: `acct_${suffix}`,
          label: `模拟账号 ${index + 1}`,
          email: `${suffix}@example.invalid`,
          status: "active",
          quota_limit: quotaLimit,
          quota_used: 0,
          created_at: now(),
        };
        insert.run(
          account.id,
          account.label,
          account.email,
          account.status,
          account.quota_limit,
          account.quota_used,
          account.created_at,
        );
        accounts.push(account);
      }
      this.#audit("accounts_created", null, null, `count=${count}`);
      this.db.exec("COMMIT");
      return accounts;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listAccounts() {
    return this.db
      .prepare(`
        SELECT id, label, email, status, quota_limit, quota_used, created_at
        FROM accounts ORDER BY created_at ASC, id ASC
      `)
      .all();
  }

  createVirtualDevice(label = "本地模拟设备") {
    const device = {
      id: `${VIRTUAL_DEVICE_PREFIX}${compactId(16)}`,
      label: normalizeLabel(label),
      generation: 1,
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO virtual_devices (id, label, generation, created_at) VALUES (?, ?, ?, ?)")
      .run(device.id, device.label, device.generation, device.created_at);
    this.#audit("virtual_device_created", null, device.id, "application-scoped synthetic identifier");
    return device;
  }

  rotateVirtualDevice(currentId) {
    ensureVirtualDeviceId(currentId);
    const current = this.db
      .prepare("SELECT label, generation FROM virtual_devices WHERE id = ?")
      .get(currentId);
    if (!current) throw new LabStoreError("not_found", "找不到当前虚拟设备");
    const device = {
      id: `${VIRTUAL_DEVICE_PREFIX}${compactId(16)}`,
      label: current.label,
      generation: Number(current.generation) + 1,
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO virtual_devices (id, label, generation, created_at) VALUES (?, ?, ?, ?)")
      .run(device.id, device.label, device.generation, device.created_at);
    this.#audit(
      "virtual_device_rotated",
      null,
      device.id,
      `previous=${currentId}; generation=${device.generation}`,
    );
    return device;
  }

  issueSession(accountId, virtualDeviceId = null) {
    const deviceId = virtualDeviceId ?? this.createVirtualDevice("自动创建的模拟设备").id;
    ensureVirtualDeviceId(deviceId);
    const account = this.#findAccount(accountId);
    if (account.status !== "active") throw new LabStoreError("invalid", "模拟账号不是可用状态");
    const device = this.db.prepare("SELECT id FROM virtual_devices WHERE id = ?").get(deviceId);
    if (!device) throw new LabStoreError("not_found", "找不到虚拟设备");

    const token = `${LAB_TOKEN_PREFIX}${randomUUID().replaceAll("-", "")}`;
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    this.db
      .prepare(`
        INSERT INTO sessions
          (token_hash, account_id, virtual_device_id, revoked, created_at, expires_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `)
      .run(hashToken(token), account.id, deviceId, createdAt, expiresAt);
    this.#audit("session_issued", account.id, deviceId, "opaque local lab token issued");
    return {
      account_id: account.id,
      access_token: token,
      token_type: "LabBearer",
      virtual_device_id: deviceId,
      quota_limit: Number(account.quota_limit),
      quota_used: Number(account.quota_used),
      expires_in_seconds: 3600,
      expires_at: expiresAt,
    };
  }

  revokeSession(token) {
    ensureLabToken(token);
    const session = this.db
      .prepare("SELECT account_id, virtual_device_id FROM sessions WHERE token_hash = ?")
      .get(hashToken(token));
    if (!session) throw new LabStoreError("not_found", "模拟令牌不存在");
    const result = this.db
      .prepare("UPDATE sessions SET revoked = 1 WHERE token_hash = ? AND revoked = 0")
      .run(hashToken(token));
    this.#audit(
      "session_revoked",
      session.account_id,
      session.virtual_device_id,
      `changed=${Number(result.changes)}`,
    );
    return { revoked: true, already_revoked: Number(result.changes) === 0 };
  }

  consume(token, units) {
    ensureLabToken(token);
    if (!Number.isInteger(units) || units < 1 || units > 100_000) {
      throw new LabStoreError("invalid", "每次模拟消耗必须在 1 到 100,000 之间");
    }
    const session = this.db
      .prepare(`
        SELECT account_id, virtual_device_id, expires_at FROM sessions
        WHERE token_hash = ? AND revoked = 0
      `)
      .get(hashToken(token));
    if (!session) throw new LabStoreError("not_found", "模拟令牌不存在或已失效");
    if (!session.expires_at || Date.parse(session.expires_at) <= Date.now()) {
      this.db.prepare("UPDATE sessions SET revoked = 1 WHERE token_hash = ?").run(hashToken(token));
      this.#audit("session_expired", session.account_id, session.virtual_device_id, "token expired");
      throw new LabStoreError("not_found", "模拟令牌已过期");
    }
    const account = this.#findAccount(session.account_id);
    const nextUsed = Number(account.quota_used) + units;
    if (nextUsed > Number(account.quota_limit)) {
      const usage = usageFrom(account);
      this.#audit(
        "quota_rejected",
        account.id,
        session.virtual_device_id,
        `requested_units=${units}`,
      );
      throw new LabStoreError("quota", "模拟额度已用尽", { usage });
    }
    this.db.prepare("UPDATE accounts SET quota_used = ? WHERE id = ?").run(nextUsed, account.id);
    this.#audit(
      "quota_consumed",
      account.id,
      session.virtual_device_id,
      `units=${units}; used=${nextUsed}`,
    );
    return {
      account_id: account.id,
      accepted_units: units,
      quota_limit: Number(account.quota_limit),
      quota_used: nextUsed,
      quota_remaining: Number(account.quota_limit) - nextUsed,
      should_switch: nextUsed >= Number(account.quota_limit),
    };
  }

  usage(accountId) {
    return usageFrom(this.#findAccount(accountId));
  }

  switchNext(currentAccountId, virtualDeviceId) {
    ensureVirtualDeviceId(virtualDeviceId);
    const candidate = this.db
      .prepare(`
        SELECT id FROM accounts
        WHERE status = 'active' AND quota_used < quota_limit
          AND (? IS NULL OR id <> ?)
        ORDER BY (CAST(quota_used AS REAL) / quota_limit) ASC, created_at ASC, id ASC
        LIMIT 1
      `)
      .get(currentAccountId ?? null, currentAccountId ?? null);
    if (!candidate) throw new LabStoreError("not_found", "没有剩余额度可用的模拟账号");
    const grant = this.issueSession(candidate.id, virtualDeviceId);
    this.#audit(
      "synthetic_account_switched",
      candidate.id,
      virtualDeviceId,
      `previous=${currentAccountId ?? "none"}`,
    );
    return grant;
  }

  resetCycle(accountId = null) {
    let result;
    if (accountId) {
      result = this.db.prepare("UPDATE accounts SET quota_used = 0 WHERE id = ?").run(accountId);
      if (Number(result.changes) === 0) throw new LabStoreError("not_found", "找不到模拟账号");
    } else {
      result = this.db.prepare("UPDATE accounts SET quota_used = 0").run();
    }
    const resetAccounts = Number(result.changes);
    this.#audit("cycle_reset", accountId, null, `reset_accounts=${resetAccounts}`);
    return { reset_accounts: resetAccounts };
  }

  auditEvents(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db
      .prepare(`
        SELECT id, event_type, account_id, virtual_device_id, detail, created_at
        FROM audit_events ORDER BY id DESC LIMIT ?
      `)
      .all(safeLimit);
  }

  #findAccount(accountId) {
    const account = this.db
      .prepare(`
        SELECT id, label, email, status, quota_limit, quota_used, created_at
        FROM accounts WHERE id = ?
      `)
      .get(accountId);
    if (!account) throw new LabStoreError("not_found", "找不到模拟账号");
    return account;
  }

  #audit(eventType, accountId, virtualDeviceId, detail) {
    this.db
      .prepare(`
        INSERT INTO audit_events (event_type, account_id, virtual_device_id, detail, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(eventType, accountId, virtualDeviceId, detail, now());
  }
}

function usageFrom(account) {
  const limit = Number(account.quota_limit);
  const used = Number(account.quota_used);
  const remaining = Math.max(0, limit - used);
  return {
    account_id: account.id,
    quota_limit: limit,
    quota_used: used,
    quota_remaining: remaining,
    quota_percent: Math.min(100, (used / limit) * 100),
    exhausted: remaining === 0,
  };
}

function ensureVirtualDeviceId(value) {
  if (typeof value !== "string" || !value.startsWith(VIRTUAL_DEVICE_PREFIX) || value.length > 64) {
    throw new LabStoreError("invalid", "虚拟设备 ID 格式无效");
  }
}

function ensureLabToken(token) {
  if (typeof token !== "string" || !token.startsWith(LAB_TOKEN_PREFIX) || token.length > 96) {
    throw new LabStoreError("invalid", "只接受本地实验室令牌");
  }
}

function normalizeLabel(value) {
  const label = String(value ?? "").trim();
  return (label || "本地模拟设备").slice(0, 64);
}

function compactId(length) {
  return randomUUID().replaceAll("-", "").slice(0, length);
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function now() {
  return new Date().toISOString();
}

