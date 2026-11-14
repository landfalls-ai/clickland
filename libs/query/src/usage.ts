/**
 * Resource usage rollups (docs/usage.md): used, requested and allocated core-hours and GiB-hours, storage and network
 * per bucket, node capacity and volumes, from the stored Kubernetes (kubelet_stats, k8s_cluster) and Docker
 * (docker_stats) metrics.
 *
 * The math, the same in SQL (`usageRollupQuery`) and in TypeScript (`rollupSeries`, the reference the tests use):
 * - A series is one metric with one set of resource and point attributes, its samples ordered by time.
 * - Every interval between two consecutive samples belongs to the bucket that holds its start, so adjacent ranges
 *   (yesterday, then today) count each interval exactly once.
 * - A gauge (memory, filesystem bytes, allocatable capacity) holds its value until the next sample: value × seconds.
 *   An interval longer than `GAP_SECONDS` is a gap: it counts `STEP_SECONDS` and the rest is reported, not guessed. A
 *   series' last sample counts `STEP_SECONDS` (or up to now, if that is sooner).
 * - A cumulative counter (CPU seconds, bytes) counts the difference to the next sample. A drop is a reset (the process
 *   restarted): the next value is all new. A Kubernetes series that started inside the range also counts its first
 *   value (the kubelet's start time is the container's).
 * - Requested: the container's request × the interval. Allocated (as OpenCost): max(request, usage) per interval; for
 *   CPU the usage of an interval is its counter difference, for memory the sample's value. No request: allocated =
 *   used.
 */
import type { ParamValue } from './compile.js';
import { chTime, type Query } from './queries.js';

/** The fixed group keys (`UsageGroupKey` in @clickland/contracts, which this library does not depend on). */
export const USAGE_GROUP_KEYS = [
  'k8s.cluster.name',
  'k8s.namespace.name',
  'k8s.workload.kind',
  'k8s.workload.name',
  'k8s.deployment.name',
  'k8s.pod.name',
  'k8s.container.name',
  'service.name',
  'container.name',
  'compose.project',
  'compose.service',
] as const;
export type UsageFixedKey = (typeof USAGE_GROUP_KEYS)[number];
export const POD_LABEL_PREFIX = 'k8s.pod.label.';
/** A fixed key, or a pod label: `k8s.pod.label.<label key>`. */
export type UsageGroupKey = UsageFixedKey | `k8s.pod.label.${string}`;

/** The collectors scrape every 30 s (deploy/collector/docker-agent.yaml, deploy/k8s/cluster-metrics). */
export const STEP_SECONDS = 30;
/** A gauge interval longer than this is a gap (three missed scrapes). */
export const GAP_SECONDS = 90;
export const GIB = 1024 ** 3;

export type UsageKind = 'cpu' | 'mem' | 'fs' | 'rx' | 'tx';
export type UsageSourceName = 'kubernetes' | 'docker';

interface Feed {
  source: UsageSourceName;
  kind: UsageKind;
  table: 'otel_metrics_gauge' | 'otel_metrics_sum';
  metric: string;
  counter: boolean;
  /** Multiplies a counter's difference, or a gauge's value × seconds, into the response's unit. */
  scale: number;
  where: string;
  /** Whether a series that starts in the range counts its first value. */
  countFirst: boolean;
}

const KUBELET = `ServiceName = 'kubernetes' AND ScopeName LIKE '%kubeletstats%'`;
const K8S_CLUSTER = `ServiceName = 'kubernetes' AND ScopeName LIKE '%k8scluster%'`;
const DOCKER = `ServiceName = 'docker' AND ScopeName LIKE '%dockerstats%'`;
/** A container Kubernetes runs: Docker sees it too on OrbStack, with the io.kubernetes.* labels as k8s.* attributes. */
const K8S_LABELLED = `ResourceAttributes['k8s.pod.name'] != ''`;

const CORE_HOURS_FROM_SECONDS = 1 / 3600;
const CORE_HOURS_FROM_NS = 1 / 1e9 / 3600;
const GIB_HOURS = 1 / GIB / 3600;
const GB = 1 / 1e9;

