# prisma/postgres/ 是什么，不是什么

**不是完整的建库记录。别照它去核对 schema 里的列。**

- **新装**走 `scripts/db-init-supabase.sh`：第一步就是 `prisma db push`（直接照 schema 建全），
  这个目录只负责 RLS / 扩展 / 索引 / 后来加的表。
- **存量升级**走 `scripts/deploy-gate.sh` 的闸门 3：
  `prisma migrate diff --from-url <生产库> --to-schema-datamodel <schema> --script`
  ——任何漏列都会被列出来，并直接给出可执行的 SQL。它比的是**真实生产库**，
  比任何「拿 schema 对着这个目录数一遍」的静态检查都强。

## 已经被判过两次误报的那件事

`WorkflowTemplate.persona` 在 schema 里有、这个目录里没有。
2026-08-22 判过一次误报并写进 `docs/上线清单-2026-08-22-任务台重构总览.md`；
2026-08-30 又被查出来一次，我据此加了一份迁移和一条「schema 的列必须在 SQL 里出现」的守卫——
**两个都撤掉了**：那条守卫会强迫以后每加一列都补一份多余的 SQL，
即把一个错误的模型固化成机器判据。**一条执行错误不变量的守卫，比没有守卫更糟。**

要判「生产库缺不缺列」，跑部署闸门，不要读这个目录。
