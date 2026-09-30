/**
 * Read-only snapshot of upstream OpenStack release facts for one series.
 *
 * The `openstack/releases` project is the machine-readable source of truth for
 * "what is the latest version of deliverable X in series Y". Each deliverable is
 * a YAML file under `deliverables/<series>/<name>.yaml` listing every tagged
 * release (`releases[].version`) and the git repos it ships from
 * (`releases[].projects[].repo`, plus `repository-settings` keys).
 *
 * This model enumerates those files via the opendev Gitea contents API, fetches
 * each raw, and records the newest version per deliverable so the `epoxy_gap`
 * report can compare the SIG distgit against it.
 *
 * In addition to the cycle-bound deliverables (`deliverables/<series>/`), we
 * also fetch `deliverables/_independent/` — libraries, tools, and utilities
 * that release on their own schedule rather than being tied to a named
 * OpenStack cycle. Both sets are merged into a single `deliverables` array
 * with each entry tagged by its `series` ("epoxy" or "independent"). When a
 * deliverable appears in both directories the cycle-bound entry wins.
 *
 * ## Latest-version selection
 *
 * "Newest" is decided with the shared {@link rpmvercmp} port — the *same* notion
 * of order the report uses — never a string `max`. The deliverable YAML is
 * conventionally append-ordered (last `releases[]` entry is the newest), so the
 * last-entry version is kept as an independent cross-check: when it disagrees
 * with the vercmp maximum the entry is recorded in `mismatches` for human
 * triage. `latestVersion` is always the vercmp maximum — we surface the
 * disagreement rather than silently trusting either source.
 *
 * One OpenStack-specific wrinkle: upstream tags pre-releases in **PEP440**
 * (`27.0.0.0rc1`), not RPM tilde (`27.0.0~rc1`). A faithful `rpmvercmp` ranks
 * `X.0.0.0rc1` *after* `X.0.0` (it has extra segments), so a naive maximum picks
 * the release candidate over the final release and every package on `X.0.0`
 * looks falsely "behind". So {@link isPreRelease} pre-releases are excluded from
 * the maximum unless a deliverable has *only* pre-releases.
 *
 * ## Transport & authentication
 *
 * Plain anonymous HTTPS via `fetch` (the seam {@link httpText}). The Gitea
 * contents endpoint returns the full directory in one un-paginated array; each
 * entry carries a `download_url` for the raw YAML. No auth, no Kerberos.
 *
 * ## YAML parsing
 *
 * Parsed with the YAML *failsafe* schema so every scalar stays a string — a
 * date-style version like `2024.10` must not be coerced to the float `2024.1`
 * (which would silently drop the trailing zero and corrupt the comparison).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { parse as parseYaml } from "npm:yaml@2.6.1";
import { rpmvercmp } from "../lib/rpmvercmp.ts";

/** Connection settings for the opendev release-data source. */
const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .default("https://opendev.org")
    .describe("Gitea host serving openstack/releases (no trailing slash)"),
  repo: z
    .string()
    .default("openstack/releases")
    .describe("owner/name of the releases repository on the Gitea host"),
  series: z
    .string()
    .default("epoxy")
    .describe("OpenStack release series to snapshot (deliverables/<series>/)"),
  ref: z
    .string()
    .default("master")
    .describe("Git ref of openstack/releases to read the deliverables from"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(6)
    .describe("Max concurrent raw-file fetches against the Gitea host"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schema
// ---------------------------------------------------------------------------

/** One deliverable's newest version + the repos it ships from. */
const DeliverableEntrySchema = z.object({
  deliverable: z.string(),
  latestVersion: z.string().nullable(),
  latestVersionSource: z.enum(["vercmp-max", "none"]),
  fileOrderVersion: z.string().nullable().describe(
    "Last releases[] entry, for cross-check",
  ),
  repos: z.array(z.string()),
  releaseCount: z.number().int(),
  series: z.enum(["epoxy", "independent"]).default("epoxy")
    .describe(
      "Release series: 'epoxy' for cycle-bound deliverables, 'independent' for _independent/",
    ),
});

/** Snapshot of a series' upstream release facts. */
const DeliverablesSchema = z.object({
  series: z.string(),
  baseUrl: z.string(),
  repo: z.string(),
  ref: z.string(),
  source: z.literal("gitea-api"),
  deliverableCount: z.number().int(),
  deliverables: z.array(DeliverableEntrySchema),
  independentCount: z.number().int().default(0)
    .describe("Number of _independent deliverables merged in (before dedup)"),
  mismatches: z
    .array(z.object({
      deliverable: z.string(),
      vercmpMax: z.string().nullable(),
      fileOrder: z.string().nullable(),
    }))
    .describe("Deliverables where the vercmp maximum != the last file entry"),
  fetchedAt: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A deliverable entry as produced by {@link parseDeliverable}. */
export interface DeliverableEntry {
  deliverable: string;
  latestVersion: string | null;
  latestVersionSource: "vercmp-max" | "none";
  fileOrderVersion: string | null;
  repos: string[];
  releaseCount: number;
  series: "epoxy" | "independent";
}

/**
 * True when a version string is a PEP440 pre-release (a release candidate,
 * alpha, beta, preview, or dev tag as a numeric suffix, e.g. `27.0.0.0rc1`,
 * `1.2.0.0b3`). Both the normalized short forms (`a`/`b`/`rc`/`c`) OpenStack
 * emits and the spelled-out spellings (`alpha`/`beta`/`preview`) are caught, so
 * a non-canonical tag can't slip through as a "final". These must not be treated
 * as the newest release — RPM segment order would rank them after the matching
 * final. Post-releases (`.postN`) are NOT pre-releases.
 *
 * ## Asymmetry with RPM tilde pre-releases (AR-5 — known limitation)
 *
 * This filter is *only* needed because OpenStack tags in PEP440 form
 * (`27.0.0.0rc1`), where `rpmvercmp` ranks the rc *after* the matching final
 * (`27.0.0`) due to the extra `.0rc1` segment. Had upstream used RPM tilde
 * form (`27.0.0~rc1`), `rpmvercmp` would rank it correctly *before* the final
 * (tilde sorts before nothing) and no filter would be needed.
 *
 * In practice today every deliverable this model consumes tags in PEP440, so
 * the filter is required. If a deliverable ever mixed forms, both are handled
 * correctly: PEP440 pre-releases are excluded by this regex; RPM tilde
 * pre-releases are already sorted below the final by rpmvercmp itself and are
 * harmless in `pool`. This is asymmetric mechanism but a consistent outcome:
 * the chosen `latestVersion` is always the newest *final* release.
 *
 * @param v A version string.
 * @returns Whether it is a pre-release.
 */
export function isPreRelease(v: string): boolean {
  return /\d(?:alpha|a|beta|b|rc|c|preview|pre|dev)\d+$/i.test(v);
}

/**
 * Choose the newest of a list of version strings by {@link rpmvercmp}, and keep
 * the last (file-order) entry as an independent cross-check. Pre-releases
 * ({@link isPreRelease}) are excluded from the maximum unless every version is a
 * pre-release, so a final release always wins over its own release candidate.
 *
 * @param versions Version strings in file order (append-ordered by convention).
 * @returns The vercmp maximum (over stable versions), the file-order last entry,
 *   and whether they disagree. An empty list yields nulls and `source: "none"`.
 */
export function pickLatest(versions: string[]): {
  latestVersion: string | null;
  fileOrderVersion: string | null;
  source: "vercmp-max" | "none";
  mismatch: boolean;
} {
  if (versions.length === 0) {
    return {
      latestVersion: null,
      fileOrderVersion: null,
      source: "none",
      mismatch: false,
    };
  }
  const fileOrderVersion = versions[versions.length - 1];
  const stable = versions.filter((v) => !isPreRelease(v));
  const pool = stable.length > 0 ? stable : versions;
  let max = pool[0];
  for (const v of pool) if (rpmvercmp(v, max) > 0) max = v;
  return {
    latestVersion: max,
    fileOrderVersion,
    source: "vercmp-max",
    mismatch: rpmvercmp(max, fileOrderVersion) !== 0,
  };
}

/**
 * Parse one deliverable YAML into an entry. Scalars are read with the failsafe
 * schema (all strings) so version formatting is preserved verbatim.
 *
 * @param yamlText The raw deliverable YAML.
 * @param name The deliverable name (the file's basename without `.yaml`).
 * @param series The release series this deliverable belongs to.
 * @returns The parsed entry with its newest version and shipping repos.
 */
export function parseDeliverable(
  yamlText: string,
  name: string,
  series: "epoxy" | "independent" = "epoxy",
): DeliverableEntry {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText, { schema: "failsafe" });
  } catch (e) {
    // Only tolerate a genuine YAML *syntax* error (one malformed deliverable
    // file degrades to an empty entry). Any other error — notably a Deno
    // permission error (yaml@2 touches process.env at parse time, needing
    // --allow-env) — must fail loud: swallowing it here would silently degrade
    // EVERY deliverable to an empty, schema-valid-but-wrong snapshot.
    if ((e as Error)?.name === "YAMLParseError") {
      doc = null;
    } else {
      throw e;
    }
  }
  const d = (doc ?? {}) as {
    releases?: Array<
      { version?: unknown; projects?: Array<{ repo?: unknown }> }
    >;
    "repository-settings"?: Record<string, unknown>;
  };

  const releases = Array.isArray(d.releases) ? d.releases : [];
  const versions: string[] = [];
  const repos = new Set<string>();
  for (const r of releases) {
    if (typeof r?.version === "string") versions.push(r.version);
    for (const p of Array.isArray(r?.projects) ? r.projects! : []) {
      if (typeof p?.repo === "string") repos.add(p.repo);
    }
  }
  // repository-settings keys are the canonical repo list — merge them in so a
  // deliverable with no release projects still carries its repos.
  const rs = d["repository-settings"];
  if (rs && typeof rs === "object") {
    for (const k of Object.keys(rs)) repos.add(k);
  }

  const picked = pickLatest(versions);
  return {
    deliverable: name,
    latestVersion: picked.latestVersion,
    latestVersionSource: picked.source,
    fileOrderVersion: picked.fileOrderVersion,
    repos: [...repos].sort(),
    releaseCount: versions.length,
    series,
  };
}

/** A directory entry as returned by the Gitea contents API. */
export interface GiteaContentEntry {
  name: string;
  type: string;
  download_url: string | null;
}

/**
 * Keep only the deliverable YAML files from a Gitea contents listing.
 *
 * @param entries The raw contents-API array.
 * @returns File entries whose name ends in `.yaml`, with a usable download URL.
 */
export function deliverableFiles(
  entries: GiteaContentEntry[],
): GiteaContentEntry[] {
  return entries.filter(
    (e) => e.type === "file" && e.name.endsWith(".yaml") && !!e.download_url,
  );
}

/**
 * SR-1: Validate that a download URL's origin matches the expected host.
 *
 * The contents-API listing supplies a `download_url` per file. That listing
 * comes from the configured Gitea host, but if the listing were ever tampered
 * with (or a repo's metadata pointed at an off-host URL), blindly following
 * `download_url` would let an attacker make this worker fetch arbitrary
 * origins (SSRF). We only fetch when the URL's origin matches `baseUrl`.
 *
 * @param downloadUrl The URL to validate.
 * @param baseUrl The configured base URL whose origin is the allow-list.
 * @returns True iff the URL has the same origin as baseUrl.
 */
export function isDownloadUrlTrusted(
  downloadUrl: string,
  baseUrl: string,
): boolean {
  try {
    return new URL(downloadUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Run `fn` over `items` with a bounded number of concurrent executions,
 * preserving input order in the result.
 *
 * @param items The inputs.
 * @param limit Max concurrent executions.
 * @param fn The async mapper.
 * @returns The results in the same order as `items`.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Fetch seam
// ---------------------------------------------------------------------------

/** A `fetch`-compatible function (injected in tests). */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

/**
 * GET a URL and return its body text, raising on a non-2xx status.
 *
 * @param url Absolute URL.
 * @param doFetch Fetch implementation.
 * @returns The response body text.
 * @throws On any non-2xx response.
 */
export async function httpText(
  url: string,
  doFetch: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const resp = await doFetch(url);
  if (!resp.ok) {
    throw new Error(
      `GET ${url} failed (HTTP ${resp.status} ${resp.statusText})`,
    );
  }
  return await resp.text();
}

/** Build the Gitea contents-API URL for a series' deliverable directory. */
export function contentsUrl(
  cfg: Pick<GlobalArgs, "baseUrl" | "repo" | "series" | "ref">,
): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  // `repo` keeps its literal `owner/name` slashes (Gitea path); `series` is a
  // single path segment and `ref` a query value, so both are encoded (matches
  // the encoding the sibling sig_distgit model applies to its path/query args).
  const series = encodeURIComponent(cfg.series);
  const ref = encodeURIComponent(cfg.ref);
  return `${base}/api/v1/repos/${cfg.repo}/contents/deliverables/${series}?ref=${ref}`;
}

/** Build the Gitea contents-API URL for the _independent deliverable directory. */
export function independentUrl(
  cfg: Pick<GlobalArgs, "baseUrl" | "repo" | "ref">,
): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const ref = encodeURIComponent(cfg.ref);
  return `${base}/api/v1/repos/${cfg.repo}/contents/deliverables/_independent?ref=${ref}`;
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Minimal logging surface the methods rely on. */
interface MethodLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

/** Minimal shape of the execute context this model relies on. */
interface ExecuteContext {
  globalArgs: GlobalArgs;
  logger: MethodLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Return shape for every method's execute function. */
interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

/**
 * Enumerate and snapshot every deliverable in a series plus _independent.
 * Exported so tests can drive it with an injected fetch without the
 * model-loader machinery.
 *
 * After fetching the cycle-bound `deliverables/<series>/` directory, we also
 * fetch `deliverables/_independent/` (packages that release on their own
 * schedule, not tied to any OpenStack cycle). Both sets are merged into a
 * single `deliverables` array. When the same deliverable name appears in both
 * directories the cycle-bound entry wins — the epoxy version is the one the
 * SIG actually tracks.
 *
 * @param cfg Resolved global args.
 * @param doFetch Fetch implementation.
 * @param logger Logger.
 * @returns The assembled snapshot object (the resource payload).
 */
export async function buildSnapshot(
  cfg: GlobalArgs,
  doFetch: FetchLike,
  logger: MethodLogger,
): Promise<z.infer<typeof DeliverablesSchema>> {
  // Fetch the cycle-bound directory and the _independent directory in parallel.
  const [listingResult, indepResult] = await Promise.allSettled([
    httpText(contentsUrl(cfg), doFetch),
    httpText(independentUrl(cfg), doFetch),
  ]);

  // Cycle-bound listing (required).
  if (listingResult.status === "rejected") {
    throw new Error(
      `Failed to fetch ${cfg.series} deliverables: ${listingResult.reason}`,
    );
  }
  const entries = JSON.parse(listingResult.value) as GiteaContentEntry[];
  const files = deliverableFiles(entries);
  // SR-1: only fetch download_urls whose origin matches the configured Gitea
  // host — a tampered listing could otherwise redirect us to an arbitrary
  // origin (SSRF). Drop offenders with a warning rather than failing the
  // whole snapshot, so one bad entry doesn't poison the inventory.
  const trustedFiles = files.filter((f) =>
    isDownloadUrlTrusted(f.download_url!, cfg.baseUrl)
  );
  const skipped = files.length - trustedFiles.length;
  if (skipped > 0) {
    logger.warning(
      "Skipped {count} deliverable file(s) whose download_url origin does not match {origin}",
      { count: skipped, origin: new URL(cfg.baseUrl).origin },
    );
  }
  logger.info("Enumerated {count} deliverable files for series {series}", {
    count: trustedFiles.length,
    series: cfg.series,
  });

  // _independent listing (best-effort).
  let indepFiles: GiteaContentEntry[] = [];
  if (indepResult.status === "fulfilled") {
    try {
      const indepEntries = JSON.parse(indepResult.value) as GiteaContentEntry[];
      indepFiles = deliverableFiles(indepEntries);
      // SR-1: apply same origin-trust filter to _independent entries.
      indepFiles = indepFiles.filter((f) =>
        isDownloadUrlTrusted(f.download_url!, cfg.baseUrl)
      );
      const indepSkipped = deliverableFiles(indepEntries).length -
        indepFiles.length;
      if (indepSkipped > 0) {
        logger.warning(
          "Skipped {count} _independent file(s) whose download_url origin does not match {origin}",
          { count: indepSkipped, origin: new URL(cfg.baseUrl).origin },
        );
      }
      logger.info("Enumerated {count} _independent deliverable files", {
        count: indepFiles.length,
      });
    } catch {
      logger.warning("Failed to parse _independent directory listing");
    }
  } else {
    logger.warning("Failed to fetch _independent deliverables: {reason}", {
      reason: String(indepResult.reason),
    });
  }

  // Fetch and parse all deliverable YAMLs in parallel.
  const [epoxyDeliverables, independentDeliverables] = await Promise.all([
    mapPool(trustedFiles, cfg.concurrency, async (f) =>
      parseDeliverable(
        await httpText(f.download_url!, doFetch),
        f.name.replace(/\.yaml$/, ""),
        "epoxy",
      )),
    mapPool(indepFiles, cfg.concurrency, async (f) =>
      parseDeliverable(
        await httpText(f.download_url!, doFetch),
        f.name.replace(/\.yaml$/, ""),
        "independent",
      )),
  ]);

  // Merge: epoxy entries take priority when a name exists in both directories.
  const epoxyNames = new Set(epoxyDeliverables.map((d) => d.deliverable));
  const newIndependent = independentDeliverables.filter((d) =>
    !epoxyNames.has(d.deliverable)
  );
  const deliverables = [...epoxyDeliverables, ...newIndependent];
  deliverables.sort((a, b) => a.deliverable.localeCompare(b.deliverable));

  const mismatches: Array<
    { deliverable: string; vercmpMax: string | null; fileOrder: string | null }
  > = [];
  for (const d of deliverables) {
    if (
      d.latestVersion !== null && d.fileOrderVersion !== null &&
      rpmvercmp(d.latestVersion, d.fileOrderVersion) !== 0
    ) {
      mismatches.push({
        deliverable: d.deliverable,
        vercmpMax: d.latestVersion,
        fileOrder: d.fileOrderVersion,
      });
    }
  }
  if (mismatches.length > 0) {
    logger.warning(
      "{count} deliverables: vercmp-max disagrees with file order",
      {
        count: mismatches.length,
      },
    );
  }

  return {
    series: cfg.series,
    baseUrl: cfg.baseUrl,
    repo: cfg.repo,
    ref: cfg.ref,
    source: "gitea-api",
    deliverableCount: deliverables.length,
    deliverables,
    independentCount: independentDeliverables.length,
    mismatches,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Read-only OpenStack upstream release-facts snapshot model. */
export const model = {
  type: "@kneel/openstack-releases",
  version: "2026.09.29.1",
  description:
    "Read-only snapshot of upstream OpenStack release facts for one series: " +
    "enumerates deliverables/<series>/*.yaml and deliverables/_independent/*.yaml " +
    "on opendev.org, records each deliverable's newest version (rpmvercmp, with a " +
    "file-order cross-check) and shipping repos for the epoxy_gap comparison.",
  globalArguments: GlobalArgsSchema,
  resources: {
    "deliverables": {
      description: "Per-deliverable newest version + repos for one series",
      schema: DeliverablesSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    snapshot: {
      description:
        "Enumerate deliverables/<series>/*.yaml on the Gitea host, fetch each " +
        "raw, and persist per-deliverable newest versions (+ vercmp/file-order " +
        "mismatches) as the `deliverables` resource.",
      arguments: z.object({}),
      execute: async (
        args: { _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const snapshot = await buildSnapshot(
          cfg,
          args._fetch ?? (fetch as unknown as FetchLike),
          context.logger,
        );
        const handle = await context.writeResource(
          "deliverables",
          "deliverables",
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
