import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import { demoSnapshot } from "./demo";
import type {
  AppSnapshot,
  Connection,
  ConnectionInput,
  LabAccount,
  LabAuditEvent,
  LabGrant,
  LabHttpResponse,
  Settings,
  UsageSnapshot,
} from "./types";

type Page = "overview" | "connections" | "lab" | "settings";
type Modal = "connection" | "usage" | null;

type LabState = {
  loading: boolean;
  online: boolean;
  message: string;
  accounts: LabAccount[];
  audit: LabAuditEvent[];
  currentAccountId: string | null;
  virtualDeviceId: string | null;
  token: string | null;
  tokenExpiresAt: string | null;
};

let snapshot: AppSnapshot;
let page: Page = "overview";
let modal: Modal = null;
let runtime: "desktop" | "preview" = "desktop";
let toastTimer: number | undefined;
let lab: LabState = {
  loading: false,
  online: false,
  message: "尚未连接本地研究服务",
  accounts: [],
  audit: [],
  currentAccountId: null,
  virtualDeviceId: null,
  token: null,
  tokenExpiresAt: null,
};

const root = document.querySelector<HTMLDivElement>("#app")!;
if (!root) throw new Error("找不到应用挂载节点");

const providerNames: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google AI",
  "cursor-byok": "Cursor 自有密钥",
  other: "其他服务",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function usagePercent(): number {
  if (!snapshot.usage.limit) return 0;
  return Math.min(100, Math.max(0, (snapshot.usage.used / snapshot.usage.limit) * 100));
}

function usageStatus(): { label: string; tone: string; detail: string } {
  const percent = usagePercent();
  if (percent >= snapshot.settings.critical_threshold) {
    return { label: "需要处理", tone: "danger", detail: "建议检查官方按量计费或更高套餐" };
  }
  if (percent >= snapshot.settings.warning_threshold) {
    return { label: "接近阈值", tone: "warning", detail: "用量已接近预设提醒线" };
  }
  return { label: "状态良好", tone: "success", detail: "当前用量处于安全范围" };
}

function icon(name: string): string {
  const icons: Record<string, string> = {
    overview: '<svg viewBox="0 0 24 24"><path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z"/></svg>',
    key: '<svg viewBox="0 0 24 24"><path d="M15.5 7.5a5 5 0 1 0-4.6 6.98L13 16.6V19h2v2h3v-3.4l-3.52-3.52A5 5 0 0 0 15.5 7.5Zm-7 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0Z"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65-2-3.46-2.49 1a7.5 7.5 0 0 0-1.69-.98L15 3.27h-4l-.4 2.66c-.61.25-1.17.58-1.69.98l-2.49-1-2 3.46 2.12 1.65c-.05.32-.08.66-.08.98s.03.66.08.98l-2.12 1.65 2 3.46 2.49-1c.52.4 1.08.73 1.69.98l.4 2.66h4l.4-2.66c.61-.25 1.17-.58 1.69-.98l2.49 1 2-3.46-2.15-1.65ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="m12 2 8 3v6c0 5.05-3.41 9.74-8 11-4.59-1.26-8-5.95-8-11V5l8-3Zm0 4.18L8 7.68V11c0 3.15 1.93 6.33 4 7.55 2.07-1.22 4-4.4 4-7.55V7.68l-4-1.5Z"/></svg>',
    lab: '<svg viewBox="0 0 24 24"><path d="M9 2h6v2h-1v5.59l5.71 5.7A4 4 0 0 1 16.88 22H7.12a4 4 0 0 1-2.83-6.71L10 9.59V4H9V2Zm3 8.41-2.3 2.3h4.6L12 10.41Zm-4.88 9.58h9.76a2 2 0 0 0 1.42-3.41L16.7 15H7.3l-1.6 1.58A2 2 0 0 0 7.12 20Z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-3.35 3.35Z"/></svg>',
    device: '<svg viewBox="0 0 24 24"><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 3v13h10V5H7Zm4 14v1h2v-1h-2Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="m15.23 5.21 3.56 3.56L8.56 19H5v-3.56L15.23 5.21Zm1.41-1.41 1.77-1.77 3.56 3.56-1.77 1.77-3.56-3.56Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M8 4h8l1 2h4v2H3V6h4l1-2Zm-2 6h12l-1 11H7L6 10Z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m9.2 16.6-4.1-4.1-1.4 1.4L9.2 19.4 21 7.6l-1.4-1.4L9.2 16.6Z"/></svg>',
  };
  return icons[name] ?? "";
}

