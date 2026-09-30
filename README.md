# @kneel/openstack-releases

A [swamp](https://github.com/swamp-club/swamp) model that snapshots **upstream
OpenStack release facts** for one series, straight from the
[`openstack/releases`](https://opendev.org/openstack/releases) repo on
opendev.org.

A single `snapshot()` method enumerates `deliverables/<series>/*.yaml` and
`deliverables/_independent/*.yaml`, and for each deliverable records its newest
version (compared with `rpmvercmp`, cross-checked against file order) and the
repos it ships. It persists:

- `deliverables` — per-deliverable newest version + shipping repos for the series

It's read-only. This is the *upstream* half of a "how far behind is the SIG?"
comparison — pair it with [`@kneel/sig-distgit`](https://github.com/NeilHanlon/swamp-sig-distgit)
(the dist-git side) and join them in a report.

## Usage

```bash
swamp extension pull @kneel/openstack-releases
swamp model create @kneel/openstack-releases openstack-epoxy
swamp model method run openstack-epoxy snapshot
swamp data get openstack-epoxy deliverables --json
```

Global arguments: `series` (e.g. `epoxy`) and the opendev host/base (defaulted).

## Where it's used

Part of the CentOS Cloud SIG packaging pipeline — see
[cloud-sig-swamp](https://github.com/NeilHanlon/cloud-sig-swamp), where its
snapshot feeds the `sig-promote` report (in `@kneel/koji`).

## License

MIT — see [LICENSE.txt](LICENSE.txt).
