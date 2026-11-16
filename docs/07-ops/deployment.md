<!--
costgate — Copyright © 2026 sif-king (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the costgate project.
-->

# 部署指南（deployment）

> 提炼自 `manage.sh`、`install.sh`、`docker-compose.yml`、各 `.env.example`、`07-ops/ENV-NOTES.md`。
> 生成日期：2026-09-17（HEAD `a94de96`，main）。

---

## 一、前置依赖检查

| 依赖 | 检测方式 | 缺失处理 |
|------|----------|---------|
| Node.js | `command -v node` | `brew install node` |
| Python3 | `command -v python3` | `brew install python3` |
| Docker + Docker Compose | `docker compose version` | `brew install --cask docker` |

---

## 二、三种部署模式

### 2.1 manage.sh 模式（macOS 本地，推荐）

```bash
# 启动全部
./manage.sh start

# 停止全部
./manage.sh stop

# 查看状态
./manage.sh status

# 查看日志
./manage.sh logs              # 全部
./manage.sh logs codex        # 单代理
```

**四代理端口**：codex:18790 / hermes:18793 / cursor:18794 / manager:18792。

开机自启（macOS LaunchAgent）：

```bash
./manage.sh autostart --codex   # 或 hermes / cursor / manager
./manage.sh autostop --codex    # 禁用
```

plist 路径：`~/Library/LaunchAgents/com.multi-proxy-manager.plist`。

**关键注意（来自 07-ops/ENV-NOTES.md / 03-adr）**：
- `lsof` **必须用完整路径 `/usr/sbin/lsof`**，Node.js 子进程 PATH 不含 `/usr/sbin`，违反则代理状态检测全部失败（所有代理显示"未运行"）。
- `killPort` 使用 SIGTERM → 500ms → SIGKILL 两阶段。
- 启动轮询等端口绑定（最多 5s），非固定延迟。

### 2.2 install.sh 模式（一键安装/启停/自启）

```bash
./install.sh                  # 交互式
./install.sh --all            # 静默全部
./install.sh --uninstall      # 卸载
./install.sh --reinstall      # 卸载后重装
./install.sh --start          # 启动全部
./install.sh --stop           # 停止
./install.sh --status         # 状态
./install.sh --autostart      # 开机自启
./install.sh --autostop       # 禁用自启
```

macOS pip：`pip3 install -r requirements.txt` **不加 `--break-system-packages`**（该参数仅 Debian/Ubuntu，macOS 报错）。

### 2.3 Docker 模式

docker-compose.yml 定义 4 服务（codex-proxy/hermes-proxy/cursor-proxy/manager），命名：`multi-proxy-{code}`，bridge 网络。
四个 `env_file` 都是 `required: false`——**干净 clone 里没建那几个 `.env` 也能直接起**，API key 从第三节的环境变量或面板里配。
（2026-11-16 修：此前写死必需，干净 clone 下 `docker compose up -d` 会报 env file 缺失直接失败。）

```bash
# 面板挂载了 docker.sock（等同宿主 root），所以必须设密码；未设会在 compose 阶段直接报错退出
echo 'MANAGER_PASSWORD=换成你自己的密码' > .env      # 与 docker-compose.yml 同目录
docker compose up -d          # 启动
docker compose down           # 停止
docker compose logs           # 日志
```

两个必须知道的点（2026-11-16 实测，缺一条就是「起了但用不了」）：

- **`BIND_HOST=0.0.0.0` 已写进 compose**。面板自身默认只绑回环（`server.js` 的 `BIND_HOST` 缺省 `127.0.0.1`），
  容器里绑回环的话宿主端口映射打不到，表现为「容器 Up、浏览器连不上」。
- **宿主侧可达范围由 `PANEL_BIND` 控制**，缺省 `127.0.0.1`（只有本机能访问）。真要对外提供访问再设 `PANEL_BIND=0.0.0.0`，
  并确认前面有防火墙/反向代理。
- 非回环 + 未配鉴权时服务端 **fail-closed 拒绝启动**（见 `server.js` 的 `shouldFailClosedBind`），
  所以密码不是可选项；要显式免鉴权才设 `MP_BIND_AUTH_BYPASS=1`（自担风险）。

改过 Dockerfile 之后请跑一次启动冒烟——**构建成功不代表跑得起来**：

```bash
BUILD=1 bash scripts/verify-docker-image.sh      # 构建 + 起容器 + 等 /api/health 200
```

Manager 容器挂载 `/var/run/docker.sock` 控制其他容器；`IS_DOCKER = fs.existsSync('/.dockerenv')` 自动识别 Docker 环境，进程检测切 `docker container inspect`，API 转发用服务名替代 `127.0.0.1`。

---

## 三、环境变量配置

### 3.1 各 `.env.example`

| 文件 | 必填 |
|------|------|
| `codex-proxy/.env` | `PORT=18790` `DEEPSEEK_API_KEY` `AGNES_API_KEY` `MOONSHOT_API_KEY` |
| `hermes-proxy/.env` | 同上，`PORT=18793` |
| `cursor-proxy/.env` | `PORT=18794` `PROXY_AUTH_TOKEN` `CORS_ORIGIN` `ENCRYPTION_KEY` |
| `multi-proxy-manager/.env` | `PORT=18792` `JWT_SECRET`（改随机串）`MANAGER_PASSWORD` `CORS_ORIGIN` |

### 3.2 L2 门控开关（生产环境逐步开启）

| 开关 | 值 | 默认 | 说明 |
|------|----|----|------|
| `PROXY_ROUTE_OVERRIDE` | `1`/`0` | 空=shadow | M6 路由覆盖，建议 shadow 验证后固化 |
| `PROXY_DECOMPOSE_STRATEGY` | 值 | — | 拆解策略，见 `m6-action-checklist` |
| `PROXY_LLM_DECOMPOSE` | `1`/`0` | `0` 关 | LLM 拆解 fallback on error |
| `PROXY_HEALTH_ALERT` | `1`/`0` | `0` 403 | 告警规则，启用后 `GET /api/alert/*` 开放 |
| `PROXY_COST_TRACK` | `0`/`1` | `0` | 成本埋点，A 路 token×单价 |

> 固化 M6 路由：`PROXY_ROUTE_OVERRIDE=1` 写进 `mult...[truncated]