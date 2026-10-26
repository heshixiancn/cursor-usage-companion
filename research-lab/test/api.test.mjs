import assert from "node:assert/strict";
import test from "node:test";
import { createLabServer } from "../src/server.mjs";
import { LabStore } from "../src/store.mjs";

async function withServer(run) {
  const store = new LabStore();
  const labKey = "lab_admin_test_key_12345678901234567890";
  const server = createLabServer({ store, labKey });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, labKey, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

test("health endpoint declares the isolation boundary", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.environment, "local-research-lab");
    assert.equal(body.external_network_enabled, false);
    assert.equal(body.synthetic_identities_only, true);
    assert.equal(response.headers.get("x-lab-only"), "true");
  });
});

test("root page is browser friendly and does not require a lab key", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(body, /服务运行正常/);
    assert.match(body, /X-Lab-Key/);
  });
});

test("management APIs reject requests without a lab key", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/lab/accounts`);
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "LAB_UNAUTHORIZED");
  });
});

test("end-to-end quota exhaustion returns HTTP 429 and switch signal", async () => {
  await withServer(async ({ baseUrl, labKey }) => {
    const headers = { "content-type": "application/json", "x-lab-key": labKey };
    const accountResponse = await fetch(`${baseUrl}/api/lab/accounts/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ count: 2, quota_limit: 100 }),
    });
    const accountBody = await accountResponse.json();
    const account = accountBody.data[0];

    const sessionResponse = await fetch(`${baseUrl}/api/lab/sessions/issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ account_id: account.id }),
    });
    const sessionBody = await sessionResponse.json();
    const token = sessionBody.data.access_token;

    const first = await fetch(`${baseUrl}/api/lab/usage/consume`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${token}` },
      body: JSON.stringify({ units: 80 }),
    });
    assert.equal(first.status, 200);

    const exhausted = await fetch(`${baseUrl}/api/lab/usage/consume`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${token}` },
      body: JSON.stringify({ units: 30 }),
    });
    const exhaustedBody = await exhausted.json();
    assert.equal(exhausted.status, 429);
    assert.equal(exhaustedBody.error.code, "LAB_QUOTA_EXHAUSTED");
    assert.equal(exhaustedBody.error.should_switch, true);

    const usage = await fetch(`${baseUrl}/api/lab/usage/${account.id}`, {
      headers: { "x-lab-key": labKey },
    });
    const usageBody = await usage.json();
    assert.equal(usageBody.data.quota_used, 80);
  });
});

test("session revoke endpoint invalidates the local token", async () => {
  await withServer(async ({ baseUrl, labKey }) => {
    const headers = { "content-type": "application/json", "x-lab-key": labKey };
    const accountResponse = await fetch(`${baseUrl}/api/lab/accounts/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ count: 1, quota_limit: 100 }),
    });
    const account = (await accountResponse.json()).data[0];
    const sessionResponse = await fetch(`${baseUrl}/api/lab/sessions/issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ account_id: account.id }),
    });
    const token = (await sessionResponse.json()).data.access_token;

    const revoked = await fetch(`${baseUrl}/api/lab/sessions/revoke`, {
      method: "POST",
      headers: { "x-lab-key": labKey, authorization: `Bearer ${token}` },
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).data.revoked, true);

    const consume = await fetch(`${baseUrl}/api/lab/usage/consume`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${token}` },
      body: JSON.stringify({ units: 1 }),
    });
    assert.equal(consume.status, 404);
    assert.equal((await consume.json()).error.code, "LAB_NOT_FOUND");
  });
});

