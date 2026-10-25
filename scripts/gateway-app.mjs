/**
 * Eaon's app ID and secret for signing requests to its gateway
 * (src/main/gatewaySignature.ts), as build-time constants from the build's
 * environment: EAON_GATEWAY_APP_ID and EAON_GATEWAY_APP_SECRET, from the
 * gateway dashboard (Access → Eaon apps). The release scripts and CI put them
 * there; they are never kept in the repository. Used by the app's main
 * process (electron.vite.config.ts), the worker host and the Eaon CLI.
 */
export const gatewayApp = {
  __EAON_GATEWAY_APP_ID__: JSON.stringify(process.env.EAON_GATEWAY_APP_ID ?? ''),
  __EAON_GATEWAY_APP_SECRET__: JSON.stringify(process.env.EAON_GATEWAY_APP_SECRET ?? '')
}
