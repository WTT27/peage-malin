#!/bin/sh
# Publishes the app (folder app/) to GitHub Pages. Usage:  ./publish.sh
set -e
cd "$(dirname "$0")"
git branch -D gh-pages-build 2>/dev/null || true
git subtree split --prefix app -b gh-pages-build
git push -f origin gh-pages-build:gh-pages
git branch -D gh-pages-build
echo "✅ Appli publiée (visible sur le téléphone d'ici 1 à 2 minutes)."
