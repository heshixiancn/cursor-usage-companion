# 用量伙伴

面向 Windows 与 macOS 的合规用量助手 MVP。它用于管理用户本人拥有的 AI API Key、记录本周期用量并在接近阈值时提醒。

完整的需求、技术、安全、跨平台、测试、迭代与开发过程记录见 [`docs/00-文档索引.md`](./docs/00-文档索引.md)。

隔离的本地合成账号/令牌/额度研究服务见 [`research-lab/README.md`](./research-lab/README.md)。它不连接 Cursor 或任何第三方服务。

## 已实现

- Tauri 2 + Rust + 原生 TypeScript 双端架构；
- 自动检测 macOS/Windows 上常见的 Cursor 安装位置；
- API Key 写入 macOS Keychain 或 Windows Credential Manager；
- 普通配置与密钥分离，前端不会回显完整密钥；
- 用量记录、剩余额度、阈值状态和账期重置时间；
- 授权连接的增加、删除；
- 提醒阈值与检查间隔配置；
- 浏览器预览降级，方便不启动桌面壳时检查界面。
- 隔离的本地研究沙盒，可使用纯合成数据观察账号、令牌、虚拟设备、额度、429、切换与重置状态机。
- 桌面端“研究沙盒”控制台，可生成模拟账号、签发/撤销令牌、消耗额度、自动切换并查看审计记录。

## 安全边界

本项目不会自动注册账号、经营账号池、重置机器标识、修改 Cursor 登录令牌、注入 Cursor 内部文件或绕过计费与用量限制。

## 本地开发

```bash
pnpm install
pnpm tauri dev
```

只检查前端：

```bash
pnpm dev
```

运行验证：

```bash
pnpm build
cd src-tauri && cargo test
```

运行本地研究沙盒：

```bash
cd research-lab
npm start
```

保持研究服务运行后，再启动桌面端并进入“研究沙盒”。桌面页面不读取或保存管理密钥；Rust 核心只允许访问固定的 `127.0.0.1:17840` 和预定义接口。

## 打包

在 macOS 构建 `.app/.dmg`：

```bash
pnpm tauri build
```

在 Windows 构建 `.msi/.exe`：

```powershell
pnpm tauri build
```

正式分发前还需要分别配置 Apple Developer 签名与公证、Windows 代码签名证书。跨平台安装包应在对应操作系统或 CI 构建机上生成。

## 下一阶段

1. 增加系统原生通知；
2. 在官方提供稳定接口时增加只读用量同步；
3. 增加本地加密备份与恢复；
4. 增加 macOS Universal、Windows x64/ARM64 的自动构建流水线；
5. 完成签名、公证、自动更新与隐私说明。

