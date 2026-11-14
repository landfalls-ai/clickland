/** Resource usage rollups for Landledger (docs/usage.md): Clickland measures, Landledger prices. */
import type { ClickHouseClient } from '@clickhouse/client';
import {
  USAGE_POD_LABEL_PREFIX,
  type UsageCapacity,
  type UsageCoverage,
  type UsageMissing,
  type UsageQuantity,
  type UsageRollupRequest,
  type UsageRollupResponse,
  type UsageRow,
  type UsageSource,
  type UsageSourceCoverage,
  type UsageVolume,
} from '@clickland/contracts';
import {
  capacityQuery,
  GAP_SECONDS,
  STEP_SECONDS,
  usageRollupQuery,
  volumeQuery,
  type CapacityQueryRow,
  type UsageGroupKey,
  type UsageQueryRow,
  type VolumeQueryRow,
} from '@clickland/query';
import { runQuery } from './clients.js';

/** Six decimals, as a string: exact for the reader, who parses it as a decimal. */
export const quantity = (n: number): UsageQuantity => {
  const s = (Math.round(n * 1e6) / 1e6).toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};
const iso = (s: number) => new Date(s * 1000).toISOString();

const CLUSTER_METRICS = 'deploy/k8s/cluster-metrics/cluster-metrics.yaml';

/** What every rollup includes and leaves out, so a reader of the numbers knows. */
export function usageNotes(): string[] {
  return [
    'Kubernetes: kubelet_stats per container. CPU from cumulative CPU seconds (container.cpu.time; differences, resets handled); memory from the working set and storage from filesystem usage, each held until the next sample (value × seconds). The pod sandbox (pause) is not included.',
    'Requested: the container’s CPU and memory requests (k8s_cluster, the latest in the range) × time. Allocated: per 30 s interval the larger of request and usage, summed, as OpenCost. A container without a request has requested 0 and allocated = used.',
    'Docker: docker_stats for containers without Kubernetes labels (containers Kubernetes runs are counted once, from the kubelet). CPU from container.cpu.usage.total, memory from container.memory.usage.total (usage less page cache), network from rx/tx bytes. Docker has no requests (allocated = used) and reports no storage.',
    'k8s.workload.kind/name: the pod’s owner from the k8s_attributes processor (Deployment, StatefulSet, DaemonSet, CronJob, Job, ReplicaSet); without it, a Deployment from the pod name (<deployment>-<hash>-<id>), else empty. k8s.deployment.name is the same for Deployments only.',
    'Capacity: each node’s allocatable CPU and memory (k8s.node.allocatable_cpu/memory) × time. Volumes: each persistent volume claim’s capacity, and capacity − available, × time; a claim on the node’s own disk (local-path) reports the node filesystem (sharesNodeFilesystem).',
    'Every interval between two samples belongs to the bucket of its start, so adjacent ranges never count it twice. A counter’s value before a Docker container’s first sample is not counted (at most one 30 s interval).',
    'Quantities are decimal strings with six decimals. Units: core-hours; GiB-hours (2^30 bytes for an hour); GB (10^9 bytes).',
  ];
}

