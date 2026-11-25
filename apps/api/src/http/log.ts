// The request log. The two GitHub callbacks carry a code and `state` in their query string, so a
// callback address is logged without its query string.

type LoggedRequest = {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
};

export function loggedUrl(url: string) {
  const index = url.indexOf('?');
  if (index === -1) return url;
  const path = url.slice(0, index);
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // An undecodable path is checked as it is.
  }
  return /callback/i.test(decoded) ? path : url;
}

export function loggerOptions(enabled: boolean, stream: { write(line: string): void } | undefined) {
  if (!enabled && !stream) return false;
  return {
    ...(stream ? { stream } : {}),
    serializers: {
      req: (request: LoggedRequest) => ({
        method: request.method,
        url: loggedUrl(request.url ?? ''),
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      }),
    },
  };
}