/** What each source reads. Kubernetes reads container metrics, so requests (set per container) line up with usage. */
export function usageFeeds(sources: UsageSourceName[]): Feed[] {
  const feeds: Feed[] = [];
  if (sources.includes('kubernetes')) {
    const k = (kind: UsageKind, metric: string, table: Feed['table'], counter: boolean, scale: number): Feed => ({
      source: 'kubernetes',
      kind,
      table,
      metric,
      counter,
      scale,
      where: KUBELET,
      countFirst: counter,
    });
    feeds.push(
      k('cpu', 'container.cpu.time', 'otel_metrics_sum', true, CORE_HOURS_FROM_SECONDS),
      k('mem', 'container.memory.working_set', 'otel_metrics_gauge', false, GIB_HOURS),
      k('fs', 'container.filesystem.usage', 'otel_metrics_gauge', false, GIB_HOURS),
    );
  }
  if (sources.includes('docker')) {
    const d = (kind: UsageKind, metric: string, counter: boolean, scale: number): Feed => ({
      source: 'docker',
      kind,
      table: 'otel_metrics_sum',
      metric,
      counter,
      scale,
      // Containers with Kubernetes labels are Kubernetes' (counted from the kubelet): never twice.
      where: `${DOCKER} AND NOT (${K8S_LABELLED})`,
      countFirst: false,
    });
    feeds.push(
      d('cpu', 'container.cpu.usage.total', true, CORE_HOURS_FROM_NS),
      // A non-monotonic sum: the current usage, read as a gauge.
      d('mem', 'container.memory.usage.total', false, GIB_HOURS),
      d('rx', 'container.network.io.usage.rx_bytes', true, GB),
      d('tx', 'container.network.io.usage.tx_bytes', true, GB),
    );
  }
  return feeds;
}

/** Deployment pods are named `<deployment>-<pod-template-hash>-<5 characters>`; the hash alphabet has no vowels. */
export const DEPLOYMENT_FROM_POD = '^(.+)-[bcdfghjklmnpqrstvwxz2456789]{5,10}-[bcdfghjklmnpqrstvwxz2456789]{5}$';
const FROM_POD = `extract(pod, '${DEPLOYMENT_FROM_POD}')`;
const WORKLOAD_KIND = `multiIf(pi_deployment != '', 'Deployment', pi_statefulset != '', 'StatefulSet', pi_daemonset != '', 'DaemonSet', pi_cronjob != '', 'CronJob', pi_job != '', 'Job', pi_replicaset != '', 'ReplicaSet', ${FROM_POD} != '', 'Deployment', '')`;
const WORKLOAD_NAME = `multiIf(pi_deployment != '', pi_deployment, pi_statefulset != '', pi_statefulset, pi_daemonset != '', pi_daemonset, pi_cronjob != '', pi_cronjob, pi_job != '', pi_job, pi_replicaset != '', pi_replicaset, ${FROM_POD})`;

/** A Kubernetes row's value for a key, from the sample (ns, pod, ctr) and its pod's attributes (pi_*). */
function kubernetesExpression(key: UsageGroupKey, labelParam: string): string {
  switch (key) {
    case 'k8s.cluster.name':
      return 'pi_cluster';
    case 'k8s.namespace.name':
      return 'ns';
    case 'k8s.pod.name':
      return 'pod';
    case 'k8s.container.name':
      return 'ctr';
    case 'service.name':
      return `'kubernetes'`;
    case 'k8s.deployment.name':
      return `if(pi_deployment != '', pi_deployment, ${FROM_POD})`;
    case 'k8s.workload.kind':
      return WORKLOAD_KIND;
    case 'k8s.workload.name':
      return WORKLOAD_NAME;
    case 'container.name':
    case 'compose.project':
    case 'compose.service':
      return `''`;
    default:
      return `pi_labels[{${labelParam}:String}]`;
  }
}

/** A Docker row's value for a key, read in the feed from its resource attributes. */
function dockerExpression(key: UsageGroupKey): string {
  if (key === 'service.name') return 'ServiceName';
  if (key.startsWith('k8s.')) return `''`;
  return `ResourceAttributes['${key}']`;
}

export interface UsageQueryInput {
  from: Date;
  to: Date;
  granularity: 'day' | 'hour';
  groupBy: UsageGroupKey[];
  sources: UsageSourceName[];
  /** "Now", for a series' last sample; injected by tests. */
  now?: Date;
}

