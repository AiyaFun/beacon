import { prisma } from '../lib/db';
import { requestLoginCode, verifyLoginCode, getMemberByToken } from '../lib/auth';
async function main(){
  console.log('\n━━━ 鉴权流程验证 ━━━');
  // 1. 已有演示号（林悦 13800138000）
  const r1 = await requestLoginCode('13800138000');
  console.log('发码(已注册号):', r1.ok, 'devCode=', r1.devCode);
  const v1 = await verifyLoginCode('13800138000', r1.devCode!);
  console.log('  验码→登录:', v1.ok, 'token=', v1.token?.slice(0,10)+'…');
  const m1 = await getMemberByToken(v1.token);
  console.log('  会话解析: member=', m1?.memberName, 'tenant=', m1?.tenantId.slice(0,8), 'account=', m1?.accountId? '有':'无');

  // 2. 新号自动注册
  const newPhone = '13900000001';
  await prisma.member.deleteMany({ where: { phone: newPhone } }); // 清理便于重复跑
  const r2 = await requestLoginCode(newPhone);
  const v2 = await verifyLoginCode(newPhone, r2.devCode!);
  const m2 = await getMemberByToken(v2.token);
  console.log('新号自动注册:', v2.ok, '→ 新租户=', m2?.tenantId.slice(0,8), '起始账号=', m2?.accountId? '已开通':'无');

  // 3. 错误码 & 频控
  const bad = await verifyLoginCode('13800138000', '000000');
  console.log('错误验证码被拒:', !bad.ok, '(', bad.message, ')');
  const dup = await requestLoginCode('13800138000');
  console.log('60s频控生效:', !dup.ok, '(', dup.message, ')');
  console.log('');
}
main().catch(e=>{console.error(e);process.exit(1)}).finally(()=>prisma.$disconnect());
