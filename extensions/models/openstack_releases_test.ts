/**
 * Unit tests for the `@kneel/openstack-releases` snapshot model.
 *
 * Two layers:
 *  - Pure helpers: newest-version selection (with the file-order cross-check),
 *    deliverable YAML parsing (including the failsafe no-coercion guard for
 *    date-style versions), listing filtering, and the concurrency pool.
 *  - The `snapshot` method path through a mocked {@link FetchLike} seam: the
 *    Gitea listing → per-file raw fetch → assembled resource.
 *
 * The keystone fixture is the real `deliverables/epoxy/keystone.yaml` from
 * opendev.org (append-ordered rc1 → 27.0.0 → 27.0.1 → 27.0.2).
 *
 * Run with: `~/.deno/bin/deno test extensions/models/openstack_releases_test.ts`
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  buildSnapshot,
  deliverableFiles,
  type FetchLike,
  type GiteaContentEntry,
  httpText,
  independentUrl,
  isDownloadUrlTrusted,
  isPreRelease,
  mapPool,
  parseDeliverable,
  pickLatest,
} from "./openstack_releases.ts";

/** The real epoxy keystone deliverable YAML (append-ordered). */
const KEYSTONE_YAML = `---
launchpad: keystone
release-model: cycle-with-rc
team: keystone
type: service
repository-settings:
  openstack/keystone: {}
releases:
  - version: 27.0.0.0rc1
    projects:
      - repo: openstack/keystone
        hash: bd2b97a0412b8ea01ef47fd8c0c4908ca9fcee8a
  - version: 27.0.0
    projects:
      - repo: openstack/keystone
        hash: bd2b97a0412b8ea01ef47fd8c0c4908ca9fcee8a
    diff-start: 26.0.0
  - version: 27.0.1
    projects:
      - repo: openstack/keystone
        hash: 125efe4b59ca7de4089d188d549fde0fbcc989b3
  - version: 27.0.2
    projects:
      - repo: openstack/keystone
        hash: b896b71557ce8370c442fe05818a74d7a9a623a8
branches:
  - name: stable/2025.1
    location: 27.0.0.0rc1
release-notes: https://docs.openstack.org/releasenotes/keystone/2025.1.html
`;

// ---------------------------------------------------------------------------
// pickLatest
// ---------------------------------------------------------------------------

Deno.test("pickLatest: append-ordered list agrees vercmp-max with file order", () => {
  const p = pickLatest(["27.0.0.0rc1", "27.0.0", "27.0.1", "27.0.2"]);
  assertEquals(p.latestVersion, "27.0.2");
  assertEquals(p.fileOrderVersion, "27.0.2");
  assertEquals(p.source, "vercmp-max");
  assertEquals(p.mismatch, false);
});

Deno.test("pickLatest: out-of-order file flags a mismatch but keeps vercmp-max", () => {
  // Last entry (27.0.1) is NOT the newest (27.0.2) — surface it, don't trust it.
  const p = pickLatest(["27.0.2", "27.0.1"]);
  assertEquals(p.latestVersion, "27.0.2");
  assertEquals(p.fileOrderVersion, "27.0.1");
  assertEquals(p.mismatch, true);
});

Deno.test("isPreRelease: flags PEP440 rc/alpha/beta/dev suffixes only", () => {
  assertEquals(isPreRelease("27.0.0.0rc1"), true);
  assertEquals(isPreRelease("1.2.0.0b3"), true);
  assertEquals(isPreRelease("1.2.0.0a1"), true);
  assertEquals(isPreRelease("2.0.0.0dev5"), true);
  // Spelled-out PEP440 spellings a non-canonical tag might use are caught too.
  assertEquals(isPreRelease("1.0.0.0alpha1"), true);
  assertEquals(isPreRelease("1.0.0.0beta2"), true);
  assertEquals(isPreRelease("1.0.0.0rc1"), true);
  assertEquals(isPreRelease("1.0.0.0preview1"), true);
  assertEquals(isPreRelease("27.0.2"), false);
  assertEquals(isPreRelease("2024.10"), false);
  assertEquals(isPreRelease("9.0.0"), false);
  // A post-release is NOT a pre-release, and a final must never be flagged.
  assertEquals(isPreRelease("1.0.0.post1"), false);
  assertEquals(isPreRelease("27.0.0"), false);
});