/** What the figures lack in this range, from the rows and the request. */
export function usageMissing(
  input: Pick<UsageRollupRequest, 'groupBy'>,
  sources: UsageSource[],
  rows: Pick<UsageQueryRow, 'source' | 'unowned' | 'no_labels' | 'no_cluster' | 'net_samples'>[],
  capacitySamples: number,
  volumeSamples: number,
  sharedClaims: string[] = [],
): UsageMissing[] {
  const missing: UsageMissing[] = [
    {
      field: 'networkEgressGB',
      reason:
        'No source tells bytes that left the machine from bytes to another container or pod: Docker counts every byte on a container’s interface, and nothing records flows.',
      fix: 'A flow source (for example Cilium Hubble, or the host’s conntrack) sending bytes by destination.',
    },
  ];
  const k8s = rows.filter((r) => r.source === 'kubernetes');
  if (sources.includes('kubernetes')) {
    missing.push({
      field: 'networkRxGB, networkTxGB (kubernetes)',
      reason:
        'The kubelet on this cluster (OrbStack) reports network for the node only, not per pod, and the pod sandbox containers run with network mode none in Docker.',
      fix: 'A cluster whose kubelet reports pod network (k8s.pod.network.io), or a CNI that exports it.',
    });
    const sum = (key: 'unowned' | 'no_labels' | 'no_cluster') => k8s.reduce((n, r) => n + r[key], 0);
    const keys = input.groupBy;
    if (keys.some((k) => k === 'k8s.workload.kind' || k === 'k8s.workload.name') && sum('unowned') > 0)
      missing.push({
        field: 'k8s.workload.kind, k8s.workload.name',
        reason: `${sum('unowned')} pod(s) in the rows have no owner attribute and no Deployment-shaped name (samples before the k8s_attributes processor ran, or bare pods); their workload is empty.`,
        fix: `k8s_attributes in ${CLUSTER_METRICS} (extract.metadata: k8s.deployment.name … k8s.cronjob.name).`,
      });
    if (keys.some((k) => k.startsWith(USAGE_POD_LABEL_PREFIX)) && sum('no_labels') > 0)
      missing.push({
        field: 'k8s.pod.label.*',
        reason: `${sum('no_labels')} pod(s) in the rows carry no labels (samples before the k8s_attributes processor added them, or pods without labels); their label value is empty.`,
        fix: `k8s_attributes in ${CLUSTER_METRICS} (extract.labels: k8s.pod.label.$1 from every pod label).`,
      });
    if (keys.includes('k8s.cluster.name') && sum('no_cluster') > 0)
      missing.push({
        field: 'k8s.cluster.name',
        reason: `${sum('no_cluster')} pod(s) in the rows carry no cluster name.`,
        fix: `resource/metrics in ${CLUSTER_METRICS} (k8s.cluster.name).`,
      });
    if (capacitySamples === 0)
      missing.push({
        field: 'capacity',
        reason: 'No node allocatable samples in the range.',
        fix: `k8s_cluster in ${CLUSTER_METRICS} (allocatable_types_to_report: [cpu, memory]).`,
      });
    if (volumeSamples === 0)
      missing.push({
        field: 'volumes',
        reason:
          'No persistent volume claim samples in the range: the kubelet volume group was not collected yet, or no pod mounts a claim.',
        fix: `kubelet_stats metric_groups includes volume in ${CLUSTER_METRICS}.`,
      });
    if (sharedClaims.length)
      missing.push({
        field: 'volumes (claim size)',
        reason: `${sharedClaims.length} claim(s) (${sharedClaims.slice(0, 10).join(', ')}) live on the node’s own filesystem (local-path): the kubelet reports that filesystem’s size and free space, so their capacity and used are the node disk’s, not the claim’s. The claim’s requested size is not collected.`,
        fix: `A CSI driver that reports per-volume stats, or k8s_objects pulling persistentvolumeclaims (spec.resources.requests.storage) in ${CLUSTER_METRICS}.`,
      });
  }
  return missing;
}

export class Usage {
  constructor(private readonly ch: ClickHouseClient) {}

