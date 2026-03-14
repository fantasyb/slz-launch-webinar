import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-XSS-Protection': '0',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Add security headers to all responses
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }

  // CSRF protection for API mutation requests (non-GET)
  if (request.nextUrl.pathname.startsWith('/api/') && request.method !== 'GET') {
    // API key authenticated requests bypass CSRF (machine-to-machine)
    const hasApiKey = request.headers.get('authorization')?.startsWith('Bearer agn_');

    if (!hasApiKey) {
      const origin = request.headers.get('origin');
      const host = request.headers.get('host');
      if (origin && host && !origin.includes(host)) {
        return NextResponse.json(
          { error: 'CSRF validation failed' },
          { status: 403, headers: Object.fromEntries(Object.entries(SECURITY_HEADERS)) }
        );
      }
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
