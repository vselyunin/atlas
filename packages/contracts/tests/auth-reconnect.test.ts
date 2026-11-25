import { describe, expect, it } from 'vitest';
import { AuthStateResponseSchema } from '../src/index.js';

describe('the reconnect setup state', () => {
  it('is accepted without a user or an App', () => {
    expect(
      AuthStateResponseSchema.safeParse({
        auth: 'github',
        setup: 'reconnect',
        user: null,
        app: null,
      }).success,
    ).toBe(true);
  });

  it('still rejects an unknown setup state', () => {
    expect(
      AuthStateResponseSchema.safeParse({ auth: 'github', setup: 'recover', user: null, app: null })
        .success,
    ).toBe(false);
  });
});
