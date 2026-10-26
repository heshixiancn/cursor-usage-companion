export type Connection = {
  id: string;
  label: string;
  provider: string;
  account_hint: string;
  secret_saved: boolean;
  created_at: string;
  updated_at: string;
};

export type UsageSnapshot = {
  used: number;
  limit: number;
  unit: string;
  source: string;
  updated_at: string;
  resets_at: string | null;
};

export type Settings = {
  warning_threshold: number;
  critical_threshold: number;
  notifications_enabled: boolean;
  refresh_interval_minutes: number;
};

export type PlatformInfo = {
  os: string;
  arch: string;
  credential_store_available: boolean;
  cursor_detected: boolean;
  cursor_path: string | null;
};

export type AppSnapshot = {
  settings: Settings;
  connections: Connection[];
  usage: UsageSnapshot;
  platform: PlatformInfo;
};

export type ConnectionInput = {
  id?: string;
  label: string;
  provider: string;
  account_hint: string;
  secret: string;
};

export type LabAccount = {
  id: string;
  label: string;
  email: string;
  status: string;
  quota_limit: number;
  quota_used: number;
  created_at: string;
};

export type LabAuditEvent = {
  id: number;
  event_type: string;
  account_id: string | null;
  virtual_device_id: string | null;
  detail: string;
  created_at: string;
};

export type LabGrant = {
  account_id: string;
  access_token: string;
  token_type: "LabBearer";
  virtual_device_id: string;
  quota_limit: number;
  quota_used: number;
  expires_in_seconds: number;
  expires_at: string;
};

export type LabHttpResponse<T = unknown> = {
  status: number;
  body: {
    environment: "local-research-lab";
    data?: T;
    error?: {
      code: string;
      message: string;
      should_switch: boolean;
    };
    status?: string;
    external_network_enabled?: boolean;
    synthetic_identities_only?: boolean;
  };
};

