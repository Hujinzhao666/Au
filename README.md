# Aurora AI Mobile

Aurora AI 的安卓、iOS 与 PWA 共用项目。

核心能力：

- Capacitor 8 原生容器
- CapacitorHttp 原生网络请求
- TokenClub Responses 协议本地转换
- 无 Cloudflare 直连模式
- PWA 离线缓存
- GitHub Actions 一键构建安卓 APK
- GitHub Actions 构建 iOS 未签名 IPA

详细操作请阅读 [小白安装说明.md](./小白安装说明.md)。

开发检查：

```bash
npm ci
npm run check
npx cap sync
```

