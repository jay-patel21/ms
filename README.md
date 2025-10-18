# Node Kube Stack

A two-service Node.js deployment designed for Kubernetes. Service A (message service) exposes an external endpoint, forwards notifications to Service B (notification service), and stores inter-replica messages. Service B accepts notifications and keeps its own history.

## Features
- Two logical services (`service-a`, `service-b`) sharing the same Node.js code base but different roles via environment variables
- Peer discovery and intra-service communication via headless Services
- External access to Service A via LoadBalancer; Service B stays internal
- Raw Kubernetes manifests under `k8s/prod/` for direct `kubectl apply`

## Repository Layout
- `server.js` – Node.js application; role determined by `SERVICE_ROLE`
- `Dockerfile`, `build.sh` – build the container image (same image works for both services)
- `k8s/prod/service-a/` – ConfigMap, Deployment, Services for service A
- `k8s/prod/service-b/` – ConfigMap, Deployment, Services for service B

## Prerequisites
- Node.js 18+
- Docker 20+
- kubectl 1.26+
- gcloud CLI with Artifact Registry + GKE permissions

## Local Development (optional)
```bash
npm install
npm start
```
Set `SERVICE_ROLE=message` or `SERVICE_ROLE=notification` locally to mimic the two services.

## Build Container Images
Build once and tag for each service role:
```bash
PROJECT_ID=genuine-wording-474900-e7
REGION=us-central1
REPO=node-kube-repo
IMG_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/node-kube-app"

# Build once
./build.sh

# Push service A
SERVICE_A_TAG="$IMG_BASE:1.0.0-service-a"
docker tag node-kube-app:latest "$SERVICE_A_TAG"
docker push "$SERVICE_A_TAG"

# Push service B
SERVICE_B_TAG="$IMG_BASE:1.0.0-service-b"
docker tag node-kube-app:latest "$SERVICE_B_TAG"
docker push "$SERVICE_B_TAG"
```
Update the image references inside the prod manifests to match the tags you push.

## Deploy to GKE with Raw Manifests
1. Create (or reuse) a cluster and get credentials:
   ```bash
   gcloud container clusters create-auto node-kube-cluster --region=us-central1
   gcloud container clusters get-credentials node-kube-cluster --region=us-central1 --project=$PROJECT_ID
   ```
2. Apply Service A manifests:
   ```bash
   kubectl apply -f k8s/prod/service-a/configmap.yaml
   kubectl apply -f k8s/prod/service-a/headless-service.yaml
   kubectl apply -f k8s/prod/service-a/service.yaml
   kubectl apply -f k8s/prod/service-a/deployment.yaml
   ```
3. Apply Service B manifests:
   ```bash
   kubectl apply -f k8s/prod/service-b/configmap.yaml
   kubectl apply -f k8s/prod/service-b/headless-service.yaml
   kubectl apply -f k8s/prod/service-b/service.yaml
   kubectl apply -f k8s/prod/service-b/deployment.yaml
   ```
4. Inspect resources:
   ```bash
   kubectl get pods -n node-kube-prod
   kubectl get svc -n node-kube-prod
   ```

## Accessing the Services
- **Service A** – LoadBalancer: find the external IP via `kubectl get svc service-a -n node-kube-prod` and visit `http://<ip>/health`.
- **Service B** – ClusterIP: port-forward with `kubectl port-forward svc/service-b -n node-kube-prod 8081:3000` then `curl http://localhost:8081/health`.

## Cleanup
```bash
kubectl delete namespace node-kube-prod
gcloud container clusters delete node-kube-cluster --region=us-central1
```

## Next Steps
- Add GitHub Actions workflow to build/push images and `kubectl apply` the manifests
- Add tests or linters for the Node.js service
- Consider adopting Helm/Argo CD later if deployments become more complex
