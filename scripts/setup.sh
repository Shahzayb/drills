#!/bin/bash
set -e

# Create .env from .env.example if it doesn't exist
if [ ! -f .env ]; then
  echo "📋 Creating .env from .env.example..."
  cp .env.example .env
  echo "✓ .env created with default values"
else
  echo "✓ .env already exists"
fi

# Check if Docker is running
if ! docker ps > /dev/null 2>&1; then
  echo "❌ Docker is not running. Please start Docker and try again."
  exit 1
fi

echo "🚀 Starting services..."
npm run docker:up
