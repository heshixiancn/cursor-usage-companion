# 本地研究沙盒服务

这是一个完全本地、使用合成数据的研究服务，用于观察“账号 → 令牌 → 虚拟设备 → 额度消耗 → 429 → 切换账号 → 账期重置”的系统行为。

它不会连接 Cursor 或其他第三方服务，不发送邮件、不接验证码平台、不读取系统机器码、不修改其他应用，也不提供可用于第三方服务的令牌。

## 安全限制

- 固定监听 `127.0.0.1`；
- 账号邮箱使用 IANA 保留的 `example.invalid` 域名；
- 令牌固定使用 `lab_tok_` 前缀，只被本服务识别；
- 设备 ID 固定使用 `vdev_` 前缀，只存在于本地数据库；
- 数据库保存令牌 SHA-256，不保存令牌明文；
- 管理接口要求 `X-Lab-Key`；
- 不包含任何外部 HTTP 客户端依赖；
- 所有操作写入本地审计日志。

## 启动

```bash
cd research-lab
npm start
```

默认地址：`http://127.0.0.1:17840`  
默认数据目录：当前工作目录下的 `.lab-data`。从 `research-lab` 目录启动时即为 `research-lab/.lab-data`。

浏览器打开默认地址会显示中文运行状态页；`/health` 提供机器可读的健康状态。管理接口仍必须通过请求头携带密钥，不能直接在地址栏中调用。

配套桌面应用启动后，可在侧栏进入“研究沙盒”完成账号、设备、令牌、额度和审计实验。管理密钥由桌面 Rust 核心读取，不会交给 WebView 页面。

启动后会生成：

- `.lab-data/lab-key.txt`：本地管理密钥；
- `.lab-data/research-lab.sqlite3`：模拟数据与审计记录。

可选参数：

```bash
npm start -- --port 17841 --data-dir ./tmp-lab
```

运行环境要求 Node.js 24 或更高版本。服务只使用 Node 内置模块，不需要下载安装第三方依赖。当前使用的内置 `node:sqlite` 在 Node 24 启动时可能显示实验性 API 提示，不影响本地研究功能；正式部署前应改用稳定、持续维护的数据库驱动。

## API

除健康检查外，请求需要：

```text
X-Lab-Key: <读取 .lab-data/lab-key.txt>
```

### 健康检查

```http
GET /health
```

响应会明确返回：

```json
{
  "status": "ok",
  "environment": "local-research-lab",
  "external_network_enabled": false,
  "synthetic_identities_only": true
}
```

### 批量生成模拟账号

```http
POST /api/lab/accounts/batch
Content-Type: application/json
X-Lab-Key: ...

{"count": 3, "quota_limit": 100}
```

每次最多生成 20 个，只生成 `@example.invalid` 合成身份。

### 查看模拟账号

```http
GET /api/lab/accounts
X-Lab-Key: ...
```

### 创建虚拟设备

```http
POST /api/lab/devices
Content-Type: application/json
X-Lab-Key: ...

{"label": "macOS 测试设备"}
```

### 轮换虚拟设备 ID

```http
POST /api/lab/devices/rotate
Content-Type: application/json
X-Lab-Key: ...

{"current_virtual_device_id": "vdev_..."}
```

该操作只新建一条应用内部测试记录，不读取或改变操作系统机器标识。

### 签发模拟令牌

```http
POST /api/lab/sessions/issue
Content-Type: application/json
X-Lab-Key: ...

{"account_id": "acct_...", "virtual_device_id": "vdev_..."}
```

返回的 `lab_tok_...` 只在本地研究沙盒有效。

令牌有效期为 1 小时，`expires_at` 为实际到期时间。过期令牌会被拒绝并在本地标记为失效。

### 撤销模拟令牌

```http
POST /api/lab/sessions/revoke
X-Lab-Key: ...
Authorization: Bearer lab_tok_...
```

撤销后该令牌不能再消耗模拟额度。

### 模拟消耗额度

```http
POST /api/lab/usage/consume
Content-Type: application/json
X-Lab-Key: ...
Authorization: Bearer lab_tok_...

{"units": 25}
```

超过额度时返回 HTTP 429、`LAB_QUOTA_EXHAUSTED` 和 `should_switch: true`。

### 切换到下一模拟账号

```http
POST /api/lab/switch/next
Content-Type: application/json
X-Lab-Key: ...

{"current_account_id": "acct_...", "virtual_device_id": "vdev_..."}
```

服务从本地合成账号中选择剩余额度较高的账号，并签发新的本地令牌。

### 模拟账期重置

```http
POST /api/lab/cycle/reset
Content-Type: application/json
X-Lab-Key: ...

{"account_id": "acct_..."}
```

`account_id` 为 `null` 时重置全部模拟账号。

### 查看审计记录

```http
GET /api/lab/audit?limit=100
X-Lab-Key: ...
```

## 验证

```bash
cd research-lab
node --check src/server.mjs
node --check src/store.mjs
npm test
```

当前自动化测试共 14 项，覆盖浏览器状态页、鉴权、合成账号、令牌哈希、到期与撤销、额度消耗与 429、设备轮换、账号切换、账期重置和审计记录。