Deno.test("pickLatest: PEP440 rc never beats its own final release", () => {
  // aodh/barbican shape: [X.0.0.0rc1, X.0.0] — the final must win, not the rc.
  const p = pickLatest(["20.0.0.0rc1", "20.0.0"]);
  assertEquals(p.latestVersion, "20.0.0");
  assertEquals(p.fileOrderVersion, "20.0.0");
  assertEquals(p.mismatch, false);
});

Deno.test("pickLatest: a deliverable with only pre-releases still yields one", () => {
  const p = pickLatest(["16.0.0.0rc1", "16.0.0.0rc2"]);
  assertEquals(p.latestVersion, "16.0.0.0rc2");
  assertEquals(p.source, "vercmp-max");
});

Deno.test("pickLatest: empty list -> nulls, source none", () => {
  const p = pickLatest([]);
  assertEquals(p.latestVersion, null);
  assertEquals(p.fileOrderVersion, null);
  assertEquals(p.source, "none");
  assertEquals(p.mismatch, false);
});

// ---------------------------------------------------------------------------
// parseDeliverable
// ---------------------------------------------------------------------------

Deno.test("parseDeliverable: real keystone YAML -> 27.0.2 from openstack/keystone", () => {
  const e = parseDeliverable(KEYSTONE_YAML, "keystone");
  assertEquals(e.deliverable, "keystone");
  assertEquals(e.latestVersion, "27.0.2");
  assertEquals(e.latestVersionSource, "vercmp-max");
  assertEquals(e.fileOrderVersion, "27.0.2");
  assertEquals(e.repos, ["openstack/keystone"]);
  assertEquals(e.releaseCount, 4);
});

Deno.test("parseDeliverable: failsafe schema keeps a date-style version verbatim", () => {
  // 2024.10 must NOT become the float 2024.1 (trailing zero dropped).
  const yaml = `releases:
  - version: 2024.10
    projects:
      - repo: openstack/foo
  - version: 2024.9
    projects:
      - repo: openstack/foo
`;
  const e = parseDeliverable(yaml, "foo");
  assertEquals(e.latestVersion, "2024.10");
  assertEquals(e.fileOrderVersion, "2024.9");
  assertEquals(e.repos, ["openstack/foo"]);
});

Deno.test("parseDeliverable: no releases -> null latest, repos from repository-settings", () => {
  const yaml = `repository-settings:
  openstack/bar-lib: {}
`;
  const e = parseDeliverable(yaml, "bar-lib");
  assertEquals(e.latestVersion, null);
  assertEquals(e.latestVersionSource, "none");
  assertEquals(e.repos, ["openstack/bar-lib"]);
  assertEquals(e.releaseCount, 0);
});

Deno.test("parseDeliverable: malformed YAML degrades to an empty entry", () => {
  const e = parseDeliverable(":\n  - [unterminated", "broken");
  assertEquals(e.deliverable, "broken");
  assertEquals(e.latestVersion, null);
  assertEquals(e.repos, []);
});

// ---------------------------------------------------------------------------
// deliverableFiles + mapPool
// ---------------------------------------------------------------------------

Deno.test("deliverableFiles: keeps only .yaml files with a download URL", () => {
  const entries: GiteaContentEntry[] = [
    { name: "keystone.yaml", type: "file", download_url: "https://x/keystone.yaml" },
    { name: "README.rst", type: "file", download_url: "https://x/README.rst" },
    { name: "_independent", type: "dir", download_url: null },
    { name: "nova.yaml", type: "file", download_url: null },
  ];
  const kept = deliverableFiles(entries);
  assertEquals(kept.map((e) => e.name), ["keystone.yaml"]);
});

