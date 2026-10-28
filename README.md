# dsh-session-delete

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 桌面端加一项 **删除对话**：在工作区侧边栏的对话「⋯」菜单里（复制 Session ID 下面），把这条对话的日志与投影缓存从本机永久删除——而不只是归档。

DSH 自带归档，归档后的对话仍在磁盘上、还能恢复；这个插件补的是「真删」。

## 特点

- 菜单里多一行「删除对话」，带确认框和删除后提示；
- **先隐藏、再删除**：先写归档集合让行立刻消失，再删日志目录和投影缓存，最后从工作区摘掉；删除失败会回滚归档；
- 正开在窗口里的对话**不用先退出**：日志目录被挪到 `.session-delete-trash\`（会话树之外），字节在下次启动时清除；
- 路径不靠环境变量猜：从插件自身安装位置反推 `$DSH_HOME`，环境变量只作为后备；找不到会报错而不是假装成功；
- 启动时顺带清掉没人认领的残留日志目录，避免删掉的对话被残留文件拖回「未分组」。

## 安装

### 方式一：tgz（推荐给最终用户）

把 `dsh-session-delete-<version>.tgz` 放到本机任意位置，然后对 DSH 说：

> 安装这个插件：`C:\路径\dsh-session-delete-1.4.0.tgz`

DSH 会调用 `plugin_manager` 的 `install_bundle`；返回 `application: applied` 且 `warnings: []` 即成功。装完刷新一次窗口（桌面端：完全退出再打开）。

### 方式二：从源码目录安装（开发用）

```
git clone https://github.com/xzc0017/dsh-session-delete.git
```

再让 DSH 用 `install_bundle` 指向这个目录（本地目录会以链接方式装入 profile），改完重新装一次即可生效。

## 行为细节

1. 点击「删除对话」→ 确认框（显示对话标题）。
2. `POST /dsh-session-delete/delete`：
   - `workspaceRegistry.archiveSession(id, { stopActivity: true })`：进归档集合并停止正在跑的工作 → 行立刻消失；
   - 定位 `<home>/sessions/<cwd-encoded>/<sessionId>/`（`session.v4.jsonl.zstd`）与 `<home>/storages/session_projcache/sessions/<sessionId>.json`，删除并校验；
   - 从工作区摘除、清置顶；
   - 任一步失败 → 回滚归档并返回带原因的错误。
3. 日志已经不存在（旧版本残留的行）时不再报错：照样归档 + 摘工作区并返回成功。

## 要求

- DSH 0.2.x（在 `0.2.1-rc` 线上验证）；
- 宿主进程需要对 `$DSH_HOME` 有写权限。

## 测试

```
node test/delete-session.test.mjs   # 候选 home 探测、找不到报错、删除、活会话挪走、启动清场
node test/host-route.test.mjs       # 路由：方法、校验、失败不摘工作区、活会话挪走、冷删除
```

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：路由、归档隐藏、删文件、摘工作区、启动清场 |
| `lib/delete-session.js` | 纯文件操作：候选 home、定位、删除校验、trash |
| `client.js` | Client 半：菜单行 `session-delete`（order 500）、确认框与提示 |
| `cordis.patch.yml` | 插入 Host 行 |
| `locale/*.json` | 插件卡片标题/描述 |

## 变更

- 1.4.0：加界面说明（可能短暂出现在「未分组」，重新打开 DSH 完成删除）；启动时清掉没人认领的残留日志目录。
- 1.3.0：修「文件删了但界面还在、点进去 `session/not-found`」。改为先归档隐藏行 → 删文件 → 摘工作区；日志已不在时也照样收尾。
- 1.2.0：修「找不到日志文件」与「删之前得先退出一次」。home 从插件安装位置反推；开着的对话改为挪走而非拒绝。
- 1.1.0：先删文件再摘工作区；多候选 home 且必须命中；失败报错。
- 1.0.0：首个版本。

## 许可

MIT
