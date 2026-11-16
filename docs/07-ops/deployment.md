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

三个必须知道的点（2026-11-16 / 17 真起容器实测，缺一条就是「起了但用不了」）：

- **容器内必须绑 `0.0.0.0`，已写进各镜像**。四个服务自身默认都只绑回环（manager `BIND_HOST`、
  cursor/hermes `BIND_HOST`、codex `PROXY_BIND_HOST`，缺省 `127.0.0.1`），容器里绑回环的话宿主端口映射
  打不到，表现就是「容器 Up、浏览器连不上」。三个代理的 `ENV` 已分别写进 `Dockerfile.{codex,cursor,hermes}`，
  不需要在 compose 里重复设。
- **宿主侧可达范围**：面板由 `PANEL_BIND` 控制、三个代理由 `PROXY_BIND` 控制，**缺省都是 `127.0.0.1`**
  （只有本机能访问）。真要对外再设 `0.0.0.0`，并确认前面有防火墙/反向代理。
- 非回环 + 未配鉴权时服务端 **fail-closed 拒绝启动**（见 `server.js` 的 `shouldFailClosedBind`），
  所以密码不是可选项；要显式免鉴权才设 `MP_BIND_AUTH_BYPASS=1`（自担风险）。代理侧的 `/admin-api`
  同理，跨机暴露前先设 `PROXY_AUTH_TOKEN`。

改过 Dockerfile 之后请跑两个检查，**构建成功不代表跑得起来**：

```bash
node scripts/check-docker-runtime-closure.js    # 静态：require 出去的每个文件，镜像里那个路径上有没有
BUILD=1 bash scripts/verify-docker-image.sh     # 动态：构建 + 起容器 + 等 /api/health 200
```

为什么两条都要：静态那条只能判「路径对不对」，判不出「进程起来之后会不会崩」；动态那条要几分钟，
不适合每次改都跑。2026-11-17 一天之内被同一类问题咬了三次——`Dockerfile.manager` 漏 `l2/`+`packs/`
且 manager 目录落成 `/app/manager`（应是 `/app/multi-proxy-manager`）、`Dockerfile.codex` 漏 `l2/`、
补完 `l2/` 又炸在 `tools/token-policy-bridge.js`。三次**构建全绿**，容器起来立刻 `MODULE_NOT_FOUND`。

四容器联起已实测（2026-11-17，Docker 29.5.3 / macOS）：`docker compose up -d` 后四个容器全部 `Up`，
`codex:18790`、`hermes:18793`、`cursor:18794`、`manager:18792` 的 `/health` 与 `/api/health` 全 200，
manager 日志 `Managed proxies: codex, hermes, cursor`。测法：把宿主端口用 override 文件改到 `2889x`
（本机 1879x 被开发实例占着），`docker compose -p <独立项目名> -f docker-compose.yml -f <override> up -d`。


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