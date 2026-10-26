import assert from "node:assert/strict";
import test from "node:test";
import { LAB_TOKEN_PREFIX, VIRTUAL_DEVICE_PREFIX } from "../src/constants.mjs";
import { LabStore, LabStoreError } from "../src/store.mjs";

function seededStore() {
  const store = new LabStore();
  store.createAccounts(2, 100);
  return store;
}

test("synthetic accounts always use the reserved invalid domain", () => {
  const store = seededStore();
  try {
    const accounts = store.listAccounts();
    assert.equal(accounts.length, 2);
    assert.ok(accounts.every((account) => account.email.endsWith("@example.invalid")));
  } finally {
    store.close();
  }
});

test("issued tokens are lab-scoped and only hashes are stored", () => {
  const store = seededStore();
  try {
    const account = store.listAccounts()[0];
    const grant = store.issueSession(account.id);
    assert.ok(grant.access_token.startsWith(LAB_TOKEN_PREFIX));
    const stored = store.db.prepare("SELECT token_hash FROM sessions LIMIT 1").get();
    assert.notEqual(stored.token_hash, grant.access_token);
    assert.equal(stored.token_hash.length, 64);
  } finally {
    store.close();
  }
});

test("quota rejection returns a switch signal without changing usage", () => {
  const store = seededStore();
  try {
    const account = store.listAccounts()[0];
    const grant = store.issueSession(account.id);
    store.consume(grant.access_token, 80);
    assert.throws(
      () => store.consume(grant.access_token, 30),
      (error) => error instanceof LabStoreError && error.kind === "quota",
    );
    assert.equal(store.usage(account.id).quota_used, 80);
  } finally {
    store.close();
  }
});

test("virtual device rotation only changes an application-scoped identifier", () => {
  const store = seededStore();
  try {
    const device = store.createVirtualDevice("test");
    const rotated = store.rotateVirtualDevice(device.id);
    assert.ok(device.id.startsWith(VIRTUAL_DEVICE_PREFIX));
    assert.ok(rotated.id.startsWith(VIRTUAL_DEVICE_PREFIX));
    assert.notEqual(rotated.id, device.id);
    assert.equal(rotated.generation, 2);
  } finally {
    store.close();
  }
});

test("switch chooses another synthetic account", () => {
  const store = seededStore();
  try {
    const accounts = store.listAccounts();
    const device = store.createVirtualDevice();
    const grant = store.switchNext(accounts[0].id, device.id);
    assert.equal(grant.account_id, accounts[1].id);
  } finally {
    store.close();
  }
});

test("cycle reset clears only simulated usage", () => {
  const store = seededStore();
  try {
    const account = store.listAccounts()[0];
    const grant = store.issueSession(account.id);
    store.consume(grant.access_token, 50);
    assert.equal(store.resetCycle(account.id).reset_accounts, 1);
    assert.equal(store.usage(account.id).quota_used, 0);
  } finally {
    store.close();
  }
});

test("non-lab tokens are rejected", () => {
  const store = seededStore();
  try {
    assert.throws(
      () => store.consume("real-or-foreign-token", 1),
      (error) => error instanceof LabStoreError && error.kind === "invalid",
    );
  } finally {
    store.close();
  }
});

test("revoked tokens can no longer consume simulated quota", () => {
  const store = seededStore();
  try {
    const account = store.listAccounts()[0];
    const grant = store.issueSession(account.id);
    const result = store.revokeSession(grant.access_token);
    assert.equal(result.revoked, true);
    assert.throws(
      () => store.consume(grant.access_token, 1),
      (error) => error instanceof LabStoreError && error.kind === "not_found",
    );
    assert.equal(store.usage(account.id).quota_used, 0);
  } finally {
    store.close();
  }
});

test("expired tokens are rejected and marked revoked", () => {
  const store = seededStore();
  try {
    const account = store.listAccounts()[0];
    const grant = store.issueSession(account.id);
    store.db.prepare("UPDATE sessions SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    assert.throws(
      () => store.consume(grant.access_token, 1),
      (error) => error instanceof LabStoreError && error.kind === "not_found",
    );
    const session = store.db.prepare("SELECT revoked FROM sessions LIMIT 1").get();
    assert.equal(session.revoked, 1);
  } finally {
    store.close();
  }
});

