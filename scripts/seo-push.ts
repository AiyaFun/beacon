/**
 * 把公开页主动推送给搜索引擎（IndexNow → Bing/Yandex，百度普通收录 API）。
 *
 * 用法（本地）：
 *   npx tsx scripts/seo-push.ts              # 只打印会推什么，不发请求
 *   npx tsx scripts/seo-push.ts --apply      # 真的推
 *   npm run seo:push -- --apply
 *
 * 用法（生产，要读 .env.production 里的 key/token，所以在容器里跑）：
 *   cd /var/www/beacon && docker compose exec -T web npx tsx scripts/seo-push.ts --apply
 *   镜像里带了这个脚本（见 Dockerfile 的 runner 段）。1.3.81 那一版还没带，
 *   得先 `docker exec -u root <web> mkdir -p /app/scripts && chown nextjs:nodejs …`
 *   再 docker cp 进去——如果哪天又遇到 ERR_MODULE_NOT_FOUND，就是镜像没更新到。
 *
 * 【为什么默认 dry-run】百度的每日配额是有限的，手滑跑几次就能把新站的额度用掉。
 * 与 sync-system-data.ts 同一条纪律：会对外产生副作用的脚本，默认不产生副作用。
 *
 * 【什么时候跑】部署完、公开页内容有实质变化之后，跑一次。
 * **不要接进定时任务**：这个站的公开页是固定的十来个，每小时推一遍全量
 * 除了烧配额没有任何作用（引擎对高频重复提交同一批 URL 会降权处理甚至拒收）。
 *
 * 【它做不到什么】只影响收录速度，不影响排名。推了也可能不被收录——
 * 内容不够就是不够，推送改不了这件事。见 lib/geo/submit.ts 顶部。
 */
import { pushIndexNow, pushBaidu, submittableUrls, indexNowKey } from '../lib/geo/submit';
import { verificationStatus } from '../lib/geo/verification';

async function main() {
  const apply = process.argv.includes('--apply');
  const urls = submittableUrls();

  console.log(`\n本次会推 ${urls.length} 个 URL（判据：在 PUBLIC_PAGES 里且被 robots 放行）：`);
  for (const u of urls) console.log('  ' + u);

  const key = indexNowKey();
  console.log('\n通道状态：');
  console.log(`  IndexNow  ${key ? '已配置（key 末四位 …' + key.slice(-4) + '）' : '未配置 BEACON_INDEXNOW_KEY'}`);
  console.log(`  百度推送  ${process.env.BEACON_BAIDU_PUSH_TOKEN?.trim() ? '已配置' : '未配置 BEACON_BAIDU_PUSH_TOKEN'}`);

  // 【为什么把归属验证一起打出来】百度的 push token 要**先验证站点归属**才拿得到。
  // 一个人跑这个脚本看到「百度推送 未配置」时，真正该做的下一步往往是先去验证站点——
  // 不在这里说，他就只会去翻 env 找一个还不存在的 token。
  console.log('\n站长平台归属验证（没验证就拿不到提交权限）：');
  for (const v of verificationStatus()) {
    console.log(`  ${v.configured ? '已配置' : '未配置'}  ${v.label}  (${v.env})`);
  }

  if (!apply) {
    console.log('\n这是 dry-run，什么都没发。真的要推：加 --apply\n');
    return;
  }

  console.log('\n开始推送……');
  const results = await Promise.all([pushIndexNow(urls), pushBaidu(urls)]);
  for (const r of results) {
    console.log(`  [${r.ok ? '成功' : '未推送'}] ${r.channel}：${r.detail}（收下 ${r.submitted} 条）`);
  }

  // 【为什么「没配置」不算失败】没配 key 是一个明确的选择（比如私有化客户不接百度），
  // 拿它当失败会让部署脚本在一个本来正常的状态下红掉，红多了就没人看了。
  const realFailure = results.some((r) => !r.ok && !r.detail.includes('没配置'));
  if (realFailure) {
    console.error('\n有通道推送失败，看上面的原因。\n');
    process.exitCode = 1;
  } else {
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
