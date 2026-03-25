const JUPITER_API_HOST = 'api.jup.ag';
const JUPITER_LITE_API_HOST = 'lite-api.jup.ag';
const JUPITER_LEGACY_QUOTE_HOST = 'quote-api.jup.ag';
const JUPITER_SWAP_API_PATH = '/swap/v1';

export const JUPITER_KEYLESS_SWAP_API_URL = `https://${JUPITER_LITE_API_HOST}${JUPITER_SWAP_API_PATH}`;
export const JUPITER_KEYED_SWAP_API_URL = `https://${JUPITER_API_HOST}${JUPITER_SWAP_API_PATH}`;

export function getDefaultJupiterSwapApiUrl(apiKey?: string): string {
  return apiKey ? JUPITER_KEYED_SWAP_API_URL : JUPITER_KEYLESS_SWAP_API_URL;
}

export function normalizeJupiterSwapApiUrl(rawUrl: string, apiKey?: string): string {
  const input = rawUrl.trim();
  if (!input) return getDefaultJupiterSwapApiUrl(apiKey);

  try {
    const url = new URL(input);
    const preferredHost = apiKey ? JUPITER_API_HOST : JUPITER_LITE_API_HOST;
    const normalizedPath = normalizePath(url.pathname);

    if (url.hostname === JUPITER_LEGACY_QUOTE_HOST) {
      return buildSwapApiUrl(url, preferredHost);
    }

    if (url.hostname === JUPITER_API_HOST || url.hostname === JUPITER_LITE_API_HOST) {
      url.hostname = preferredHost;

      if (normalizedPath === '/' || normalizedPath === '/v6' || normalizedPath.startsWith('/v6/')) {
        return buildSwapApiUrl(url, preferredHost);
      }

      if (normalizedPath === JUPITER_SWAP_API_PATH) {
        return `${url.origin}${JUPITER_SWAP_API_PATH}`;
      }
    }

    return trimTrailingSlash(input);
  } catch {
    return trimTrailingSlash(input);
  }
}

function buildSwapApiUrl(url: URL, host: string): string {
  url.hostname = host;
  url.pathname = JUPITER_SWAP_API_PATH;
  url.search = '';
  url.hash = '';
  return `${url.origin}${url.pathname}`;
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed || '/';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