/** One row of the query: a bucket of a group from a source, in the response's units. */
export interface UsageQueryRow {
  b: number;
  source: UsageSourceName;
  g: string[];
  cpu: number;
  cpu_req: number;
  cpu_alloc: number;
  mem: number;
  mem_req: number;
  mem_alloc: number;
  fs: number;
  rx: number;
  tx: number;
  samples: number;
  net_samples: number;
  gap: number;
  first_t: number;
  last_t: number;
  /** Kubernetes pods in the row with no workload owner (no attribute and no Deployment-shaped name). */
  unowned: number;
  /** Kubernetes containers in the row without a CPU or a memory request. */
  unrequested: number;
  /** Kubernetes pods in the row whose samples carry no k8s.cluster.name. */
  no_cluster: number;
  /** Kubernetes pods in the row whose samples carry no k8s.pod.label.* attribute. */
  no_labels: number;
}

function baseParams(input: { from: Date; to: Date; now?: Date }): Record<string, ParamValue> {
  return {
    from: chTime(input.from),
    fetch_to: chTime(new Date(input.to.getTime() + GAP_SECONDS * 1000)),
    from_s: Math.floor(input.from.getTime() / 1000),
    to_s: Math.floor(input.to.getTime() / 1000),
    now_s: Math.floor((input.now ?? new Date()).getTime() / 1000),
    step: STEP_SECONDS,
    gap: GAP_SECONDS,
  };
}

const bucketOf = (granularity: 'day' | 'hour') =>
  granularity === 'hour'
    ? "toUInt32(toStartOfHour(toDateTime(t, 'UTC')))"
    : "toUInt32(toStartOfDay(toDateTime(t, 'UTC')))";

/** Gives each sample its next one in the series (`n` = 2 when there is one) and whether it is the first (`np` = 1). */
const windowed = (inner: string) => `
    SELECT *,
      leadInFrame(t) OVER w AS t_next,
      leadInFrame(v) OVER w AS v_next,
      count() OVER w AS n,
      count() OVER p AS np
    FROM (
      ${inner}
    )
    WINDOW w AS (PARTITION BY kind, series ORDER BY t ASC ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING),
           p AS (PARTITION BY kind, series ORDER BY t ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)`;

/** A gauge sample's seconds: to the next sample, a step over a gap, a step (or up to now) for the last. */
const GAUGE_SECONDS = `if(n = 2, if(t_next - t > {gap:UInt32}, {step:UInt32}, t_next - t), least({step:UInt32}, greatest(0, toInt64({now_s:UInt32}) - toInt64(t))))`;

