import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 2026-09-04 生产事故（站点 502 约两分钟）：deploy-swap.sh 里 BEACON_WEB_PORT 只是赋值、
// 没有 export，`docker compose up -d web` 读不到它，端口回退到 compose 默认的 3000，
// 而生产 3000 被别的项目占着 → 主实例起不来，而旧容器此刻已经被移除。
//
// 判据写成机器可查的：凡是 docker-compose.yml 里用 ${VAR} 决定宿主端口的变量，
// 部署脚本要么 export、要么根本不碰；只赋值不 export 是最危险的中间态——
// 脚本里看着「设了值」，compose 却看不见。
describe('🔒 部署脚本传给 docker compose 的端口变量必须 export', () => {
  const root = process.cwd();
  const swap = fs.readFileSync(path.join(root, 'scripts/deploy-swap.sh'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

  it('compose 用来定宿主端口的变量，脚本里都是 export 的', () => {
    const portVars = new Set<string>();
    for (const m of compose.matchAll(/-\s*'\$\{[A-Z_]+(?::-[^}]*)?\}:\$\{([A-Z_]+)(?::-[^}]*)?\}:\d+'/g)) {
      portVars.add(m[1]);
    }
    expect(portVars.size, '没从 docker-compose.yml 里解析出端口变量——这条守卫会恒绿').toBeGreaterThan(0);

    const bad: string[] = [];
    for (const v of portVars) {
      const assigned = new RegExp(`^\\s*${v}=`, 'm').test(swap);
      const exported = new RegExp(`^\\s*export\\s+${v}=`, 'm').test(swap);
      if (assigned && !exported) bad.push(`${v}：脚本里赋了值却没 export，docker compose 读不到`);
    }
    expect(bad, '只赋值不 export = compose 用默认端口，撞上同机其它项目就起不来（2026-09-04 真实事故）\n').toEqual([]);
  });

  it('主实例与临时实例的端口变量都确实被 export 了', () => {
    expect(swap, 'BEACON_WEB_PORT 必须 export').toMatch(/^\s*export\s+BEACON_WEB_PORT=/m);
    expect(swap, 'BEACON_WEB_PORT_B 必须 export').toMatch(/^\s*export\s+BEACON_WEB_PORT_B=/m);
  });
});