function providerBadge(provider: string): string {
  const initials: Record<string, string> = {
    openai: "OA",
    anthropic: "AN",
    google: "GA",
    "cursor-byok": "CU",
    other: "AI",
  };
  return `<span class="provider-badge provider-${escapeHtml(provider)}">${initials[provider] ?? "AI"}</span>`;
}

function renderConnections(compact = false): string {
  if (!snapshot.connections.length) {
    return `
      <div class="empty-state">
        <div class="empty-icon">${icon("key")}</div>
        <strong>还没有连接</strong>
        <p>添加你本人拥有的 API Key，密钥只保存在系统安全存储中。</p>
        <button class="button button-primary" data-action="add-connection">${icon("plus")}添加连接</button>
      </div>`;
  }

  const visible = compact ? snapshot.connections.slice(0, 3) : snapshot.connections;
  return `<div class="connection-list">${visible
    .map(
      (connection) => `
      <article class="connection-row">
        ${providerBadge(connection.provider)}
        <div class="connection-main">
          <strong>${escapeHtml(connection.label)}</strong>
          <span>${escapeHtml(providerNames[connection.provider] ?? connection.provider)} · ${escapeHtml(connection.account_hint || "未填写账号备注")}</span>
        </div>
        <span class="secure-tag">${icon("shield")}系统安全存储</span>
        ${
          compact
            ? ""
            : `<button class="icon-button danger-icon" data-delete-id="${escapeHtml(connection.id)}" aria-label="删除连接">${icon("trash")}</button>`
        }
      </article>`,
    )
    .join("")}</div>`;
}

function overviewPage(): string {
  const percent = usagePercent();
  const remaining = Math.max(0, snapshot.usage.limit - snapshot.usage.used);
  const status = usageStatus();

  return `
    <header class="page-header">
      <div>
        <span class="eyebrow">概览</span>
        <h1>下午好，用量一目了然</h1>
        <p>只管理你授权的账号与密钥，不修改 Cursor 内部认证状态。</p>
      </div>
      <button class="button button-primary" data-action="update-usage">${icon("edit")}更新用量</button>
    </header>

    <section class="hero-grid">
      <article class="usage-card panel">
        <div class="card-heading">
          <div>
            <span class="section-label">本周期用量</span>
            <h2>${formatNumber(snapshot.usage.used)} <small>/ ${formatNumber(snapshot.usage.limit)} ${escapeHtml(snapshot.usage.unit)}</small></h2>
          </div>
          <span class="status-pill ${status.tone}"><i></i>${status.label}</span>
        </div>
        <div class="usage-visual">
          <div class="usage-ring" style="--usage:${(percent * 3.6).toFixed(1)}deg">
            <div><strong>${Math.round(percent)}%</strong><span>已使用</span></div>
          </div>
          <div class="usage-details">
            <div><span>剩余额度</span><strong>${formatNumber(remaining)} ${escapeHtml(snapshot.usage.unit)}</strong></div>
            <div><span>数据来源</span><strong>${escapeHtml(snapshot.usage.source)}</strong></div>
            <div><span>更新时间</span><strong>${formatDate(snapshot.usage.updated_at)}</strong></div>
          </div>
        </div>
        <div class="progress-track"><span style="width:${percent.toFixed(1)}%"></span></div>
        <p class="status-detail">${escapeHtml(status.detail)}</p>
      </article>

      <article class="system-card panel">
        <div class="system-top">
          <span class="section-label">运行环境</span>
          <span class="live-dot"><i></i>本机</span>
        </div>
        <div class="platform-mark">${snapshot.platform.os === "macOS" ? "⌘" : "⊞"}</div>
        <h3>${escapeHtml(snapshot.platform.os)} · ${escapeHtml(snapshot.platform.arch)}</h3>
        <ul class="check-list">
          <li>${icon("check")}系统凭证库${snapshot.platform.credential_store_available ? "可用" : "不可用"}</li>
          <li>${icon("check")}Cursor ${snapshot.platform.cursor_detected ? "已检测到" : "尚未检测到"}</li>
        </ul>
      </article>
    </section>

    <section class="stats-grid">
      <article class="stat-card"><span>已连接方式</span><strong>${snapshot.connections.length}</strong><small>全部为用户自有凭证</small></article>
      <article class="stat-card"><span>提醒阈值</span><strong>${snapshot.settings.warning_threshold}%</strong><small>严重提醒 ${snapshot.settings.critical_threshold}%</small></article>
      <article class="stat-card"><span>下次重置</span><strong class="stat-text">${snapshot.usage.resets_at ? formatDate(snapshot.usage.resets_at) : "按官方账期"}</strong><small>请以官方控制台为准</small></article>
    </section>

    <section class="panel connections-panel">
      <div class="section-header">
        <div><span class="section-label">授权连接</span><h2>我的密钥</h2></div>
        <button class="button button-quiet" data-page="connections">管理全部</button>
      </div>
      ${renderConnections(true)}
    </section>

    <section class="compliance-note">
      <div class="note-icon">${icon("shield")}</div>
      <div><strong>安全边界已启用</strong><p>本应用不创建账号、不重置机器标识、不注入 Cursor 登录令牌。密钥不会写入普通配置文件。</p></div>
    </section>`;
}

