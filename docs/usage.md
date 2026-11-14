# Resource usage rollups

`POST /api/usage/rollup` gives the resources each workload used, requested and was allocated, per hour or day,
from the metrics Clickland already stores: CPU core-hours, memory and storage GiB-hours, Docker network GB, node
capacity and persistent volume claims. It is what Landledger, the family's finance subledger, pulls to price the
cluster and the Docker engine. Clickland only measures. It never sees a rate.

The route, its scope and the MCP tool are in [reference/api.md](reference/api.md#resource-usage). The code:
`libs/contracts/src/usage.ts` (the contract), `libs/query/src/usage.ts` (the SQL and the reference math),
`apps/api/src/usage.ts` (the response and `coverage`).

## What is measured

| Source | Used | Requested | Allocated |
|---|---|---|---|
| Kubernetes (kubelet_stats, per container) | CPU from `container.cpu.time`; memory from `container.memory.working_set`; storage from `container.filesystem.usage` | `k8s.container.cpu_request` / `memory_request` (k8s_cluster), the latest in the range | per 30 s interval, max(request, usage), summed |
| Docker (docker_stats, containers without Kubernetes labels) | CPU from `container.cpu.usage.total`; memory from `container.memory.usage.total` (less page cache); network from rx/tx bytes | none: `"0.000000"` | = used |

- **Capacity**: each node's `k8s.node.allocatable_cpu` and `allocatable_memory` × time (`capacity[]`).
- **Volumes**: each persistent volume claim's `k8s.volume.capacity` and capacity − `available` × time (`volumes[]`),
  from the kubelet's `volume` group. One claim is one series, whichever pod mounts it.
- **Owner and labels**: the `k8s_attributes` processor in `deploy/k8s/cluster-metrics` adds each pod's
  `k8s.deployment.name` (and replicaset, statefulset, daemonset, job, cronjob) and every pod label as
  `k8s.pod.label.<key>`. `k8s.workload.kind` / `k8s.workload.name` take the first owner found, in that order; for samples
  stored before the processor ran, a Deployment comes from the pod name (`<deployment>-<hash>-<id>`).

## The math

The SQL (`usageRollupQuery`) and the TypeScript reference (`rollupSeries`) do the same thing, and the integration test
compares them on synthetic samples.

- A series is one metric with one set of attributes, its samples in time order. Every interval between two samples
  belongs to the bucket of its start. So yesterday's call and today's call never count one interval twice, and each
  call reads 90 s past its end to close its last interval.
- A gauge (memory, filesystem, allocatable, volume) holds its value until the next sample: value × seconds. An
  interval over 90 s is a gap. It counts 30 s, and the rest goes to `coverage.sources[].gapSeconds`. A series' last
  sample counts 30 s, or up to now if that is sooner.
- A counter (CPU seconds, bytes) counts the difference to the next sample. A drop is a restart, so the next value is all
  new. A Kubernetes container that started inside the range also counts its first value.
- Requested is the request × the interval's seconds. Allocated is the larger of request and usage for each interval
  (for CPU, the interval's counter difference; for memory, the sample's value), summed, as OpenCost does. The sum of
  per-interval maxima is larger than max(Σ request, Σ usage) whenever usage crosses the request.
- Units: core-hours; GiB-hours (2^30 bytes for an hour); GB (10^9 bytes). Quantities are decimal strings with six
  decimals (`"1.492300"`), so a reader parses them as decimals, never as floats.

## Counted once

On OrbStack, Docker also sees every container Kubernetes runs, with the `io.kubernetes.*` labels as `k8s.*`
attributes. The rule: **Kubernetes usage comes from the kubelet, and the Docker source leaves out every container
that carries `k8s.pod.name`.** The kind cluster that Landflow's agents run in (`landflow-kagent-control-plane`) is a
plain Docker container to Clickland. Its whole usage is a Docker row, because its pods are not in the OrbStack
cluster.

## Not measured (`coverage.missing`)

- **Egress** (`networkEgressGB`, always null): Docker counts every byte on a container's interface. Nothing tells
  bytes that left the machine apart from bytes to another container. That needs a flow source.
- **Kubernetes network** (null on Kubernetes rows): the kubelet on OrbStack reports network for the node only. The
  pod sandbox containers run with network mode none in Docker, so Docker has none either.
- **Claim size on local-path**: a claim on the node's own disk reports the node filesystem's size and free space, not
  its own. Such a volume has `sharesNodeFilesystem: true`, and the claim's requested size is not collected. On this
  cluster that is every claim (the `local-path` storage class).
- **Before the data**: metrics start on 2026-11-14 at 15:15 UTC. Owner attributes, labels and volumes start at
  17:31 UTC that day, when the collector gained `k8s_attributes` and the `volume` group, and claim names at 17:33. Buckets with no samples
  are in `coverage.sources[].missingBuckets`.

## Landledger's call

One UTC day per call, with `granularity: "day"` and
`groupBy: ["k8s.cluster.name", "k8s.namespace.name", "k8s.workload.kind", "k8s.workload.name", "k8s.container.name", "compose.project", "compose.service"]`,
plus `k8s.pod.label.<key>` for any label its allocation rules select on. It uses a key with only `usage:read`.

```bash
curl -s -XPOST 127.0.0.1:4710/api/usage/rollup -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"from":"2026-11-14T00:00:00Z","to":"2026-11-15T00:00:00Z","granularity":"day","groupBy":["k8s.namespace.name"]}'
```
