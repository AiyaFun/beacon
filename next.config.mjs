/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 产物目录可用环境变量挪开：`BEACON_DIST_DIR=.next-verify npm run build`。
  // 默认的 `next build` 会**覆盖 dev server 正在用的 .next**，页面当场变成没有样式的裸 HTML
  // （看起来像样式全丢了，实际是 dev 的 chunk 被 production 产物顶掉了）。
  // 于是「本地开着 dev，想顺手验一下能不能构建」这件事此前只能二选一。
  distDir: process.env.BEACON_DIST_DIR || '.next',
  // Docker 精简镜像：只打包运行时依赖
  output: 'standalone',
  // Prisma 引擎在服务端外置，避免被打进 serverless bundle
  serverExternalPackages: ['@prisma/client', 'prisma', 'bullmq', 'ioredis'],
  // 2026-08-25 定选题三合一：/inspiration 与 /advisor 并进 /topics。老地址必须**永久**保留重定向——
  // 机器人推送里已持久化 beaconUrl('/inspiration') 链接（lib/bot/router.ts 存档回执），用户书签同理。
  // 用 redirects() 而不是留桩 page.tsx：孤儿页守卫会把无侧栏入口的 page.tsx 判红。
  async redirects() {
    return [
      { source: '/inspiration', destination: '/topics?view=inspiration', permanent: false },
      { source: '/advisor', destination: '/topics?view=advisor', permanent: false },
    ];
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
