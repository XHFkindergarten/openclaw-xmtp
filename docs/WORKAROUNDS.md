# 临时 Workaround 记录

上线前必须清理以下所有临时改动，等待上游修复后回退。

---

## [OPEN] @xmtp/node-bindings Nix 路径污染

**问题**：`@xmtp/node-bindings`（v1.10.0、v1.10.0-dev.074a3d3）的 `.node` 二进制文件在 Nix 环境下编译，`LC_LOAD_DYLIB` 硬编码了 Nix store 路径：
```
/nix/store/7h6icyvqv6lqd0bcx41c8h3615rjcqb2-libiconv-109.100.2/lib/libiconv.2.dylib
```
在非 Nix macOS 系统上 `dlopen` 失败，Node.js 进程被 macOS 以 SIGKILL 终止（exit 137）。

**上游 issue**：需向 https://github.com/xmtp/libxmtp 提 issue，要求在 CI 构建后用 `install_name_tool` 重写 rpath 或改为 `@rpath` 相对路径。

**当前临时改动**：

1. `scripts/patch-xmtp-bindings.sh` — 新增文件，通过 `install_name_tool` 将 Nix 路径替换为 homebrew libiconv，再用 `codesign --sign -` 重新 ad-hoc 签名（`install_name_tool` 会使原有代码签名失效，macOS 会 SIGKILL 签名无效的 `.node` 文件）

2. `package.json` — 新增 `"postinstall": "sh scripts/patch-xmtp-bindings.sh"`，确保每次 `pnpm i` 后自动重新打补丁

**回退步骤**（上游修复发布后）：
1. 升级 `@xmtp/agent-sdk` 到包含修复的版本
2. 删除 `scripts/patch-xmtp-bindings.sh`
3. 移除 `package.json` 中的 `postinstall` 字段
4. 删除 `node_modules`，重新 `pnpm i` 验证无需补丁
