# What sends data to Clickland

Everything goes to the collector (compose project `clickland-infra`): OTLP/HTTP on `127.0.0.1:4318` and
`127.0.0.1:24318`, gRPC on `127.0.0.1:4317` and `127.0.0.1:24317`. The standard ports mean an app's default
(`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`) needs no change. From pods, use
`http://clickland-collector.clickland-dev:4318`: `deploy/k8s/bridge` points `clickland-collector`, `clickland-api` and
`clickland-console` in `clickland-dev` at this machine (`host.orb.internal`) until Clickland runs in the cluster.

## The land apps

- **Landflow** (cluster, `landflow-dev`): the host and the plugins send traces, metrics and logs
  (`OTEL_EXPORTER_OTLP_ENDPOINT=http://host.orb.internal:24318`). Services `landflow-host`, `landflow-plugin-*`.
- **Landbright** (local): idp and control with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:24318`,
  `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`. Services `landbright-idp`, `landbright-control`.
- **Landfall** (local): core-api sends traces and metrics; its logs are JSON on stdout, shipped by a local filelog
  collector until Landfall emits OTel logs itself. Service `core-api` (`service.namespace=landfall`).

## The machine

- **Docker** (`deploy/collector/docker-metrics.yaml`, service `docker-metrics` in `clickland-infra`): CPU, memory,
  network and block I/O of every container on the engine, every 30 s. Service `docker`; group by `container.name`,
  `compose.project`, or `k8s.namespace.name` / `k8s.pod.name` for pod containers. It reads the Docker socket
  read-only, as root, in its own container so the main collector stays unprivileged.
- **Kubernetes** (`deploy/k8s/cluster-metrics`, namespace `clickland-dev`): kubelet stats (node, pod, container
  CPU, memory, filesystem, network) and cluster state (deployments, replicas, pod phases, restarts, node conditions)
  every 30 s under service `kubernetes`, and every Kubernetes event as a log under `kubernetes-events` (`WARN` for
  warnings). Read-only ClusterRole. `kubectl --context orbstack apply -k deploy/k8s/cluster-metrics`.
- **ClickHouse** itself: scraped from its Prometheus endpoint, service `clickhouse`.

## Try it

```bash
curl -s -XPOST 127.0.0.1:4710/api/metrics/query -H 'content-type: application/json' \
  -d '{"metric":"k8s.pod.memory.working_set","type":"gauge","aggregation":"max","service":"kubernetes","groupBy":"k8s.pod.name"}'
```
