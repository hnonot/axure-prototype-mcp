/**
 * Shared configuration for the recon probes.
 *
 * Every probe addresses the same deployment, so the address lives here and nowhere else. These
 * scripts are throwaway diagnostic tools, not part of the server, but they used to carry a
 * hard-coded host in each file — which the 0.2.2 iteration forbids: outside `.env`, no fixed
 * address may exist anywhere in the project.
 *
 * Set `AXURE_URL` (or a `.env` file, which the probes do not read — pass the variable explicitly
 * when you run them) and every probe follows it. A missing address is an error rather than a
 * silent fallback, because a silent fallback is precisely the bug this iteration fixes.
 */

const raw = process.env.AXURE_URL?.trim();
if (!raw) {
  throw new Error(
    'AXURE_URL is required for the recon probes and has no default. ' +
      'Run them as: $env:AXURE_URL="http://host/Project"; node scripts/recon/<probe>.mjs',
  );
}

/** Project root, e.g. `http://host/Project`, without a trailing slash. */
export const BASE = raw.replace(/\/+$/, '');

/** A default page to inspect, overridable per run. Percent-encodes the name so non-ASCII is safe. */
export const pageUrl = (name) => `${BASE}/${encodeURIComponent(name)}.html`;

/** Convenience for the probes that open the sitemap's first entry. */
export const DEFAULT_PAGE = process.env.AXURE_PAGE || pageUrl('订单管理');

/** Proxy bypass for internal deployments, overridable. */
export const NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1,::1';

/** Environment for spawning the server from a probe. */
export const serverEnv = () => ({ ...process.env, AXURE_URL: BASE, NO_PROXY });
