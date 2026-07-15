async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`http://localhost:3000${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function getDay(date: string) {
  return req(`/analytics/day?date=${date}`);
}
export async function listDevices() {
  return req('/devices');
}
export async function createDevice(input: { name: string; os: string }) {
  return req('/devices', { method: 'POST', body: JSON.stringify(input) });
}