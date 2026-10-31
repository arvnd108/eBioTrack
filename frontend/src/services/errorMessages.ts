// Owner: B (Frontend)
// Purpose: Plain-language text for API errors (CONTRACT 7 and 8 error codes)
//
// One place that turns an ApiError (or anything thrown) into a sentence for the screen, so every
// page words the same failure the same way. Server messages for rule errors (validation_error,
// rule_violation, conflict, ...) are already short human sentences (CONTRACT 7), so they are
// shown as they are; codes whose server text is technical or generic get a clearer sentence.

import { isApiError } from './apiClient';

/** "about 3 minutes", "about 1 minute", "a few seconds". */
export function describeWait(seconds: number): string {
  if (seconds < 60) return 'a few seconds';
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** A sentence describing what went wrong, for display. */
export function errorMessage(error: unknown): string {
  if (!isApiError(error)) {
    return 'Something went wrong. Please try again.';
  }
  switch (error.code) {
    case 'network_error':
      return 'Could not reach the server. Check your connection and try again.';
    case 'unauthenticated':
      return 'Your session has ended. Please sign in again.';
    case 'forbidden':
      return 'You do not have permission to do this.';
    case 'too_many_attempts':
      return error.retryAfter
        ? `Too many failed sign-in attempts. Try again in ${describeWait(error.retryAfter)}.`
        : 'Too many failed sign-in attempts. Try again later.';
    case 'invalid_response':
      return 'The server sent an unexpected response. Please try again.';
    default:
      if (error.status >= 500) {
        return 'The server ran into a problem. Please try again in a moment.';
      }
      return error.message || 'Something went wrong. Please try again.';
  }
}
