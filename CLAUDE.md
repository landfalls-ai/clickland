# Clickland

The internal observability system of the land-\* family (logs, traces, metrics, and the alerts and dashboards over
them), designed by reverse-engineering ClickHouse and ClickStack. Today the repository holds the study: the research,
the evidence and the proposed plan. No product code yet.

## Read first

- `docs/README.md`: the docs index.
- `docs/research.md`: what we learned and what Clickland takes from it. The detail is in `docs/research/`
  (`clickhouse-storage.md`, `clickhouse-query-and-cluster.md`, `clickstack.md`).
- `docs/plan.md`: the proposed architecture and waves (proposed, not yet approved).
- `study/README.md`: the evidence the research cites (Craft Anything captures, source graphs, live probes).

## Layout

- `upstream/` (git-ignored): the open-source projects we study, pinned by `scripts/fetch-upstream.sh`. ClickHouse
  (Apache-2.0) and ClickStack/HyperDX (MIT). Read them freely; never edit them.
- `tools/craft-anything/`: the Craft Anything CLI (`scripts/fetch-tools.sh` downloads and verifies it) and
  `mcp_session.py`, which runs several of its tools in one MCP session (one browser, one target).
- `study/`: tool output only. Re-create the live parts with `scripts/study-clickstack.sh`.
- `deploy/study/`: the reference ClickStack stack (compose project `clickland-study`).

## Method (from the land family)

- Spec-driven, as in Landbright: a feature starts as `specs/NNN-name/` (spec, plan, tasks); the plan's claims are checked
  against the source before tasks are written.
- Research claims cite a file and line in `upstream/` or a file in `study/`; a claim from docs only is marked [docs].
- Docs move with the code: each change updates its page, `docs/limitations.md` and `docs/roadmap.md` when it adds or
  closes something, and gets a row in `docs/history.md`.

## Local only

- Run only on this machine: the OrbStack Docker engine and later its Kubernetes cluster (`--context orbstack`,
  namespace `clickland-dev`). Never deploy to a cloud, never push images, and don't sign up for ClickHouse Cloud.
- Other projects' containers share this Docker engine: touch only the `clickland-*` compose projects (and later the
  `clickland-dev` namespace), and don't prune.
- Landflow, Landbright and Landfall are separate repositories next to this one. Read them freely; change them only
  when asked.
- Craft Anything: Deep mode only on open-source code or our own stack; the public ClickHouse site in clean room only.
