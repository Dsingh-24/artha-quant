#!/bin/sh
set -eu

rm -rf dist
mkdir -p dist/static
cp static/index.html dist/index.html
cp -R static/* dist/static/
echo "Built Netlify publish directory at dist/"