export function usageRollupQuery(input: UsageQueryInput): Query {
  const feeds = usageFeeds(input.sources);
  const params = baseParams(input);
  input.groupBy.forEach((key, i) => {
    if (key.startsWith(POD_LABEL_PREFIX)) params[`l${i}`] = key;
  });
  const dockerG = `[${input.groupBy.map(dockerExpression).join(', ')}]::Array(String)`;
  const parts = feeds.map((feed, i) => {
    params[`m${i}`] = feed.metric;
    const k8s = feed.source === 'kubernetes';
    return `SELECT '${feed.source}' AS source, '${feed.kind}' AS kind, ${feed.counter ? 1 : 0} AS counter,
        ${feed.countFirst ? 1 : 0} AS count_first, ${feed.scale} AS scale,
        cityHash64(${i}, ResourceAttributes, Attributes) AS series,
        ${k8s ? "ResourceAttributes['k8s.namespace.name']" : "''"} AS ns,
        ${k8s ? "ResourceAttributes['k8s.pod.name']" : "''"} AS pod,
        ${k8s ? "ResourceAttributes['k8s.container.name']" : "''"} AS ctr,
        ${k8s ? '[]::Array(String)' : dockerG} AS gd,
        toUInt32(TimeUnix) AS t, Value AS v, toUInt32(StartTimeUnix) AS st
      FROM ${feed.table}
      WHERE MetricName = {m${i}:String} AND ${feed.where}
        AND TimeUnix >= {from:DateTime64(3)} AND TimeUnix < {fetch_to:DateTime64(3)}`;
  });
  const groupExprs = input.groupBy.map(
    (key, i) => `if(source = 'docker', gd[${i + 1}], ${kubernetesExpression(key, `l${i}`)})`,
  );
  // Each container's latest request (k8s_cluster), and each pod's cluster, owner and labels (k8s_attributes).
  const joins = input.sources.includes('kubernetes')
    ? `
  LEFT JOIN (
    SELECT ResourceAttributes['k8s.namespace.name'] AS ns, ResourceAttributes['k8s.pod.name'] AS pod,
      ResourceAttributes['k8s.container.name'] AS ctr,
      argMaxIf(Value, TimeUnix, MetricName = 'k8s.container.cpu_request') AS req_cpu,
      argMaxIf(Value, TimeUnix, MetricName = 'k8s.container.memory_request') AS req_mem
    FROM otel_metrics_gauge
    WHERE MetricName IN ('k8s.container.cpu_request', 'k8s.container.memory_request') AND ${K8S_CLUSTER}
      AND TimeUnix >= {from:DateTime64(3)} - INTERVAL 1 DAY AND TimeUnix < {fetch_to:DateTime64(3)}
    GROUP BY ns, pod, ctr
  ) AS r USING (ns, pod, ctr)
  LEFT JOIN (
    SELECT ResourceAttributes['k8s.namespace.name'] AS ns, ResourceAttributes['k8s.pod.name'] AS pod,
      ${['cluster', 'deployment', 'statefulset', 'daemonset', 'cronjob', 'job', 'replicaset']
        .map(
          (a) =>
            `argMaxIf(ResourceAttributes['k8s.${a}.name'], TimeUnix, ResourceAttributes['k8s.${a}.name'] != '') AS pi_${a}`,
        )
        .join(',\n      ')},
      argMax(mapFilter((k, x) -> startsWith(k, '${POD_LABEL_PREFIX}'), ResourceAttributes), TimeUnix) AS pi_labels
    FROM otel_metrics_gauge
    WHERE MetricName = 'container.memory.working_set' AND ${KUBELET}
      AND TimeUnix >= {from:DateTime64(3)} AND TimeUnix < {fetch_to:DateTime64(3)}
    GROUP BY ns, pod
  ) AS pi USING (ns, pod)`
    : `
  CROSS JOIN (SELECT 0 AS req_cpu, 0 AS req_mem, '' AS pi_cluster, '' AS pi_deployment, '' AS pi_statefulset,
    '' AS pi_daemonset, '' AS pi_cronjob, '' AS pi_job, '' AS pi_replicaset,
    map()::Map(String, String) AS pi_labels) AS none`;
  const sql = `
SELECT ${bucketOf(input.granularity)} AS b, source, g,
  sumIf(used, kind = 'cpu') AS cpu, sumIf(req, kind = 'cpu') AS cpu_req, sumIf(alloc, kind = 'cpu') AS cpu_alloc,
  sumIf(used, kind = 'mem') AS mem, sumIf(req, kind = 'mem') AS mem_req, sumIf(alloc, kind = 'mem') AS mem_alloc,
  sumIf(used, kind = 'fs') AS fs, sumIf(used, kind = 'rx') AS rx, sumIf(used, kind = 'tx') AS tx,
  count() AS samples, countIf(kind IN ('rx', 'tx')) AS net_samples, sum(gap) AS gap,
  min(t) AS first_t, max(t) AS last_t,
  uniqExactIf((ns, pod), source = 'kubernetes' AND owner = '') AS unowned,
  uniqExactIf((ns, pod, ctr), source = 'kubernetes' AND (req_cpu = 0 OR req_mem = 0)) AS unrequested,
  uniqExactIf((ns, pod), source = 'kubernetes' AND pi_cluster = '') AS no_cluster,
  uniqExactIf((ns, pod), source = 'kubernetes' AND empty(pi_labels)) AS no_labels
FROM (
  SELECT source, kind, t, ns, pod, ctr, req_cpu, req_mem, pi_cluster, pi_labels,
    [${groupExprs.join(', ')}]::Array(String) AS g,
    ${WORKLOAD_KIND} AS owner,
    multiIf(
      counter = 1,
        if(n = 2, if(v_next >= v, v_next - v, v_next), 0)
        + if(count_first = 1 AND np = 1 AND st >= {from_s:UInt32} AND st <= t, v, 0),
      v * ${GAUGE_SECONDS}
    ) AS raw,
    multiIf(kind = 'cpu', req_cpu * if(n = 2, t_next - t, 0), kind = 'mem', req_mem * ${GAUGE_SECONDS}, 0) AS req_raw,
    raw * scale AS used,
    req_raw * scale AS req,
    if(kind IN ('cpu', 'mem'), greatest(raw, req_raw), 0) * scale AS alloc,
    if(kind = 'mem' AND n = 2 AND t_next - t > {gap:UInt32}, t_next - t - {step:UInt32}, 0) AS gap
  FROM (${windowed(parts.join('\n      UNION ALL\n      '))}
  ) AS s${joins}
  WHERE t >= {from_s:UInt32} AND t < {to_s:UInt32}
)
GROUP BY b, source, g
ORDER BY b, source, cpu DESC`;
  return { sql, params };
}