  async rollup(input: UsageRollupRequest, now = new Date()): Promise<UsageRollupResponse> {
    const from = new Date(input.from);
    const to = new Date(input.to);
    const sources: UsageSource[] = input.source === 'all' ? ['kubernetes', 'docker'] : [input.source];
    const k8s = sources.includes('kubernetes');
    const range = { from, to, granularity: input.granularity, now };
    // Validated by the contract: fixed keys and k8s.pod.label.<key>.
    const groupBy = input.groupBy as UsageGroupKey[];
    const [{ rows }, capacity, volumes] = await Promise.all([
      runQuery<UsageQueryRow>(this.ch, usageRollupQuery({ ...range, groupBy, sources })),
      k8s ? runQuery<CapacityQueryRow>(this.ch, capacityQuery(range)).then((r) => r.rows) : [],
      k8s ? runQuery<VolumeQueryRow>(this.ch, volumeQuery(range)).then((r) => r.rows) : [],
    ]);
    const bucket = input.granularity === 'hour' ? 3600 : 86400;
    const fromS = Math.floor(from.getTime() / 1000);
    const toS = Math.ceil(to.getTime() / 1000);
    const span = (b: number) => ({ start: iso(Math.max(b, fromS)), end: iso(Math.min(b + bucket, toS)) });

    const out: UsageRow[] = rows.map((r) => {
      const docker = r.source === 'docker';
      const group: Record<string, string> = {};
      groupBy.forEach((key, i) => (group[key] = r.g[i] ?? ''));
      return {
        ...span(r.b),
        source: r.source,
        group,
        cpuCoreHours: quantity(r.cpu),
        cpuRequestedCoreHours: quantity(r.cpu_req),
        cpuAllocatedCoreHours: quantity(r.cpu_alloc),
        memoryGiBHours: quantity(r.mem),
        memoryRequestedGiBHours: quantity(r.mem_req),
        memoryAllocatedGiBHours: quantity(r.mem_alloc),
        storageGiBHours: docker ? null : quantity(r.fs),
        networkRxGB: docker ? quantity(r.rx) : null,
        networkTxGB: docker ? quantity(r.tx) : null,
        networkEgressGB: null,
        samples: Number(r.samples),
      };
    });
    const capacityRows: UsageCapacity[] = capacity.map((c) => ({
      ...span(c.b),
      cluster: c.cluster,
      node: c.node,
      cpuAllocatableCoreHours: quantity(c.cpu),
      memoryAllocatableGiBHours: quantity(c.mem),
      samples: Number(c.samples),
    }));
    const volumeRows: UsageVolume[] = volumes.map((v) => ({
      ...span(v.b),
      cluster: v.cluster,
      namespace: v.ns,
      claim: v.claim,
      capacityGiBHours: quantity(v.capacity),
      usedGiBHours: quantity(Math.max(0, v.capacity - v.available)),
      sharesNodeFilesystem: Number(v.shared_samples) * 2 > Number(v.capacity_samples),
      samples: Number(v.samples),
    }));

    // Coverage: which buckets each source has data for, and what is not measured.
    const firstBucket = Math.floor(fromS / bucket) * bucket;
    const expected: number[] = [];
    for (let b = firstBucket; b < toS; b += bucket) expected.push(b);
    const capacitySamples = capacityRows.reduce((n, c) => n + c.samples, 0);
    const volumeSamples = volumeRows.reduce((n, v) => n + v.samples, 0);
    const coverage: UsageCoverage = {
      from: from.toISOString(),
      to: to.toISOString(),
      granularity: input.granularity,
      stepSeconds: STEP_SECONDS,
      maxGapSeconds: GAP_SECONDS,
      sources: sources.map((source): UsageSourceCoverage => {
        const mine = rows.filter((r) => r.source === source);
        const withData = new Set(mine.map((r) => r.b));
        const missing = expected.filter((b) => !withData.has(b));
        return {
          source,
          firstSample: mine.length ? iso(Math.min(...mine.map((r) => r.first_t))) : null,
          lastSample: mine.length ? iso(Math.max(...mine.map((r) => r.last_t))) : null,
          samples: mine.reduce((n, r) => n + Number(r.samples), 0),
          buckets: { expected: expected.length, withData: withData.size },
          missingBuckets: missing.slice(0, 200).map(iso),
          gapSeconds: mine.reduce((n, r) => n + Number(r.gap), 0),
          networkSamples: mine.reduce((n, r) => n + Number(r.net_samples), 0),
        };
      }),
      capacity: { samples: capacitySamples, nodes: new Set(capacityRows.map((c) => `${c.cluster}/${c.node}`)).size },
      volumes: {
        samples: volumeSamples,
        claims: new Set(volumeRows.map((v) => `${v.cluster}/${v.namespace}/${v.claim}`)).size,
      },
      missing: usageMissing(
        input,
        sources,
        rows.map((r) => ({
          ...r,
          unowned: Number(r.unowned),
          no_labels: Number(r.no_labels),
          no_cluster: Number(r.no_cluster),
        })),
        capacitySamples,
        volumeSamples,
        [...new Set(volumeRows.filter((v) => v.sharesNodeFilesystem).map((v) => `${v.namespace}/${v.claim}`))],
      ),
      notes: usageNotes(),
    };
    return { rows: out, capacity: capacityRows, volumes: volumeRows, coverage };
  }
}