function connectionsPage(): string {
  return `
    <header class="page-header">
      <div><span class="eyebrow">连接</span><h1>授权方式</h1><p>管理你本人拥有的 API Key。应用界面永远不会回显完整密钥。</p></div>
      <button class="button button-primary" data-action="add-connection">${icon("plus")}添加连接</button>
    </header>
    <section class="panel full-panel">
      <div class="section-header">
        <div><span class="section-label">安全凭证</span><h2>${snapshot.connections.length} 个连接</h2></div>
        <span class="security-state">${icon("shield")}由 ${snapshot.platform.os === "macOS" ? "Keychain" : "Credential Manager"} 保护</span>
      </div>
      ${renderConnections(false)}
    </section>
    <section class="info-grid">
      <article><strong>目前支持</strong><p>OpenAI、Anthropic、Google AI、Cursor 中配置的自有密钥，以及其他自定义服务的凭证保管。</p></article>
      <article><strong>目前不做</strong><p>不会自动注册账号，不接管第三方会话，不尝试绕过额度、订阅或设备限制。</p></article>
    </section>`;
}

function settingsPage(): string {
  return `
    <header class="page-header">
      <div><span class="eyebrow">设置</span><h1>提醒与数据</h1><p>设置用量预警线和检查频率。</p></div>
    </header>
    <form class="panel settings-form" id="settings-form">
      <div class="setting-row">
        <div><strong>普通提醒阈值</strong><p>达到该比例时显示接近阈值。</p></div>
        <label class="number-field"><input name="warning_threshold" type="number" min="1" max="98" value="${snapshot.settings.warning_threshold}" /><span>%</span></label>
      </div>
      <div class="setting-row">
        <div><strong>严重提醒阈值</strong><p>达到该比例时提示处理用量。</p></div>
        <label class="number-field"><input name="critical_threshold" type="number" min="2" max="100" value="${snapshot.settings.critical_threshold}" /><span>%</span></label>
      </div>
      <div class="setting-row">
        <div><strong>检查间隔</strong><p>为后续官方用量接口预留；当前手动录入不主动联网。</p></div>
        <select name="refresh_interval_minutes">
          ${[5, 15, 30, 60].map((n) => `<option value="${n}" ${snapshot.settings.refresh_interval_minutes === n ? "selected" : ""}>${n} 分钟</option>`).join("")}
        </select>
      </div>
      <div class="setting-row">
        <div><strong>系统通知</strong><p>达到提醒线时允许发送本地通知。</p></div>
        <label class="switch"><input name="notifications_enabled" type="checkbox" ${snapshot.settings.notifications_enabled ? "checked" : ""}/><span></span></label>
      </div>
      <div class="form-actions"><button class="button button-primary" type="submit">保存设置</button></div>
    </form>
    <section class="panel environment-panel">
      <div><span>应用数据</span><strong>仅保存非敏感元数据与用量记录</strong></div>
      <div><span>密钥位置</span><strong>${snapshot.platform.os === "macOS" ? "macOS Keychain" : "Windows Credential Manager"}</strong></div>
      <div><span>Cursor 路径</span><strong>${escapeHtml(snapshot.platform.cursor_path ?? "未检测到")}</strong></div>
    </section>`;
}

