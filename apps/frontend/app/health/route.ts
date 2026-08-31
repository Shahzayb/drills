import { fetchInfo } from '@/lib/api';

export async function GET() {
  const result = await fetchInfo();

  return Response.json({
    status: 'ok',
    checks: {
      api: result.ok
        ? { status: 'up' }
        : { status: 'down', error: result.error },
    },
  });
}