export interface CapacityQueryRow {
  b: number;
  cluster: string;
  node: string;
  cpu: number;
  mem: number;
  samples: number;
}

type RangeInput = Pick<UsageQueryInput, 'from' | 'to' | 'granularity' | 'now'>;

/** Node allocatable CPU and memory (k8s_cluster), integrated like any gauge: core-hours and GiB-hours per node. */
export function capacityQuery(input: RangeInput): Query {
  const sql = `
SELECT ${bucketOf(input.granularity)} AS b, cluster, node,
  sumIf(c, kind = 'cpu') AS cpu, sumIf(c, kind = 'mem') AS mem, count() AS samples
FROM (
  SELECT kind, t, cluster, node, v * ${GAUGE_SECONDS} * if(kind = 'cpu', ${CORE_HOURS_FROM_SECONDS}, ${GIB_HOURS}) AS c
  FROM (${windowed(`SELECT if(MetricName = 'k8s.node.allocatable_cpu', 'cpu', 'mem') AS kind,
        cityHash64(MetricName, ResourceAttributes) AS series,
        ResourceAttributes['k8s.cluster.name'] AS cluster, ResourceAttributes['k8s.node.name'] AS node,
        toUInt32(TimeUnix) AS t, Value AS v
      FROM otel_metrics_gauge
      WHERE MetricName IN ('k8s.node.allocatable_cpu', 'k8s.node.allocatable_memory') AND ${K8S_CLUSTER}
        AND TimeUnix >= {from:DateTime64(3)} AND TimeUnix < {fetch_to:DateTime64(3)}`)}
  )
  WHERE t >= {from_s:UInt32} AND t < {to_s:UInt32}
)
GROUP BY b, cluster, node
ORDER BY b, cluster, node`;
  return { sql, params: baseParams(input) };
}

export interface VolumeQueryRow {
  b: number;
  cluster: string;
  ns: string;
  claim: string;
  capacity: number;
  available: number;
  samples: number;
  /** Capacity samples, and those equal to the node filesystem's capacity at the same scrape (the claim is on it). */
  capacity_samples: number;
  shared_samples: number;
}

/**
 * Each persistent volume claim's size and free space over time (the kubelet's `volume` group), in GiB-hours. A claim
 * is one series whichever pod mounts it: two pods' samples interleave, so the time between them still adds up once.
 */