const labEventNames: Record<string, string> = {
  accounts_created: "生成模拟账号",
  virtual_device_created: "创建虚拟设备",
  virtual_device_rotated: "轮换虚拟设备",
  session_issued: "签发本地令牌",
  session_revoked: "撤销本地令牌",
  session_expired: "本地令牌到期",
  quota_consumed: "消耗模拟额度",
  quota_rejected: "拒绝超额请求",
  synthetic_account_switched: "切换模拟账号",
  cycle_reset: "重置模拟账期",
};

function labPage(): string {
  const labDisabled = runtime !== "desktop" || lab.loading;
  const totalLimit = lab.accounts.reduce((sum, account) => sum + account.quota_limit, 0);
  const totalUsed = lab.accounts.reduce((sum, account) => sum + account.quota_used, 0);
  const current = lab.accounts.find((account) => account.id === lab.currentAccountId) ?? null;
  const tokenLabel = lab.token ? `${lab.token.slice(0, 12)}••••••••` : "未签发";
  const accountRows = lab.accounts.length
    ? lab.accounts
        .map((account) => {
          const percent = account.quota_limit
            ? Math.min(100, (account.quota_used / account.quota_limit) * 100)
            : 0;
          return `<article class="lab-account ${account.id === lab.currentAccountId ? "selected" : ""}">
            <div class="lab-account-title">
              <span class="lab-account-mark">${escapeHtml(account.label.replace("模拟账号 ", ""))}</span>
              <div><strong>${escapeHtml(account.label)}</strong><span>${escapeHtml(account.email)}</span></div>
              <button class="button button-quiet" data-lab-issue="${escapeHtml(account.id)}" ${labDisabled ? "disabled" : ""}>${account.id === lab.currentAccountId ? "重新签发" : "使用此账号"}</button>
            </div>
            <div class="lab-quota-line"><span>已用 ${account.quota_used} / ${account.quota_limit}</span><strong>${Math.round(percent)}%</strong></div>
            <div class="lab-progress"><span style="width:${percent.toFixed(1)}%"></span></div>
          </article>`;
        })
        .join("")
    : `<div class="empty-state compact"><strong>还没有模拟账号</strong><p>生成一组合成账号后即可测试额度消耗与自动切换。</p></div>`;

  const auditRows = lab.audit.length
    ? lab.audit
        .slice(0, 12)
        .map(
          (event) => `<li>
            <i class="audit-dot"></i>
            <div><strong>${escapeHtml(labEventNames[event.event_type] ?? event.event_type)}</strong><span>${escapeHtml(event.detail)}</span></div>
            <time>${formatDate(event.created_at)}</time>
          </li>`,
        )
        .join("")
    : `<li class="audit-empty">暂无实验记录</li>`;

  return `
    <header class="page-header">
      <div><span class="eyebrow">本地实验</span><h1>研究沙盒</h1><p>只使用合成身份与本地令牌，完整观察额度耗尽和自动切换。</p></div>
      <button class="button button-quiet" data-lab-action="refresh" ${labDisabled ? "disabled" : ""}>${icon("refresh")}${lab.loading ? "刷新中" : "刷新状态"}</button>
    </header>

    <section class="lab-boundary ${lab.online ? "online" : "offline"}">
      <span><i></i>${lab.online ? "本地服务已连接" : "本地服务未连接"}</span>
      <p>${escapeHtml(lab.message)}</p>
      <strong>外部网络关闭 · 仅合成身份</strong>
    </section>

    <section class="lab-stats">
      <article><span>模拟账号</span><strong>${lab.accounts.length}</strong><small>@example.invalid</small></article>
      <article><span>总模拟额度</span><strong>${totalUsed} / ${totalLimit}</strong><small>仅本地计数</small></article>
      <article><span>虚拟设备</span><strong class="lab-code">${escapeHtml(lab.virtualDeviceId ? `${lab.virtualDeviceId.slice(0, 13)}…` : "未创建")}</strong><small>应用内部标识</small></article>
      <article><span>当前令牌</span><strong class="lab-code">${escapeHtml(tokenLabel)}</strong><small>${lab.tokenExpiresAt ? `到期 ${formatDate(lab.tokenExpiresAt)}` : "只在内存保存"}</small></article>
    </section>

    <section class="lab-layout">
      <div class="lab-main-column">
        <section class="panel lab-control-panel">
          <div class="section-header"><div><span class="section-label">实验控制</span><h2>生成与执行</h2></div><span class="lab-safe-tag">LOCAL ONLY</span></div>
          <form id="lab-create-form" class="lab-create-form">
            <label>账号数量<input name="count" type="number" min="1" max="20" value="3"></label>
            <label>每账号额度<input name="quota_limit" type="number" min="10" max="1000000" value="100"></label>
            <button class="button button-primary" type="submit" ${labDisabled ? "disabled" : ""}>${icon("plus")}生成模拟账号</button>
          </form>
          <div class="lab-action-grid">
            <button class="lab-action-card" data-lab-action="create-device" ${labDisabled ? "disabled" : ""}>${icon("device")}<span><strong>${lab.virtualDeviceId ? "轮换虚拟设备" : "创建虚拟设备"}</strong><small>只改变应用内部 vdev_ 标识</small></span></button>
            <button class="lab-action-card" data-lab-consume="10" ${!lab.token || labDisabled ? "disabled" : ""}>+10<span><strong>消耗 10 额度</strong><small>模拟正常调用</small></span></button>
            <button class="lab-action-card" data-lab-consume="25" ${!lab.token || labDisabled ? "disabled" : ""}>+25<span><strong>消耗 25 额度</strong><small>超额自动尝试切换</small></span></button>
            <button class="lab-action-card" data-lab-action="switch" ${!lab.virtualDeviceId || lab.accounts.length < 2 || labDisabled ? "disabled" : ""}>⇄<span><strong>切换下一账号</strong><small>选择使用比例最低的账号</small></span></button>
          </div>
          <div class="lab-session-strip">
            <div><span>当前会话</span><strong>${current ? escapeHtml(current.label) : "未选择账号"}</strong></div>
            <div class="lab-session-actions">
              <button class="button button-quiet" data-lab-action="revoke" ${!lab.token || labDisabled ? "disabled" : ""}>撤销令牌</button>
              <button class="button button-quiet danger-text" data-lab-action="reset" ${!lab.accounts.length || labDisabled ? "disabled" : ""}>重置全部模拟用量</button>
            </div>
          </div>
        </section>

        <section class="panel lab-accounts-panel">
          <div class="section-header"><div><span class="section-label">合成身份</span><h2>账号池</h2></div><span>${lab.accounts.length} 个</span></div>
          <div class="lab-account-list">${accountRows}</div>
        </section>
      </div>

      <aside class="panel lab-audit-panel">
        <div class="section-header"><div><span class="section-label">可追溯</span><h2>审计记录</h2></div></div>
        <ol class="lab-audit-list">${auditRows}</ol>
      </aside>
    </section>`;
}

