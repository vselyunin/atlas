import { ErrorResponseSchema } from '@atlas/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}
// Called when the API says the session has ended, so the Board can ask who is signed in again.
let signInRequiredHandler: (() => void) | undefined;
export function onSignInRequired(handler: (() => void) | undefined) {
  signInRequiredHandler = handler;
}
// For responses that carry no body (204).
export const NoContent = { parse: (): void => undefined };
export async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return schema.parse(undefined);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError(
      'The Atlas API is not ready. Check that it is running and try again.',
      response.status,
      'api_unavailable',
    );
  }
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(body);
    if (response.status === 401 && parsed.success && parsed.data.error.code === 'sign_in_required')
      signInRequiredHandler?.();
    throw new ApiError(
      parsed.success ? parsed.data.error.message : 'The request could not be completed',
      response.status,
      parsed.success ? parsed.data.error.code : 'request_failed',
    );
  }
  return schema.parse(body);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
