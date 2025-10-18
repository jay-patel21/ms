#!/bin/bash

# Build script for Node.js Kubernetes application

set -e

echo "Building Node.js Kubernetes application..."

# Variables
IMAGE_NAME="node-kube-app"
IMAGE_TAG="latest"
REGISTRY=${REGISTRY:-""}  # Set this if pushing to a registry

# Build Docker image
echo "Building Docker image..."
docker build -t ${IMAGE_NAME}:${IMAGE_TAG} .

# Tag for registry if specified
if [ ! -z "$REGISTRY" ]; then
    echo "Tagging image for registry..."
    docker tag ${IMAGE_NAME}:${IMAGE_TAG} ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}
    echo "Image tagged as: ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
fi

echo "Build completed successfully!"
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
if [ ! -z "$REGISTRY" ]; then
    echo "Registry image: ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
fi
