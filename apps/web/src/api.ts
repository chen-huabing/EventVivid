const base = import.meta.env.VITE_API_URL ?? `${window.location.protocol}//${window.location.hostname}:3000/api/v1`;
const contextHeaders = {
  'x-tenant-id': '00000000-0000-4000-8000-000000000001',
  'x-user-id': '00000000-0000-4000-8000-000000000002',
  'x-role': 'tenant_admin',
};

export const checkinSession = {
  get: () => localStorage.getItem('eventvivid_checkin_token'),
  set: (token: string) => localStorage.setItem('eventvivid_checkin_token', token),
  clear: () => localStorage.removeItem('eventvivid_checkin_token'),
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = checkinSession.get();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...contextHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? '请求失败');
  return data as T;
}

export function idempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
