import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/health/route';

describe('GET /api/health 鉴权与安全兜底', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.BEACON_HEALTH_TOKEN;
    delete process.env.BEACON_ENV;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('未配置 BEACON_HEALTH_TOKEN 时：仅在明确的 NODE_ENV=development 下返回 checks 详情', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const req = new NextRequest('http://localhost:3000/api/health');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toBeDefined();
    expect(body.checks.queue).toBeDefined();
  });

  it('未配置 BEACON_HEALTH_TOKEN 时：NODE_ENV=production 不泄露 checks', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const req = new NextRequest('http://localhost:3000/api/health');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toBeUndefined();
  });

  it('未配置 BEACON_HEALTH_TOKEN 时：BEACON_ENV=prod 不泄露 checks', async () => {
    vi.stubEnv('BEACON_ENV', 'prod');
    vi.stubEnv('NODE_ENV', 'development');
    const req = new NextRequest('http://localhost:3000/api/health');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toBeUndefined();
  });

  it('未配置 BEACON_HEALTH_TOKEN 时：环境错配/非明确开发环境（如 NODE_ENV 未设或 staging）默认不泄露 checks', async () => {
    vi.stubEnv('NODE_ENV', 'staging');
    const req = new NextRequest('http://localhost:3000/api/health');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toBeUndefined();
  });

  it('已配置 BEACON_HEALTH_TOKEN 时：带正确 token 可查看详情', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_HEALTH_TOKEN', 'secret-token-123');

    const req = new NextRequest('http://localhost:3000/api/health', {
      headers: { 'x-beacon-health-token': 'secret-token-123' },
    });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.checks).toBeDefined();
  });

  it('已配置 BEACON_HEALTH_TOKEN 时：Bearer Authorization 也支持鉴权', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_HEALTH_TOKEN', 'secret-token-123');

    const req = new NextRequest('http://localhost:3000/api/health', {
      headers: { authorization: 'Bearer secret-token-123' },
    });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.checks).toBeDefined();
  });

  it('已配置 BEACON_HEALTH_TOKEN 时：token 错误或未带不泄露 checks', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_HEALTH_TOKEN', 'secret-token-123');

    const req = new NextRequest('http://localhost:3000/api/health', {
      headers: { 'x-beacon-health-token': 'wrong-token' },
    });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.checks).toBeUndefined();
  });
});