function connectionModal(): string {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <div class="modal-header"><div><span class="eyebrow">安全连接</span><h2 id="connection-title">添加自有密钥</h2></div><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div>
        <form id="connection-form">
          <label>显示名称<input name="label" required maxlength="48" placeholder="例如：工作用 OpenAI" /></label>
          <label>服务商<select name="provider" required><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google AI</option><option value="cursor-byok">Cursor 自有密钥</option><option value="other">其他服务</option></select></label>
          <label>账号备注<input name="account_hint" maxlength="80" placeholder="邮箱或用途，不要填写密码" /></label>
          <label>API Key / 凭证<input name="secret" type="password" required autocomplete="new-password" minlength="8" placeholder="只会写入系统安全存储" /></label>
          <div class="secure-inline">${icon("shield")}保存后不会在界面或普通配置文件中显示完整密钥。</div>
          <div class="modal-actions"><button class="button button-quiet" type="button" data-action="close-modal">取消</button><button class="button button-primary" type="submit">安全保存</button></div>
        </form>
      </section>
    </div>`;
}

function usageModal(): string {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="usage-title">
        <div class="modal-header"><div><span class="eyebrow">用量记录</span><h2 id="usage-title">更新本周期用量</h2></div><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div>
        <form id="usage-form">
          <div class="field-pair">
            <label>已使用<input name="used" type="number" required min="0" step="0.01" value="${snapshot.usage.used}" /></label>
            <label>总额度<input name="limit" type="number" required min="0.01" step="0.01" value="${snapshot.usage.limit}" /></label>
          </div>
          <label>单位<input name="unit" required maxlength="16" value="${escapeHtml(snapshot.usage.unit)}" placeholder="美元、请求、积分" /></label>
          <label>重置时间（可选）<input name="resets_at" type="datetime-local" value="${snapshot.usage.resets_at ? snapshot.usage.resets_at.slice(0, 16) : ""}" /></label>
          <div class="secure-inline neutral">当前版本采用手动录入，避免抓取 Cursor 未公开的内部接口。</div>
          <div class="modal-actions"><button class="button button-quiet" type="button" data-action="close-modal">取消</button><button class="button button-primary" type="submit">保存记录</button></div>
        </form>
      </section>
    </div>`;
}