Deno.test("mapPool: preserves order and bounds concurrency", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return n * 10;
  });
  assertEquals(out, [10, 20, 30, 40, 50]);
  assertEquals(peak <= 2, true);
});

// ---------------------------------------------------------------------------
// httpText + buildSnapshot (injected fetch)
// ---------------------------------------------------------------------------

/** Build a FetchLike that maps exact URLs to bodies; unknown -> 404. */
function urlFetcher(routes: Record<string, string>): { f: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const f: FetchLike = (input) => {
    urls.push(input);
    const body = routes[input];
    if (body === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve(""),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(body),
    });
  };
  return { f, urls };
}

Deno.test("httpText: raises on a non-2xx status", async () => {
  const { f } = urlFetcher({});
  await assertRejects(() => httpText("https://x/missing", f), Error, "HTTP 404");
});

Deno.test("buildSnapshot: lists, fetches each raw, assembles the resource", async () => {
  const listUrl =
    "https://opendev.org/api/v1/repos/openstack/releases/contents/deliverables/epoxy?ref=master";
  const listing: GiteaContentEntry[] = [
    { name: "keystone.yaml", type: "file", download_url: "https://opendev.org/raw/keystone.yaml" },
    { name: "nova.yaml", type: "file", download_url: "https://opendev.org/raw/nova.yaml" },
  ];
  const novaYaml = `releases:
  - version: 31.0.0
    projects:
      - repo: openstack/nova
  - version: 31.0.1
    projects:
      - repo: openstack/nova
`;
  const { f } = urlFetcher({
    [listUrl]: JSON.stringify(listing),
    "https://opendev.org/raw/keystone.yaml": KEYSTONE_YAML,
    "https://opendev.org/raw/nova.yaml": novaYaml,
  });
  const noop = () => {};
  const snap = await buildSnapshot(
    {
      baseUrl: "https://opendev.org",
      repo: "openstack/releases",
      series: "epoxy",
      ref: "master",
      concurrency: 6,
    },
    f,
    { debug: noop, info: noop, warning: noop, error: noop },
  );
  assertEquals(snap.series, "epoxy");
  assertEquals(snap.source, "gitea-api");
  assertEquals(snap.deliverableCount, 2);
  const names = snap.deliverables.map((d) => d.deliverable);
  assertEquals(names, ["keystone", "nova"]); // sorted
  const keystone = snap.deliverables.find((d) => d.deliverable === "keystone")!;
  assertEquals(keystone.latestVersion, "27.0.2");
  const nova = snap.deliverables.find((d) => d.deliverable === "nova")!;
  assertEquals(nova.latestVersion, "31.0.1");
  assertEquals(snap.mismatches, []);
});

// ---------------------------------------------------------------------------
// SR-1: download_url origin validation
// ---------------------------------------------------------------------------

Deno.test("isDownloadUrlTrusted: same-origin trusted, foreign-origin rejected, malformed rejected", () => {
  const base = "https://opendev.org";
  assertEquals(isDownloadUrlTrusted("https://opendev.org/raw/keystone.yaml", base), true);
  assertEquals(isDownloadUrlTrusted("https://opendev.org:443/raw/x.yaml", base), true);
  // Foreign origin — SSRF attempt
  assertEquals(isDownloadUrlTrusted("https://evil.example.com/steal", base), false);
  // Different scheme — not same origin
  assertEquals(isDownloadUrlTrusted("http://opendev.org/raw/x.yaml", base), false);
  // Malformed URL — rejected
  assertEquals(isDownloadUrlTrusted("not a url", base), false);
  assertEquals(isDownloadUrlTrusted("", base), false);
});