export function volumeQuery(input: RangeInput): Query {
  const sql = `
SELECT ${bucketOf(input.granularity)} AS b, cluster, ns, claim,
  sumIf(c, kind = 'capacity') AS capacity, sumIf(c, kind = 'available') AS available, count() AS samples,
  countIf(kind = 'capacity') AS capacity_samples,
  countIf(kind = 'capacity' AND node_fs > 0 AND abs(v - node_fs) <= 0.001 * node_fs) AS shared_samples
FROM (
  SELECT kind, t, v, cluster, ns, claim, node_fs, v * ${GAUGE_SECONDS} * ${GIB_HOURS} AS c
  FROM (${windowed(`SELECT if(MetricName = 'k8s.volume.capacity', 'capacity', 'available') AS kind,
        ResourceAttributes['k8s.cluster.name'] AS cluster, ResourceAttributes['k8s.namespace.name'] AS ns,
        ResourceAttributes['k8s.persistentvolumeclaim.name'] AS claim,
        cityHash64(MetricName, cluster, ns, claim) AS series,
        toUInt32(TimeUnix) AS t, Value AS v
      FROM otel_metrics_gauge
      WHERE MetricName IN ('k8s.volume.capacity', 'k8s.volume.available') AND ${KUBELET}
        AND ResourceAttributes['k8s.persistentvolumeclaim.name'] != ''
        AND TimeUnix >= {from:DateTime64(3)} AND TimeUnix < {fetch_to:DateTime64(3)}`)}
  ) AS s
  -- A claim on the node's own disk (local-path, hostPath) reports the node filesystem, not its own size.
  LEFT JOIN (
    SELECT ResourceAttributes['k8s.cluster.name'] AS cluster, toUInt32(TimeUnix) AS t, max(Value) AS node_fs
    FROM otel_metrics_gauge
    WHERE MetricName = 'k8s.node.filesystem.capacity' AND ${KUBELET}
      AND TimeUnix >= {from:DateTime64(3)} AND TimeUnix < {fetch_to:DateTime64(3)}
    GROUP BY cluster, t
  ) AS nf USING (cluster, t)
  WHERE t >= {from_s:UInt32} AND t < {to_s:UInt32}
)
GROUP BY b, cluster, ns, claim
ORDER BY b, cluster, ns, claim`;
  return { sql, params: baseParams(input) };
}

// The reference math ------------------------------------------------------------------------------------------------

export interface Sample {
  /** Unix seconds. */
  t: number;
  v: number;
  /** The series' start time (Unix seconds), as the metric reports it; 0 when unknown. */
  st?: number;
}

export interface SeriesOptions {
  counter: boolean;
  /** Seconds of the range: [from, to). */
  from: number;
  to: number;
  now: number;
  /** Bucket length in seconds (3600 or 86400; buckets start at multiples of it, in UTC). */
  bucket: number;
  /** Count the first value of a series that started in the range (Kubernetes counters). */
  countFirst?: boolean;
  /** The container's request in the metric's unit (cores for CPU seconds, bytes for memory); 0 for none. */
  request?: number;
  step?: number;
  gap?: number;
}

export interface SeriesBucket {
  used: number;
  requested: number;
  allocated: number;
  gap: number;
  samples: number;
}

/**
 * One series' usage per bucket start (Unix seconds), in the metric's raw unit (value-seconds for a gauge, the
 * counter's own unit for a counter). The samples may run past `to` (the lookahead).
 */
export function rollupSeries(samples: Sample[], o: SeriesOptions): Map<number, SeriesBucket> {
  const step = o.step ?? STEP_SECONDS;
  const gap = o.gap ?? GAP_SECONDS;
  const request = o.request ?? 0;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const out = new Map<number, SeriesBucket>();
  sorted.forEach((s, i) => {
    if (s.t < o.from || s.t >= o.to) return;
    const next = sorted[i + 1];
    let used: number;
    let requested: number;
    let missing = 0;
    if (o.counter) {
      used = next ? (next.v >= s.v ? next.v - s.v : next.v) : 0;
      if (o.countFirst && i === 0 && (s.st ?? 0) >= o.from && (s.st ?? 0) <= s.t) used += s.v;
      requested = next ? request * (next.t - s.t) : 0;
    } else {
      const long = next !== undefined && next.t - s.t > gap;
      const dt = next ? (long ? step : next.t - s.t) : Math.min(step, Math.max(0, o.now - s.t));
      if (next && long) missing = next.t - s.t - step;
      used = s.v * dt;
      requested = request * dt;
    }
    const b = Math.floor(s.t / o.bucket) * o.bucket;
    const cur = out.get(b) ?? { used: 0, requested: 0, allocated: 0, gap: 0, samples: 0 };
    cur.used += used;
    cur.requested += requested;
    cur.allocated += Math.max(used, requested);
    cur.gap += missing;
    cur.samples += 1;
    out.set(b, cur);
  });
  return out;
}
