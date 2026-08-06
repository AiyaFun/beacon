// 飞书自建应用机器人体检：把「测试失败」拆成 3 步，逐步打印飞书原始返回。
// 用法（凭据只从环境变量读，不落盘、不打印 secret）：
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npx tsx scripts/diag-feishu-bot.ts
//
// 每一步都直接给飞书原文 code/msg，避免被上层包装过的文案带偏。

const APP_ID = process.env.FEISHU_APP_ID ?? '';
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';

if (!APP_ID || !APP_SECRET) {
  console.error('缺少环境变量。用法：');
  console.error('  FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npx tsx scripts/diag-feishu-bot.ts');
  process.exit(1);
}

const BASE = 'https://open.feishu.cn/open-apis';

function line() {
  console.log('─'.repeat(64));
}

async function main() {
  console.log(`App ID: ${APP_ID}  (secret 长度 ${APP_SECRET.length}，不回显)`);

  // ── 步骤 1：换 tenant_access_token ──
  line();
  console.log('① 换取 tenant_access_token');
  const tokenRes = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const tokenJson: any = await tokenRes.json().catch(() => null);
  console.log('   飞书返回：', JSON.stringify({ code: tokenJson?.code, msg: tokenJson?.msg }));

  const token = tokenJson?.tenant_access_token;
  if (!token) {
    console.log('\n❌ 卡在第 ① 步：App ID / App Secret 不对，或应用被停用。');
    console.log('   → 去开放平台「凭证与基础信息」核对 App ID / App Secret。');
    return;
  }
  console.log('   ✅ 拿到 token');

  // ── 步骤 2：列出机器人所在群（需要 im:chat:readonly 等群信息权限）──
  line();
  console.log('② 列出机器人所在的群（需要 im:chat:readonly）');
  const chatsRes = await fetch(`${BASE}/im/v1/chats?user_id_type=open_id`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const chatsJson: any = await chatsRes.json().catch(() => null);
  console.log('   飞书返回：', JSON.stringify({ code: chatsJson?.code, msg: chatsJson?.msg }));

  if (chatsJson?.code !== 0) {
    console.log('\n❌ 卡在第 ② 步：读取群列表被拒。');
    if (String(chatsJson?.code) === '99991672') {
      console.log('   → 权限不足：开放平台「权限管理」加 im:chat:readonly（获取群组信息），然后重新发布版本。');
    } else {
      console.log('   → 按上面的 code/msg 对照飞书错误码文档。');
    }
    return;
  }

  const chats: any[] = chatsJson?.data?.items ?? [];
  console.log(`   ✅ 机器人当前在 ${chats.length} 个群`);
  chats.forEach((c) => console.log(`      · ${c.name ?? '(无名)'}  ${c.chat_id}`));

  if (chats.length === 0) {
    console.log('\n❌ 权限正常，但机器人一个群都没进。');
    console.log('   → 去飞书群「设置 → 群机器人 → 添加机器人」把你的应用加进去。');
    return;
  }

  // ── 步骤 3：真发一条（Bot Not Enabled 通常在这一步暴露）──
  line();
  console.log('③ 向第一个群发测试消息');
  const target = chats[0];
  const sendRes = await fetch(`${BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: target.chat_id,
      msg_type: 'text',
      content: JSON.stringify({ text: '烽火台体检消息，看到即说明机器人已打通。' }),
    }),
  });
  const sendJson: any = await sendRes.json().catch(() => null);
  console.log('   飞书返回：', JSON.stringify({ code: sendJson?.code, msg: sendJson?.msg }));

  if (sendJson?.code === 0) {
    line();
    console.log('✅ 三步全通，群里应该已经收到消息了。');
    console.log('   若烽火台里仍报错，说明线上跑的是旧代码，重新 build + 重启即可。');
    return;
  }

  console.log('\n❌ 卡在第 ③ 步：能列群、但发不出去。');
  if (/bot not enabled/i.test(String(sendJson?.msg))) {
    console.log('   这就是「Bot Not Enabled」——应用没有开启机器人能力，或开了但没发版生效：');
    console.log('   1) 开放平台 → 你的应用 → 「应用功能」→「机器人」→ 点「启用」');
    console.log('   2) 「权限管理」确认有 im:message:send_as_bot（以应用身份发消息）');
    console.log('   3) 「版本管理与发布」→ 创建版本 → 发布');
    console.log('   4) 关键：企业里发布通常要管理员审核，状态是「审核中」时机器人能力还没生效，');
    console.log('      要等状态变成「已发布/已生效」再测。');
  } else {
    console.log('   → 按上面的 code/msg 对照飞书错误码文档。');
  }
}

main().catch((e) => {
  console.error('体检脚本异常：', e);
  process.exit(1);
});