function render(): void {
  const pageHtml =
    page === "overview"
      ? overviewPage()
      : page === "connections"
        ? connectionsPage()
        : page === "lab"
          ? labPage()
          : settingsPage();
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><img src="/src/assets/app-icon.svg" alt=""/><div><strong>用量伙伴</strong><span>Usage Companion</span></div></div>
        <nav>
          <button class="nav-item ${page === "overview" ? "active" : ""}" data-page="overview">${icon("overview")}<span>概览</span></button>
          <button class="nav-item ${page === "connections" ? "active" : ""}" data-page="connections">${icon("key")}<span>授权连接</span></button>
          <button class="nav-item ${page === "lab" ? "active" : ""}" data-page="lab">${icon("lab")}<span>研究沙盒</span></button>
          <button class="nav-item ${page === "settings" ? "active" : ""}" data-page="settings">${icon("settings")}<span>设置</span></button>
        </nav>
        <div class="sidebar-bottom">
          <div class="safety-chip">${icon("shield")}<div><strong>合规模式</strong><span>不绕过计费与限额</span></div></div>
          <span class="version">MVP 0.1.0 · ${runtime === "preview" ? "浏览器预览" : escapeHtml(snapshot.platform.os)}</span>
        </div>
      </aside>
      <main class="content">${runtime === "preview" ? '<div class="preview-banner">当前为浏览器预览，桌面端中数据将写入本机安全存储。</div>' : ""}${pageHtml}</main>
    </div>
    ${modal === "connection" ? connectionModal() : modal === "usage" ? usageModal() : ""}
    <div id="toast" class="toast" role="status"></div>`;
  bindEvents();
}

function showToast(message: string, tone: "ok" | "error" = "ok"): void {
  const element = document.querySelector<HTMLDivElement>("#toast");
  if (!element) return;
  element.textContent = message;
  element.className = `toast show ${tone}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove("show"), 2800);
}

async function callDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

async function callLab<T>(
  operation: string,
  payload: Record<string, unknown> | null = null,
  token: string | null = null,
): Promise<LabHttpResponse<T>> {
  return callDesktop<LabHttpResponse<T>>("lab_request", { operation, payload, token });
}

function labData<T>(response: LabHttpResponse<T>): T {
  if (response.status >= 400 || response.body.error) {
    throw new Error(response.body.error?.message ?? `本地研究请求失败（${response.status}）`);
  }
  if (response.body.data === undefined) throw new Error("本地研究服务响应缺少数据");
  return response.body.data;
}

async function syncLabData(): Promise<void> {
  const health = await callLab("health");
  if (health.status !== 200 || health.body.status !== "ok") {
    throw new Error("本地研究服务健康检查未通过");
  }
  const [accountsResponse, auditResponse] = await Promise.all([
    callLab<LabAccount[]>("list_accounts"),
    callLab<LabAuditEvent[]>("audit"),
  ]);
  lab.accounts = labData(accountsResponse);
  lab.audit = labData(auditResponse);
  lab.online = true;
  lab.message = "服务运行正常，管理密钥由桌面核心保管";
}

async function refreshLab(): Promise<void> {
  if (runtime !== "desktop" || lab.loading) return;
  lab.loading = true;
  render();
  try {
    await syncLabData();
  } catch (error) {
    lab.online = false;
    lab.message = String(error);
  } finally {
    lab.loading = false;
    render();
  }
}

function applyGrant(grant: LabGrant): void {
  lab.currentAccountId = grant.account_id;
  lab.virtualDeviceId = grant.virtual_device_id;
  lab.token = grant.access_token;
  lab.tokenExpiresAt = grant.expires_at;
}

