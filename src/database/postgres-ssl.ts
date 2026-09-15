/** DigitalOcean Managed Postgres exige TLS. Local suele ir sin SSL. */
export function postgresSsl(host?: string, sslFlag?: string) {
  const on =
    sslFlag === 'true' ||
    (sslFlag !== 'false' && (host || '').includes('ondigitalocean.com'));
  if (!on) return false; 
  return { rejectUnauthorized: false as const };
}
