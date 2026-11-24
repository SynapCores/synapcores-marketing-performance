export { SynapCoresClient, SynapCoresError, SynapCoresUnavailableError } from './client';
export type {
  SynapCoresClientOptions,
  QueryResult,
} from './client';
export { ENGINE_UNAVAILABLE_DIGEST, isEngineUnavailableDigest } from './unavailable';
// ./retry stays internal: its helpers retry one request unit and must not be
// wrapped around several statements (see the comment there).
// server.ts is intentionally NOT re-exported from the package barrel —
// import it directly from "@synapcores/app-framework/db/server" inside
// route handlers / server actions / RSC. (server-only import marker.)
