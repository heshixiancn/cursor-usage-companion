# Git 与 Codex 迁移说明

## 项目现状

- 桌面端使用 Tauri 2、Rust、TypeScript 和 Vite，已具备 macOS 与 Windows 的基础工程。
- 本地研究实验室位于 `research-lab/`，只监听 `127.0.0.1`，使用合成账号、合成令牌、虚拟设备和本地额度数据。
- 产品不接入 Cursor 的真实账号、令牌或内部接口，也不实现机器码规避、自动注册、计费绕过或额度绕过。
- 需求、技术方案、安全边界、测试方案、架构决策和开发日志均保存在 `docs/`。

## 在新电脑恢复项目

准备 Node.js 24、pnpm 10、Rust stable，以及对应平台的 Tauri 系统依赖。macOS 需要安装 Xcode Command Line Tools。

```bash
git clone <本仓库地址>
cd cursor-usage-companion
corepack enable
pnpm install
```

启动本地研究实验室：

```bash
cd research-lab
npm start
```

另开终端回到项目根目录并启动桌面应用：

```bash
pnpm tauri dev
```

## 验证命令

```bash
cd research-lab && npm test
cd ..
pnpm build
pnpm tauri build
```

## 不随 Git 迁移的内容

- `node_modules/`、`dist/` 和 `src-tauri/target/` 等构建产物。
- `src-tauri/gen/schemas/` 自动生成的 Tauri Schema。
- `research-lab/.lab-data/` 中的实验室密钥和本地 SQLite 数据；首次启动会重新生成。
- 操作系统钥匙串中的任何本地凭据。

## 让新电脑上的 Codex 接续工作

在 Codex 中打开克隆后的仓库，并让它先阅读本文件、`README.md`、`docs/00-文档索引.md`、`docs/03-安全与合规设计.md` 和 `docs/08-开发日志.md`。开始修改前先运行现有测试，保持研究实验室的本地、合成、隔离边界。

优先的后续工作：

1. 完善桌面端对本地实验室进程的启动、停止和异常恢复。
2. 补齐 Windows 实机测试与 CI 构建。
3. 完成正式安装包签名、公证和升级策略。
4. 在不扩大权限的前提下完善通知、日志和错误提示。

## 提交约定

- 功能、文档和测试尽量在同一次提交中保持一致。
- 不提交真实密钥、令牌、账号数据或本地实验数据库。
- 涉及范围或安全边界的调整，必须同时更新 `docs/03-安全与合规设计.md` 和架构决策记录。