async function runLabAction(task: () => Promise<string>): Promise<void> {
  if (runtime !== "desktop" || lab.loading) return;
  lab.loading = true;
  render();
  let message = "实验操作已完成";
  let errorMessage: string | null = null;
  try {
    message = await task();
    await syncLabData();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    lab.message = errorMessage;
  } finally {
    lab.loading = false;
    render();
    showToast(errorMessage ?? message, errorMessage ? "error" : "ok");
  }
}

async function revokeCurrentLabToken(): Promise<void> {
  if (!lab.token) return;
  await callLab("revoke_session", null, lab.token);
  lab.token = null;
  lab.tokenExpiresAt = null;
}

function bindEvents(): void {
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      page = button.dataset.page as Page;
      modal = null;
      render();
      if (page === "lab") void refreshLab();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-action='add-connection']").forEach((button) => {
    button.addEventListener("click", () => {
      modal = "connection";
      render();
      document.querySelector<HTMLInputElement>("#connection-form input")?.focus();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-action='update-usage']").forEach((button) => {
    button.addEventListener("click", () => {
      modal = "usage";
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-action='close-modal']").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target !== element && element.classList.contains("modal-backdrop")) return;
      modal = null;
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.deleteId;
      if (!id || !window.confirm("确定删除这个连接吗？系统凭证库中的密钥也会一并删除。")) return;
      try {
        if (runtime === "desktop") {
          snapshot = await callDesktop<AppSnapshot>("delete_connection", { id });
        } else {
          snapshot.connections = snapshot.connections.filter((connection) => connection.id !== id);
        }
        render();
        showToast("连接已删除");
      } catch (error) {
        showToast(String(error), "error");
      }
    });
  });

  document.querySelector<HTMLFormElement>("#connection-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const input: ConnectionInput = {
      label: String(form.get("label") ?? ""),
      provider: String(form.get("provider") ?? ""),
      account_hint: String(form.get("account_hint") ?? ""),
      secret: String(form.get("secret") ?? ""),
    };
    try {
      if (runtime === "desktop") {
        snapshot = await callDesktop<AppSnapshot>("save_connection", { input });
      } else {
        const now = new Date().toISOString();
        const connection: Connection = { id: crypto.randomUUID(), label: input.label, provider: input.provider, account_hint: input.account_hint, secret_saved: true, created_at: now, updated_at: now };
        snapshot.connections.push(connection);
      }
      modal = null;
      render();
      showToast("密钥已安全保存");
    } catch (error) {
      showToast(String(error), "error");
    }
  });

  document.querySelector<HTMLFormElement>("#usage-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const usage: UsageSnapshot = {
      used: Number(form.get("used")),
      limit: Number(form.get("limit")),
      unit: String(form.get("unit") ?? ""),
      source: "手动录入",
      updated_at: new Date().toISOString(),
      resets_at: String(form.get("resets_at") ?? "") || null,
    };
    try {
      if (runtime === "desktop") snapshot = await callDesktop<AppSnapshot>("save_usage", { usage });
      else snapshot.usage = usage;
      modal = null;
      render();
      showToast("用量已更新");
    } catch (error) {
      showToast(String(error), "error");
    }
  });

  document.querySelector<HTMLFormElement>("#settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const settings: Settings = {
      warning_threshold: Number(form.get("warning_threshold")),
      critical_threshold: Number(form.get("critical_threshold")),
      notifications_enabled: form.get("notifications_enabled") === "on",
      refresh_interval_minutes: Number(form.get("refresh_interval_minutes")),
    };
    try {
      if (runtime === "desktop") snapshot = await callDesktop<AppSnapshot>("save_settings", { settings });
      else snapshot.settings = settings;
      render();
      showToast("设置已保存");
    } catch (error) {
      showToast(String(error), "error");
    }
  });

  document.querySelector<HTMLFormElement>("#lab-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const count = Number(form.get("count"));
    const quotaLimit = Number(form.get("quota_limit"));
    void runLabAction(async () => {
      const response = await callLab<LabAccount[]>("create_accounts", {
        count,
        quota_limit: quotaLimit,
      });
      const created = labData(response);
      return `已生成 ${created.length} 个模拟账号`;
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-lab-issue]").forEach((button) => {
    button.addEventListener("click", () => {
      const accountId = button.dataset.labIssue;
      if (!accountId) return;
      void runLabAction(async () => {
        await revokeCurrentLabToken();
        const response = await callLab<LabGrant>("issue_session", {
          account_id: accountId,
          virtual_device_id: lab.virtualDeviceId,
        });
        applyGrant(labData(response));
        return "本地模拟令牌已签发";
      });
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-lab-consume]").forEach((button) => {
    button.addEventListener("click", () => {
      const units = Number(button.dataset.labConsume);
      if (!lab.token || !Number.isInteger(units)) return;
      void runLabAction(async () => {
        const response = await callLab("consume", { units }, lab.token);
        if (response.status === 429 && response.body.error?.should_switch) {
          if (!lab.virtualDeviceId) throw new Error("当前会话没有虚拟设备");
          const switched = await callLab<LabGrant>("switch_next", {
            current_account_id: lab.currentAccountId,
            virtual_device_id: lab.virtualDeviceId,
          });
          applyGrant(labData(switched));
          return "模拟额度不足，已自动切换到下一账号";
        }
        labData(response);
        return `已消耗 ${units} 点模拟额度`;
      });
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-lab-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.labAction;
      if (action === "refresh") {
        void refreshLab();
        return;
      }
      if (action === "create-device") {
        void runLabAction(async () => {
          if (lab.virtualDeviceId) {
            const response = await callLab<{ id: string }>("rotate_device", {
              current_virtual_device_id: lab.virtualDeviceId,
            });
            lab.virtualDeviceId = labData(response).id;
            await revokeCurrentLabToken();
            lab.currentAccountId = null;
            return "虚拟设备已轮换，原会话已撤销";
          }
          const response = await callLab<{ id: string }>("create_device", {
            label: "桌面研究设备",
          });
          lab.virtualDeviceId = labData(response).id;
          return "虚拟设备已创建";
        });
        return;
      }
      if (action === "switch") {
        void runLabAction(async () => {
          if (!lab.virtualDeviceId) throw new Error("请先创建虚拟设备");
          const response = await callLab<LabGrant>("switch_next", {
            current_account_id: lab.currentAccountId,
            virtual_device_id: lab.virtualDeviceId,
          });
          applyGrant(labData(response));
          return "已切换到下一模拟账号";
        });
        return;
      }
      if (action === "revoke") {
        void runLabAction(async () => {
          await revokeCurrentLabToken();
          return "本地模拟令牌已撤销";
        });
        return;
      }
      if (action === "reset") {
        void runLabAction(async () => {
          const response = await callLab<{ reset_accounts: number }>("reset_cycle", {
            account_id: null,
          });
          const result = labData(response);
          return `已重置 ${result.reset_accounts} 个模拟账号`;
        });
      }
    });
  });
}

