# 对外调用与 MCP（本机部署）

让**别的程序**驱动这台烽火台：一个脚本、一个系统定时任务，或者 Claude 这类 MCP 客户端。

> **只有企业版（整机版 / 私有化）有这条路。** SaaS 的边界是公网，多开一条
> 「拿到一串字符就能代人操作」的通道要配套做速率、审计、异常检测一整套，
> 而这条能力的动机本来就是本机部署。SaaS 上相关路由直接 404、设置页那张卡也不渲染。

## 一、签一枚令牌

烽火台网页 →「设置 → 账号与安全 → 对外调用令牌」→ 起个名字（如「我的 Mac mini」）→ 签一枚。

**明文只显示这一次。** 能再看就意味着它随时可读，那么任何一次会话劫持都等于拿到了
长期凭证。丢了就重签一枚，成本很低。

令牌**绑到你本人**：调用时的每一步权限按你自己的角色算。你被降权或移出团队，
这枚令牌立刻跟着失效——不需要额外去收回它。

## 二、直接用 HTTP 调

```bash
# 让它去做一件事（立刻返回 runId，执行在后台跑）
curl -X POST http://127.0.0.1:3070/api/v1/runs \
  -H "Authorization: Bearer bck_你的令牌" \
  -H "content-type: application/json" \
  -d '{"goal":"看看我最近作品数据怎么样，给点建议"}'
# → {"ok":true,"runId":"cm...","status":"running"}

# 看它走到哪了
curl http://127.0.0.1:3070/api/v1/runs/cm... \
  -H "Authorization: Bearer bck_你的令牌"

# 最近几次
curl "http://127.0.0.1:3070/api/v1/runs?limit=5" \
  -H "Authorization: Bearer bck_你的令牌"
```

状态一共六种：

| 状态 | 意思 | 你该做什么 |
|---|---|---|
| `running` | 在跑 | 等着，隔几秒再查 |
| `awaiting_confirm` | **停下来等人确认**（有一步要改数据或花钱） | 打开返回里给的那个网址点一下 |
| `waiting_browser` | 在等浏览器插件把活干完 | 把那台机器的浏览器打开 |
| `done` / `failed` / `cancelled` | 结束了 | 看 `answer` / `error` |

## 三、配进 Claude 这类 MCP 客户端

```json
{
  "mcpServers": {
    "beacon": {
      "command": "npx",
      "args": ["tsx", "/你的路径/beacon/mcp-server.ts"],
      "env": {
        "BEACON_API_URL": "http://127.0.0.1:3070",
        "BEACON_API_TOKEN": "bck_你的令牌"
      }
    }
  }
}
```

配好之后，在那个客户端里直接说「让烽火台看看我最近数据怎么样」就行。

暴露七个工具：

- `beacon_run` —— 让它去做一件事
- `beacon_run_status` —— 看一次执行走到哪了
- `beacon_recent_runs` —— 最近几次
- `beacon_collect_competitor` —— 让用户的浏览器插件去采一个**已订阅**的竞对
- `beacon_collect_self` —— 让浏览器打开用户本人的主页回填自有数据（platform=x / tiktok；创作者后台没有可派的路，公众号那条已于 2026-09-03 移除）
- `beacon_read_page` —— 让插件打开白名单站点里的一页、把可见正文读回来
- `beacon_browser_task_status` —— 看一个浏览器任务走到哪了

## 三之二、浏览器动词（指挥用户自己的插件）

后三个动词走的是 `/api/v1/browser-tasks`：

```bash
# 排一个「采竞对」任务（competitor 可以是监控列表里的 id、主页 handle 或名字，精确匹配）
curl -X POST http://127.0.0.1:3070/api/v1/browser-tasks \
  -H "Authorization: Bearer bck_你的令牌" \
  -H "content-type: application/json" \
  -d '{"kind":"collect_competitor","competitor":"学习博主小王","limit":20}'
# → {"ok":true,"taskId":"cm...","status":"pending","note":"已排队…"}

# 看进度 / 拿结果
curl http://127.0.0.1:3070/api/v1/browser-tasks/cm... \
  -H "Authorization: Bearer bck_你的令牌"
```

`kind` 只有三个：`collect_competitor` / `collect_self`（`platform` 目前只有 `wechat`）/
`open_and_read`（`url` 必须在插件硬编码的站点白名单里，且工作区开过
「让插件替我读网页」开关——默认是关的）。

**这不是「远程驱动浏览器」的接口。** 没有打开任意 URL、点击、填表、执行脚本的动词，
将来也不会有：能派的动作是一份写死在插件代码里的白名单，服务端下发白名单以外的
指令插件不认。理由与整个采集架构一致——一枚泄漏的令牌，不该等于一台带着
用户登录态的可遥控浏览器。三道闸（有没有插件 / 读网页开关+域白名单 /
竞对必须在监控列表）与 AI 工具 `dispatch_browser_task` 共用同一份实现
（`lib/browser-task/vet.ts`），不存在「API 这条路更宽」。

任务是异步的：`pending` 要等一台装了插件、令牌有效的浏览器在线来领；
48 小时无人执行自动作废（`expired`，不算失败）。所有任务照常出现在
烽火台「运行中心」，标注「外部程序派的」。

## 四、有一件事它**做不了**：确认

写操作（建草稿、加对标、跑一个智能体、配定时…）永远会停在 `awaiting_confirm`，
而**调用面上没有确认接口，MCP 也没有确认工具**。

这是刻意的。调用 MCP 的通常是**另一个模型**：让模型 A 起草、模型 B 代签，
「睡着时花钱的合约不让模型代签」这条规矩就形同虚设。要确认，去网页上点那一下——
那是人做的。

停在等确认时，接口会把**能直接打开的地址**给出来（`needsConfirm.hint`），
因为调用方是个程序，它不知道这台机器的网页在哪；而卡着不动是最容易被当成「挂了」的状态。

## 五、这条路和网页是同一条

调用面**不为 API 另开一套执行逻辑**——它调的就是网页那边同一个 `startAgentRun`。
两边的确认闸、配额闸、权限判定、审计流水完全一致。

另开一套的下场是确定的：两边的规矩迟早各走各的，而对不上的那一次，
多半发生在安全边界上。
