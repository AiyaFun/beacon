import { prisma } from '../lib/db';
import { getQueue } from '../lib/jobs/queue';
async function main(){
  const q = getQueue();
  console.log('队列模式:', q.kind);
  await q.enqueue('ingest_hot');
  await q.enqueue('cluster_topics');
  const runs = await prisma.jobRun.findMany({ orderBy:{startedAt:'desc'}, take:2 });
  runs.forEach(r=>console.log(`  JobRun ${r.name} [${r.track}] ${r.status} ${r.durationMs}ms — ${r.detail}`));
  const llm = await prisma.llmCallLog.count();
  const cost = await prisma.llmCallLog.aggregate({ _sum:{ costUsd:true, promptTokens:true } });
  console.log(`  LLM 账本: ${llm} 条调用, 累计成本 $${(cost._sum.costUsd??0).toFixed(6)}, prompt tokens ${cost._sum.promptTokens??0}`);
}
main().catch(e=>{console.error(e);process.exit(1)}).finally(()=>prisma.$disconnect());
