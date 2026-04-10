#!/bin/bash
set -e
echo "Installing Python dependencies..."
pip install --quiet -r requirements.txt
echo "Python dependencies installed."
pnpm store prune