Deno.test("buildSnapshot: drops foreign-origin download_urls and warns (SR-1)", async () => {
  const listUrl =
    "https://opendev.org/api/v1/repos/openstack/releases/contents/deliverables/epoxy?ref=master";
  const listing: GiteaContentEntry[] = [
    { name: "keystone.yaml", type: "file", download_url: "https://opendev.org/raw/keystone.yaml" },
    {
      name: "evil.yaml",
      type: "file",
      // SSRF attempt: the listing points at a foreign host.
      download_url: "https://evil.example.com/exfiltrate.yaml",
    },
  ];
  const { f, urls } = urlFetcher({
    [listUrl]: JSON.stringify(listing),
    "https://opendev.org/raw/keystone.yaml": KEYSTONE_YAML,
    // NOTE: no route for https://evil.example.com/exfiltrate.yaml — if we
    // followed it, urlFetcher would 404 and buildSnapshot would throw.
    [INDEP_LIST_URL]: "[]",
  });
  const warnings: string[] = [];
  const snap = await buildSnapshot(
    {
      baseUrl: "https://opendev.org",
      repo: "openstack/releases",
      series: "epoxy",
      ref: "master",
      concurrency: 6,
    },
    f,
    { debug: () => {}, info: () => {}, warning: (m) => warnings.push(m), error: () => {} },
  );
  // The evil.yaml entry was dropped; only keystone was fetched.
  assertEquals(snap.deliverableCount, 1);
  assertEquals(snap.deliverables[0].deliverable, "keystone");
  assertEquals(urls.includes("https://evil.example.com/exfiltrate.yaml"), false);
  // A warning was emitted naming the skip count.
  assertEquals(warnings.some((w) => w.includes("Skipped")), true);
});

// ---------------------------------------------------------------------------
// _independent merging
// ---------------------------------------------------------------------------

const INDEP_LIST_URL =
  "https://opendev.org/api/v1/repos/openstack/releases/contents/deliverables/_independent?ref=master";

Deno.test("parseDeliverable: series field propagates from caller", () => {
  const yaml = `releases:
  - version: 3.2.0
    projects:
      - repo: openstack/automaton
`;
  const epoxy = parseDeliverable(yaml, "automaton", "epoxy");
  assertEquals(epoxy.series, "epoxy");
  const independent = parseDeliverable(yaml, "automaton", "independent");
  assertEquals(independent.series, "independent");
  // Default is epoxy.
  const def = parseDeliverable(yaml, "automaton");
  assertEquals(def.series, "epoxy");
});

Deno.test("independentUrl: builds the correct _independent contents URL", () => {
  const url = independentUrl({
    baseUrl: "https://opendev.org",
    repo: "openstack/releases",
    ref: "master",
  });
  assertEquals(
    url,
    "https://opendev.org/api/v1/repos/openstack/releases/contents/deliverables/_independent?ref=master",
  );
});

