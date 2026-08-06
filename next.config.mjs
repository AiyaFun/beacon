/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Docker 精简镜像：只打包运行时依赖
  output: 'standalone',
  // Prisma 引擎在服务端外置，避免被打进 serverless bundle
  serverExternalPackages: ['@prisma/client', 'prisma', 'bullmq', 'ioredis'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
