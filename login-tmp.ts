import { prisma } from '@/lib/db';
import { issueLocalLoginTicket } from '@/lib/auth/local-link';
async function run() {
  const t = await prisma.tenant.findFirst({ where: { name: { contains: '9520' } } });
  const m = await prisma.member.findFirst({ where: { tenantId: t!.id } });
  const r = await issueLocalLoginTicket(t!.id, m!.id);
  console.log(r.ok ? `URL=http://localhost:3312/api/auth/local/magic?t=${r.ticket}` : `FAIL ${r.message}`);
}
run().then(() => process.exit(0));
