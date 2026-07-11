import type { Env } from './types'

function decode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), x => x.charCodeAt(0))
}

export async function requireAccess(request: Request, env: Env): Promise<{ email: string }> {
  const token = request.headers.get('CF-Access-Jwt-Assertion')
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) throw new Response('Forbidden', { status: 403 })
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Response('Forbidden', { status: 403 })
  let header: { kid?: string; alg?: string }, payload: { aud?: string | string[]; exp?: number; email?: string; iss?: string }
  try { header = JSON.parse(new TextDecoder().decode(decode(encodedHeader))); payload = JSON.parse(new TextDecoder().decode(decode(encodedPayload))) } catch { throw new Response('Forbidden', { status: 403 }) }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (header.alg !== 'RS256' || !header.kid || !aud.includes(env.ACCESS_AUD) || !payload.exp || payload.exp * 1000 < Date.now() || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new Response('Forbidden', { status: 403 })
  const certs = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`).then(r => r.ok ? r.json() as Promise<{ keys: Array<JsonWebKey & { kid?: string }> }> : Promise.reject(new Error('certs_unavailable')))
  const jwk = certs.keys.find(key => key.kid === header.kid)
  if (!jwk) throw new Response('Forbidden', { status: 403 })
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(encodedSignature) as unknown as BufferSource, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`))) throw new Response('Forbidden', { status: 403 })
  return { email: payload.email ?? 'access-user' }
}
