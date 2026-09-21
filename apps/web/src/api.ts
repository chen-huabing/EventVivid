const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
const contextHeaders = {
  'x-tenant-id': '00000000-0000-4000-8000-000000000001',
  'x-user-id': '00000000-0000-4000-8000-000000000002',
  'x-role': 'tenant_admin',
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...contextHeaders, ...init.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? '请求失败');
  return data as T;
}

export const idempotencyKey = () => crypto.randomUUID();
