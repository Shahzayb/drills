import { cache } from 'react';

/**
 * When this request started rendering.
 *
 * `cache()` memoises per request, so every component that asks gets the same
 * mark — and calling it is pure from React's point of view, which calling
 * `performance.now()` straight out of a component body is not. The lint rule
 * that rejects the direct call is right: an impure read during render is
 * exactly the thing that breaks when a component re-renders.
 */
export const renderStartedAt = cache(() => performance.now());
