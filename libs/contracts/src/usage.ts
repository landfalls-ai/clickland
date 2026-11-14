/**
 * Resource usage rollups (docs/usage.md): CPU, memory, storage and network used, requested and allocated per hour or
 * day, node capacity and volume claims, from the Kubernetes and Docker metrics Clickland stores. Landledger prices
 * them; Clickland never sees a rate.
 */
import { z } from 'zod';

const isoTime = z.iso.datetime({ offset: true });

/** The fixed attributes a rollup can group by. */
export const USAGE_FIXED_KEYS = [
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
export const USAGE_POD_LABEL_PREFIX = 'k8s.pod.label.';

/** A fixed key, or a pod label as `k8s.pod.label.<label key>` (e.g. `k8s.pod.label.team`). */
export const UsageGroupKey = z.union([
  z.enum(USAGE_FIXED_KEYS),
  z
    .string()
    .regex(/^k8s\.pod\.label\.[A-Za-z0-9][A-Za-z0-9._/-]{0,252}$/, 'a pod label key: k8s.pod.label.<label key>'),
]);
export type UsageGroupKey = z.infer<typeof UsageGroupKey>;

export const UsageSource = z.enum(['kubernetes', 'docker']);
export type UsageSource = z.infer<typeof UsageSource>;

/** Hour buckets for at most 31 days, day buckets for at most 366. */
export const USAGE_MAX_DAYS = { hour: 31, day: 366 } as const;
/** At most this many group keys (fixed and labels together). */
export const USAGE_MAX_GROUP_KEYS = 12;

export const UsageRollupRequest = z
  .object({
    from: isoTime,
    to: isoTime,
    granularity: z.enum(['day', 'hour']),
    groupBy: z
      .array(UsageGroupKey)
      .max(USAGE_MAX_GROUP_KEYS)
      .default([])
      .refine((keys) => new Set(keys).size === keys.length, 'groupBy repeats a key'),
    source: z.enum(['kubernetes', 'docker', 'all']).default('all'),
  })
  .superRefine((r, ctx) => {
    const span = Date.parse(r.to) - Date.parse(r.from);
    if (span <= 0) ctx.addIssue({ code: 'custom', message: 'from must be before to', path: ['to'] });
    else if (span > USAGE_MAX_DAYS[r.granularity] * 86_400_000)
      ctx.addIssue({
        code: 'custom',
        message: `${r.granularity} buckets cover at most ${USAGE_MAX_DAYS[r.granularity]} days`,
        path: ['to'],
      });
  });
export type UsageRollupRequest = z.infer<typeof UsageRollupRequest>;
export type UsageRollupInput = z.input<typeof UsageRollupRequest>;

/**
 * An exact quantity: a decimal string with six decimals ("1.492300"), to parse as a decimal, never as a float. Units
 * are in the field names: core-hours, GiB-hours (2^30 bytes for an hour), GB (10^9 bytes).
 */
export type UsageQuantity = string;

/** One bucket of one group from one source. */
export interface UsageRow {
  /** The bucket, clipped to the request's range. */
  start: string;
  end: string;
  source: UsageSource;
  /** One value per `groupBy` key ('' when the source does not carry the key). */
  group: Record<string, string>;
  /** Used: CPU seconds the containers ran, in core-hours. */
  cpuCoreHours: UsageQuantity;
  /** The container's CPU request × time. Docker: "0.000000" (no requests). */
  cpuRequestedCoreHours: UsageQuantity;
  /** Σ over intervals of max(request, usage) (as OpenCost). Docker: = used. */
  cpuAllocatedCoreHours: UsageQuantity;
  /** Used: working set (Kubernetes) or usage less page cache (Docker) × time. */
  memoryGiBHours: UsageQuantity;
  memoryRequestedGiBHours: UsageQuantity;
  memoryAllocatedGiBHours: UsageQuantity;
  /** Kubernetes: the containers' filesystem usage × time. Docker: null (not reported). */
  storageGiBHours: UsageQuantity | null;
  /** Docker: bytes received and sent on the container's interfaces. Kubernetes: null (see coverage.missing). */
  networkRxGB: UsageQuantity | null;
  networkTxGB: UsageQuantity | null;
  /** Bytes that left the machine: null, not measured (see coverage.missing). */
  networkEgressGB: UsageQuantity | null;
  /** How many metric samples went into the row. */
  samples: number;
}

/** A node's allocatable CPU and memory over a bucket (k8s.node.allocatable_*). */
export interface UsageCapacity {
  start: string;
  end: string;
  cluster: string;
  node: string;
  cpuAllocatableCoreHours: UsageQuantity;
  memoryAllocatableGiBHours: UsageQuantity;
  samples: number;
}

/** A persistent volume claim's size and use over a bucket (k8s.volume.capacity / available, kubelet `volume` group). */
export interface UsageVolume {
  start: string;
  end: string;
  cluster: string;
  namespace: string;
  claim: string;
  capacityGiBHours: UsageQuantity;
  usedGiBHours: UsageQuantity;
  /**
   * The claim lives on the node's own filesystem (local-path, hostPath): the kubelet reports that filesystem's size
   * and free space, so capacity and used are the node disk's, not the claim's (see coverage.missing).
   */
  sharesNodeFilesystem: boolean;
  samples: number;
}

export interface UsageSourceCoverage {
  source: UsageSource;
  /** The first and last sample in the range, or null when the source has none. */
  firstSample: string | null;
  lastSample: string | null;
  samples: number;
  buckets: { expected: number; withData: number };
  /** Bucket starts with no sample from this source (at most 200 listed). */
  missingBuckets: string[];
  /** Seconds a memory series went without a sample beyond the allowed gap (summed over series); not counted. */
  gapSeconds: number;
  /** Network samples: 0 means the network columns are not measured for this source in the range. */
  networkSamples: number;
}

/** Something asked for that the figures lack, and what would add it. */
export interface UsageMissing {
  /** The field or group key it affects (`networkEgressGB`, `k8s.workload.name`, `volumes` …). */
  field: string;
  reason: string;
  /** What would add it (a collector setting, a data source). */
  fix?: string;
}

export interface UsageCoverage {
  from: string;
  to: string;
  granularity: 'day' | 'hour';
  /** Metric samples are 30 s apart; a gauge interval longer than `maxGapSeconds` counts as `stepSeconds` only. */
  stepSeconds: number;
  maxGapSeconds: number;
  sources: UsageSourceCoverage[];
  capacity: { samples: number; nodes: number };
  volumes: { samples: number; claims: number };
  /** What is not measured, or only partly, in this range. */
  missing: UsageMissing[];
  /** What the figures do and do not include, in words. */
  notes: string[];
}

export interface UsageRollupResponse {
  rows: UsageRow[];
  /** Kubernetes only (empty for `source: "docker"`). */
  capacity: UsageCapacity[];
  volumes: UsageVolume[];
  coverage: UsageCoverage;
}
