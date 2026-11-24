/**
 * "The database engine is unreachable" marker shared by the server (errors)
 * and the client (error boundaries). Client-safe: no imports.
 *
 * Next.js keeps a `digest` that a thrown error already carries and hands it to
 * the error boundary, while production builds strip the message. Errors that
 * mean "engine unreachable" carry this digest so the boundary can say
 * "reconnecting" instead of a generic failure. The digest is never shown.
 */
export const ENGINE_UNAVAILABLE_DIGEST = 'SYNAPCORES_ENGINE_UNAVAILABLE';

/** True for an error-boundary digest produced by an "engine unreachable" error. */
export function isEngineUnavailableDigest(digest: string | undefined | null): boolean {
  if (!digest) return false;
  // Next 15.5 appends "@<code>" only to its own errors (__NEXT_ERROR_CODE); accepted defensively.
  return digest === ENGINE_UNAVAILABLE_DIGEST || digest.startsWith(`${ENGINE_UNAVAILABLE_DIGEST}@`);
}
