import { cache } from 'react';

export const renderStartedAt = cache(() => performance.now());
