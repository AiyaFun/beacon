// 手机号脱敏：138****8000。成员列表对同事也不该明文暴露完整号码。
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