async function start(): Promise<void> {
  try {
    snapshot = await callDesktop<AppSnapshot>("bootstrap");
  } catch {
    runtime = "preview";
    snapshot = structuredClone(demoSnapshot);
    const now = new Date().toISOString();
    lab = {
      loading: false,
      online: true,
      message: "浏览器仅展示合成示例；真实操作只在桌面应用中启用",
      accounts: [
        { id: "acct_demo_1", label: "模拟账号 1", email: "demo01@example.invalid", status: "active", quota_limit: 100, quota_used: 75, created_at: now },
        { id: "acct_demo_2", label: "模拟账号 2", email: "demo02@example.invalid", status: "active", quota_limit: 100, quota_used: 20, created_at: now },
        { id: "acct_demo_3", label: "模拟账号 3", email: "demo03@example.invalid", status: "active", quota_limit: 100, quota_used: 0, created_at: now },
      ],
      audit: [
        { id: 3, event_type: "quota_consumed", account_id: "acct_demo_1", virtual_device_id: "vdev_demo", detail: "units=25; used=75", created_at: now },
        { id: 2, event_type: "session_issued", account_id: "acct_demo_1", virtual_device_id: "vdev_demo", detail: "opaque local lab token issued", created_at: now },
        { id: 1, event_type: "accounts_created", account_id: null, virtual_device_id: null, detail: "count=3", created_at: now },
      ],
      currentAccountId: "acct_demo_1",
      virtualDeviceId: "vdev_demo_preview",
      token: "lab_tok_demo_preview_only",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }
  render();
}

void start();

