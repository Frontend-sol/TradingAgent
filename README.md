# AutoTrading Workbench (OKX + LLM)

专业化自动量化交易工作台：AI 决策 + 风控兜底 + OKX 执行 + 全链路复盘。

## 1. 项目结构

```txt
.
├─ prisma/
│  ├─ schema.prisma
│  └─ seed.ts
├─ src/
│  ├─ app/
│  │  ├─ (terminal)/
│  │  │  ├─ dashboard/
│  │  │  ├─ trading-config/
│  │  │  ├─ llm-config/
│  │  │  ├─ realtime/
│  │  │  ├─ trade-logs/
│  │  │  ├─ ai-logs/
│  │  │  ├─ performance/
│  │  │  └─ risk-center/
│  │  └─ api/
│  │     ├─ dashboard/overview
│  │     ├─ config/{trading,llm}
│  │     ├─ okx/public/ticker
│  │     ├─ decision/run
│  │     ├─ trades{,/export}
│  │     ├─ ai-decisions
│  │     ├─ performance
│  │     ├─ prompts
│  │     ├─ llm/compare
│  │     ├─ replay-notes
│  │     └─ stream
│  ├─ components/
│  │  ├─ layout/
│  │  ├─ charts/
│  │  ├─ tables/
│  │  └─ ui/
│  ├─ lib/
│  │  ├─ okx/
│  │  ├─ llm/
│  │  ├─ risk/
│  │  ├─ engine/
│  │  └─ queue/
│  └─ store/
├─ Dockerfile
├─ docker-compose.yml
└─ .env.example
```

## 2. 核心能力

- OKX v5 适配层（公共行情、账户、下单、撤单、杠杆、错误映射）
- LLM 决策引擎（强制 JSON Schema）
- 风控引擎（仓位、回撤、连续亏损、波动率、黑白名单、Kill Switch）
- 执行引擎（分析/模拟盘/实盘三模式）
- 交易日志与 AI 决策日志，支持可追溯字段
- 绩效分析图表（资金曲线、日盈亏、统计指标）
- SSE 实时推送
- BullMQ 队列（扫描行情 → AI 分析 → 条件执行）

## 3. 本地启动

### 3.1 准备环境

1. 复制环境变量：
   - `cp .env.example .env`
2. 启动依赖：
   - `docker compose up -d postgres redis`

### 3.2 安装依赖与数据库

```bash
npm install
npm run db:generate
npm run db:push
npm run db:seed
```

### 3.3 运行项目

```bash
npm run dev
```

打开 `http://localhost:3000`。

### 3.4 Redis 基础安全加固

1. 仅本机暴露：`docker-compose.yml` 已使用 `127.0.0.1:6379:6379`，避免公网直接访问。
2. 密码认证：已启用 `requirepass`，请在 `.env` 设置强密码：
   - `REDIS_PASSWORD=你的强密码`
3. 应用连接：容器内 `REDIS_URL` 已自动使用密码连接 `redis` 服务。
4. 服务器防火墙白名单（如部署在云主机）：仅允许可信来源 IP 访问 6379，其他全部拒绝。

## 4. 默认账号和样例数据

- 默认用户：`demo@autotrading.local`
- 默认策略：`BTC趋势跟随基础策略`
- 默认 Prompt：已内置“严格审慎量化模板”
- 默认模式：`analysis + demo`

## 5. 关键页面说明（截图位）

由于当前环境无法直接嵌入截图，建议本地运行后截图以下页面：

1. Dashboard：指标卡 + 资金曲线 + 最近信号/成交
2. 交易配置：模式切换、风控参数、自动交易开关
3. 模型配置：Provider/Base URL/Prompt/Schema
4. 实时交易：状态灯、手动下单、一键仅分析
5. 交易日志：筛选搜索 + 导出 CSV
6. AI 日志：输入输出与拦截原因
7. 绩效分析：收益曲线、日盈亏、指标统计
8. 风控中心：规则状态 + Kill Switch

## 6. API 示例

- `POST /api/decision/run`：触发 AI 决策
- `POST /api/trades`：手动下单
- `GET /api/trades/export`：导出交易日志 CSV
- `POST /api/llm/compare`：多模型对比测试（示例）
- `POST /api/replay-notes`：补记复盘备注

## 7. 开发阶段完成状态

### Phase 1（已完成）
- 项目初始化、UI 框架、Prisma 数据建模

### Phase 2（已完成）
- OKX 公共行情接入与 Dashboard 基础图表

### Phase 3（已完成）
- 私有账户与订单/持仓接口设计（可接真实 key）

### Phase 4（已完成）
- LLM 配置中心 + Prompt 编辑 + JSON 决策引擎

### Phase 5（已完成）
- 自动执行链路 + 风控拦截

### Phase 6（已完成）
- 交易日志 + AI 决策日志 + 复盘备注接口

### Phase 7（基础版完成）
- 绩效统计图表与关键指标

### Phase 8（已完成）
- Docker 化、README、样例数据

## 8. 已知 TODO

1. WebSocket 私有频道签名订阅（当前先用 SSE 做前端实时刷新）
2. 多模型真实并行调用与投票融合策略
3. 更精细技术指标计算（当前预留结构）
4. 实盘上线前建议增加二次审批和多角色权限
