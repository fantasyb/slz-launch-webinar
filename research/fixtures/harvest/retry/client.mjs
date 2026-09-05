// Calls a flaky upstream. Retries on 429 and 5xx.
export async function call(fetchImpl, url, attempt = 0) {
  const res = await fetchImpl(url);
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error('gave up after ' + attempt + ' attempts');
    const wait = 1000 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, wait));
    return call(fetchImpl, url, attempt + 1);
  }
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}
