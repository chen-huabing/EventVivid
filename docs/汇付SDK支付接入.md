# 汇付斗拱 SDK：平台电子票额度购买

## 接入边界与当前状态

接入[汇付官方 Go SDK](https://paas.huifu.com/docs/devtools/#/sdk_go)，源码依赖为 [`huifurepo/bspay-go-sdk`](https://github.com/huifurepo/bspay-go-sdk)，锁定 `v1.0.34`（提交 `4c5b19daeeb523d9259c3c885714cb728b560125`）。NestJS 后端通过标准输入调用一次性 Go 进程，由 SDK 完成签名、通信、响应和通知验签，未引入非官方支付 SDK。

本模块仅销售 EventVivid 平台的电子票额度包，不处理参会人购买活动票种。平台收款商户为 `6666000245068152`，渠道商 `sys_id=6666000244121044`，产品 `XLSISV`，交易 `T_JSAPI`。用户提供的汇付公钥、服务商公钥分别保存为公开的验签配置和私钥配对校验配置，公钥不是发起交易所需的私钥。

已实现：服务端价格、待支付订单、PC 二维码、微信网页授权、手机 JSAPI 支付、通知验签持久化、独立查单补偿、额度幂等入账。默认禁止真实支付；缺少私钥、AppID/AppSecret、域名时只能核对订单，不能付款。目前没有实际渠道交易验证，退款、主动关单、账单下载/日对账、运营配置审计界面仍待实现；上线前必须完善这些能力及商户审核。

## 流程与金额

PC 选择额度包 → 确认订单 → 创建本租户订单 → 微信扫码打开手机收银台 → 点击授权/支付 → 微信 OAuth 取得同 AppID 的 OpenID → Go SDK 聚合下单 → 手机调用 `WeixinJSBridge` → 服务端查询确认成功 → 原子增加额度 → PC 查看结果。

二维码是平台收银台网页，不是 Native 的 `code_url`。桌面不调用 JSAPI，手机也不持有租户管理员登录凭证。公开支付链接使用专用 HS256 密钥签名，只允许访问其中一笔订单，有效 24 小时；付款窗口 30 分钟，过期拒绝新付款，但已经发起的订单仍查单，避免遗漏迟到的成功结果。PC 管理员可重新查看订单。

| 额度包 | 额度 | 金额（元） |
| --- | ---: | ---: |
| 小额补充包 | 100 张 | 99.00 |
| 常用包 | 500 张 | 399.00 |
| 批量包 | 2000 张 | 1399.00 |

价格与额度由服务端白名单确定，浏览器仅提交 `packCount` 和 UUID 幂等请求号。支付金额使用分单位整数和元单位两位小数字符串转换，不使用浮点计算。

## 服务端部署

1. 安装 Go 1.23 或以上，执行 `npm run build:huifu`。生成 `tools/huifu-sdk/dist/huifu-sdk.exe`（Windows）或 `huifu-sdk`（Linux）。跨平台部署必须为目标系统重新编译，不能复制 Windows 二进制到 Linux。`GO_BINARY` 可以指定 Go 安装路径。
2. 执行 `npm run db:migrate-credits --workspace @eventvivid/api`，仅增加额度购买订单、通知和 OAuth 状态表，不运行历史种子或增加余额。完整的 `db:migrate` 也包含这些表。
3. 配置根目录 `.env` 或部署密钥系统，参考 `.env.example`。私钥可用 `HUIFU_PRIVATE_KEY_FILE` 指向只允许后端读取的文件；相对路径基于后端进程工作目录（通常 `apps/api`）。支持 PKCS#8/PKCS#1 PEM；裸 base64 请使用 PKCS#8。`.secrets/` 已加入 Git 忽略。禁止把私钥/AppSecret发到聊天、提交 Git 或放入 `VITE_*`。
4. 将活动平台与 `/api/v1` 反向代理到同一个公网 HTTPS 域名，分别填写相同的 `HUIFU_CHECKOUT_ORIGIN` 和 `HUIFU_API_ORIGIN`，不包含路径和尾部 `/`。设置 `HUIFU_NOTIFY_URL=https://域名/api/v1/credit-checkout/notify`。局域网 IP 和 HTTP 不能用于正式 OAuth/回调。
5. 配置绑定此汇付收款商户的认证服务号 `HUIFU_WECHAT_APP_ID` / `HUIFU_WECHAT_APP_SECRET`。在公众号配置网页授权域名，在支付商户配置手机收银台的 JSAPI 支付授权目录。按渠道要求完成绑定和业务权限确认。
6. `HUIFU_CHECKOUT_SECRET` 使用独立随机值，至少 32 字符，不复用租户登录密钥。`HUIFU_ENV=sandbox` 或 `production` 必须明确指定，密钥与商户须匹配环境。
7. 参数核对与实际联调完成后，显式设 `HUIFU_PAYMENTS_ENABLED=true` 并重启后端。设回 false 仅禁止新支付；参数保持可用时，旧处理中订单仍由后台查单。密钥/商户/AppID 轮换前必须结清未完成订单，本版本不支持多套历史密钥。

生产代理需对 `/credit-checkout`、支付 API 和 OAuth 回调设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`，不记录 query、Cookie 或支付头，不能在支付页面引入第三方分析脚本；OAuth Code、订单令牌、OpenID、私钥、AppSecret 不得进入日志。后端已移除请求日志中的 query，并关闭 SDK 默认原文日志。回调端点应限制请求体及请求频率，公网仅暴露 HTTPS 代理，不暴露后端开发端口。

## 接口与 SDK 调用

| 本平台接口 | 用途与权限 |
| --- | --- |
| `GET /api/v1/credit-purchases/catalog` | 登录后获取额度包和配置就绪状态，不返回密钥 |
| `POST /api/v1/credit-purchases` | 租户管理员创建订单，服务端定价与幂等 |
| `GET /api/v1/credit-purchases` | 本租户最近 50 笔购买订单 |
| `GET /api/v1/credit-purchases/:id` | 本租户订单与短期扫码链接 |
| `POST /api/v1/credit-purchases/:id/query` | 登录后查单补偿，不发起支付 |
| `GET /api/v1/credit-checkout` | 通过 `x-checkout-token` 查看单笔订单 |
| `POST /api/v1/credit-checkout/oauth` | 生成 5 分钟一次性 OAuth state |
| `GET /api/v1/credit-checkout/oauth/callback` | 服务端换取 OpenID，写入 HttpOnly/Secure 支付 Cookie，不返回微信 access_token |
| `POST /api/v1/credit-checkout/pay` | 令牌与微信支付 Cookie 配对后下单，返回有限的 JSAPI 参数 |
| `POST /api/v1/credit-checkout/query` | 手机查单，不信任浏览器支付结果 |
| `POST /api/v1/credit-checkout/notify` | 公开通知入口，SDK 验签后持久化，纯文本应答 |

官方 SDK 下单使用 `V2TradePaymentJspayRequest`（`/v2/trade/payment/jspay`），`wx_data` 为包含 `sub_appid`、`sub_openid` 的 JSON 字符串，另传通知地址和付款过期时间。查单使用 `V2TradePaymentScanpayQueryRequest`（`/v2/trade/payment/scanpay/query`）的 `org_req_date`、`org_req_seq_id`。不能混用新版 v4 文档的字段名；如渠道要求新版接口，应升级适配器并重新验证。

通知接受 JSON 和 form-urlencoded，但必须携带字符串形式的 `resp_data` 和 `sign`。对原始解码后的 `resp_data` 验签，不能重新排序 JSON。通知持久化后返回 HTTP 200 及 `RECV_ORD_ID_` 加原请求流水号；验签失败、不匹配或写库失败不确认通知。后台每 30 秒处理一批待确认订单，订单之间独立重试，接口查单至少间隔 15 秒。网络失败或“未查到订单”不得标记为已支付或贸然重复下单。

## 安全与一致性

- Go 启动前验证私钥与给定服务商公钥配对，检查 RSA 位数；请求预签名失败则拒绝调用。响应缺少 data/sign、验签失败、超时、重定向或过大的报文均拒绝。
- 通知或微信前端成功回调不能直接发额度；独立查询结果需验证商户、请求号、日期、金额、交易类型、全局流水号和 `trans_stat=S`。
- 入账事务锁定订单和额度账户，唯一流水 `credit-purchase:订单ID` 防重复；更新余额、额度流水、订单终态必须同一事务，失败全部回滚。
- 第一次远程下单前先持久化处理中状态。超时后只能查单，不自动创建新交易。缓存的 JSAPI 参数只允许原付款 OpenID 使用，不能转给其他扫码用户。
- 退款不能只减少本地余额。当前不提供在线退款，退款与已消费额度处理、查单补偿、账单对账需另行实施后上线。

## 验证与上线门槛

`npm run test:huifu` 验证 SDK 签名、篡改拒绝、公私钥不匹配、缺失签名和官方请求结构；后端测试验证价格白名单、金额、时区、订单匹配、重复入账及事务回滚。测试只使用临时生成的测试密钥与内存数据库，不调用真实支付接口。

正式启用前必须在获准的渠道环境验证：两种通知内容类型、取消/失败/成功、同单重复扫码、响应丢失后查单、通知重试、后端重启补偿、付款跨过过期时间、商户和 AppID 绑定、零钱与银行卡、退款及日对账。公开公钥通过格式测试不等于验证了商户身份或实际支付权限。