Deno.test("buildSnapshot: merges _independent deliverables with epoxy, dedup prefers epoxy", async () => {
  const epoxyListUrl =
    "https://opendev.org/api/v1/repos/openstack/releases/contents/deliverables/epoxy?ref=master";
  // Epoxy has oslo.concurrency at 7.1.0.
  const epoxyListing: GiteaContentEntry[] = [
    { name: "keystone.yaml", type: "file", download_url: "https://opendev.org/raw/epoxy/keystone.yaml" },
    { name: "oslo.concurrency.yaml", type: "file", download_url: "https://opendev.org/raw/epoxy/oslo.concurrency.yaml" },
  ];
  // _independent also has oslo.concurrency (at 4.4.1) plus automaton and futurist.
  const indepListing: GiteaContentEntry[] = [
    { name: "automaton.yaml", type: "file", download_url: "https://opendev.org/raw/indep/automaton.yaml" },
    { name: "oslo.concurrency.yaml", type: "file", download_url: "https://opendev.org/raw/indep/oslo.concurrency.yaml" },
    { name: "futurist.yaml", type: "file", download_url: "https://opendev.org/raw/indep/futurist.yaml" },
  ];
  const osloConcEpoxy = `releases:
  - version: 7.1.0
    projects:
      - repo: openstack/oslo.concurrency
`;
  const osloConcIndep = `releases:
  - version: 4.4.1
    projects:
      - repo: openstack/oslo.concurrency
`;
  const automatonYaml = `releases:
  - version: 3.2.0
    projects:
      - repo: openstack/automaton
`;
  const futuristYaml = `releases:
  - version: 3.1.0
    projects:
      - repo: openstack/futurist
`;
  const { f } = urlFetcher({
    [epoxyListUrl]: JSON.stringify(epoxyListing),
    [INDEP_LIST_URL]: JSON.stringify(indepListing),
    "https://opendev.org/raw/epoxy/keystone.yaml": KEYSTONE_YAML,
    "https://opendev.org/raw/epoxy/oslo.concurrency.yaml": osloConcEpoxy,
    "https://opendev.org/raw/indep/automaton.yaml": automatonYaml,
    "https://opendev.org/raw/indep/oslo.concurrency.yaml": osloConcIndep,
    "https://opendev.org/raw/indep/futurist.yaml": futuristYaml,
  });
  const noop = () => {};
  const snap = await buildSnapshot(
    {
      baseUrl: "https://opendev.org",
      repo: "openstack/releases",
      series: "epoxy",
      ref: "master",
      concurrency: 6,
    },
    f,
    { debug: noop, info: noop, warning: noop, error: noop },
  );
  // 2 epoxy + 2 new independent (automaton, futurist) = 4 total.
  // oslo.concurrency is deduped — epoxy wins.
  assertEquals(snap.deliverableCount, 4);
  assertEquals(snap.independentCount, 3); // 3 fetched from _independent before dedup
  const byName = new Map(snap.deliverables.map((d) => [d.deliverable, d]));
  // oslo.concurrency kept the epoxy version (7.1.0) and series.
  assertEquals(byName.get("oslo.concurrency")!.latestVersion, "7.1.0");
  assertEquals(byName.get("oslo.concurrency")!.series, "epoxy");
  // automaton and futurist came from _independent.
  assertEquals(byName.get("automaton")!.latestVersion, "3.2.0");
  assertEquals(byName.get("automaton")!.series, "independent");
  assertEquals(byName.get("futurist")!.latestVersion, "3.1.0");
  assertEquals(byName.get("futurist")!.series, "independent");
});

Deno.test("buildSnapshot: _independent fetch failure degrades gracefully", async () => {
  const epoxyListUrl =
    "https://opendev.org/api/v1/repos/openstack/releases/contents/deliverables/epoxy?ref=master";
  const listing: GiteaContentEntry[] = [
    { name: "keystone.yaml", type: "file", download_url: "https://opendev.org/raw/keystone.yaml" },
  ];
  // _independent URL returns 404 — no route for it.
  const { f } = urlFetcher({
    [epoxyListUrl]: JSON.stringify(listing),
    "https://opendev.org/raw/keystone.yaml": KEYSTONE_YAML,
  });
  const warnings: string[] = [];
  const snap = await buildSnapshot(
    {
      baseUrl: "https://opendev.org",
      repo: "openstack/releases",
      series: "epoxy",
      ref: "master",
      concurrency: 6,
    },
    f,
    {
      debug: () => {},
      info: () => {},
      warning: (m) => warnings.push(m),
      error: () => {},
    },
  );
  // Epoxy data still returned even though _independent failed.
  assertEquals(snap.deliverableCount, 1);
  assertEquals(snap.independentCount, 0);
  assertEquals(snap.deliverables[0].deliverable, "keystone");
  assertEquals(snap.deliverables[0].series, "epoxy");
  // Warning was logged.
  assertEquals(warnings.some((w) => w.includes("_independent")), true);
});
