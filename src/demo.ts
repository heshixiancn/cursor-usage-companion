import type { AppSnapshot } from "./types";

export const demoSnapshot: AppSnapshot = {
  settings: {
    warning_threshold: 70,
    critical_threshold: 90,
    notifications_enabled: true,
    refresh_interval_minutes: 15,
  },
  connections: [
    {
      id: "demo-openai",
      label: "工作用 API Key",
      provider: "openai",
      account_hint: "dev@company.com",
      secret_saved: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  usage: {
    used: 32.4,
    limit: 100,
    unit: "美元",
    source: "手动录入",
    updated_at: new Date().toISOString(),
    resets_at: null,
  },
  platform: {
    os: "macOS",
    arch: "arm64",
    credential_store_available: true,
    cursor_detected: true,
    cursor_path: "/Applications/Cursor.app",
  },
};

