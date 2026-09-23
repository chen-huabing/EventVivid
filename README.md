# EventVivid

EventVivid 是面向活动发布、票券、报名、付费和现场签到的一体化 SaaS。当前版本实现 PRD 的 MVP 主链路，并为总部后台、活动管理平台、参会人页面和验签页面提供独立路由入口。

## 产品与开发文档

- [`docs/PRD.md`](docs/PRD.md)：Markdown 版产品需求文档。
- [`docs/MVP-开发文档.md`](docs/MVP-开发文档.md)：四个独立应用的 MVP 页面、功能、流程、接口与验收说明。
- [`docs/票券额度销售方案.md`](docs/票券额度销售方案.md)：统一电子票额度、建议价格和分阶段商业化规则。

## 技术栈

- Node.js 20、TypeScript、NestJS、Fastify
- PostgreSQL、Kysely；Redis/RabbitMQ 已纳入本地基础设施
- React、Vite、React Router
- Vitest、Supertest

## 本地启动

1. 复制 `.env.example` 为 `.env` 并填写连接信息。
2. 本地开发可启动基础设施：`docker compose up -d`。
3. 安装依赖：`npm install`。
4. 首次部署执行 `npm run db:create`，然后执行 `npm run db:migrate`。
5. 分别运行 `npm run dev:api`、`npm run dev:organizer`、`npm run dev:hq` 和 `npm run dev:web`。
6. 独立活动平台访问 `http://localhost:5173`，总部后台访问 `http://localhost:5174`，报名与验签过渡站点访问 `http://localhost:5175`。

升级到电子票额度版本时，请先备份数据库，再执行一次 `npm run db:migrate`，最后重启 API。迁移会给既有租户各补发 100 张电子票额度，历史出票不追溯扣费；重复运行不会再次发放。新租户注册或总部开通时自动获赠 100 张。总部后台 `/credits` 可人工补发并记录原因；活动平台 `/credits` 查看统一余额、预留和流水。

当前在线购买额度包、真实付费票支付回调、自动退款返还及到期数据通知／处置尚未接入。价格页展示的是试运营参考价，不能当作在线付款入口；生产环境禁止使用模拟确认接口签发付费票。活动数据留存政策统一为活动结束后 6 个月，自动处置须在导出通知和合规流程就绪后上线。

总部后台管理员通过 `.env` 中的 `HQ_ADMIN_USERNAME` 和 `HQ_ADMIN_PASSWORD` 初始化。需要主动重置时运行 `npm run db:seed-hq`。

活动平台租户管理员通过 `.env` 中的 `TENANT_ADMIN_USERNAME` 和 `TENANT_ADMIN_PASSWORD` 初始化。需要主动重置时运行 `npm run db:seed-tenant`。

开发阶段通过请求头模拟身份：`x-tenant-id`、`x-user-id`、`x-role`。正式认证、微信支付回调和消息异步消费将在后续迭代接入。
