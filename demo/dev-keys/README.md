# Demo signing key

这个目录只保留 **公钥**。签名私钥不提交到仓库，避免任何环境误用。

- `bundle-signing-key.pem`：本地生成的 ECDSA P-256 私钥，已被 `.gitignore` 忽略，只用于本机 demo。
- `bundle-signing-key.pub.base64`：公钥（DER/SPKI），已内嵌到 Android 插件 `DevShellConfig`。
- `bundle-signing-key.pub.pem`：公钥 PEM，便于人工查看。

首次使用或需要换 key 时：

```bash
cd demo
npm run key:generate
```

脚本会：

1. 生成新的私钥到 `dev-keys/bundle-signing-key.pem`（不会提交）；
2. 更新两个公钥文件；
3. 同步更新 `DevShellConfig.kt` 里 pin 的 `BUNDLE_PUBLIC_KEY_BASE64`。

生成后必须重新构建 DevShell APK，已安装的旧 APK 仍然只信任旧公钥。

真实实现不要把私钥放在 App 仓库：私钥应该放在发布流水线的签名服务 / KMS，DevShell 只内置公钥。换 key 时同时更新公钥和 Android 里的 pin。

> 每个开发者可以生成自己的 demo key；只要用同一份代码构建 DevShell 和 bundle，签名/验签就能对上。不要把 demo key 用于任何真实环境。
