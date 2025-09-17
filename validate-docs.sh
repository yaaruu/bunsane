#!/usr/bin/env bash

# BunSane Documentation Validation Script
# This script validates the basic functionality of the documentation site

echo "🔍 Validating BunSane Documentation Site..."
echo "=========================================="

# Check if docs directory exists
if [ ! -d "docs" ]; then
    echo "❌ docs directory not found!"
    exit 1
fi

echo "✅ docs directory exists"

# Check for required files
required_files=("index.html" "_sidebar.md" "README.md" "_coverpage.md" "getting-started.md")
for file in "${required_files[@]}"; do
    if [ -f "docs/$file" ]; then
        echo "✅ $file exists"
    else
        echo "❌ $file missing"
        exit 1
    fi
done

# Check for core concepts directory
if [ -d "docs/core-concepts" ]; then
    echo "✅ core-concepts directory exists"
else
    echo "❌ core-concepts directory missing"
    exit 1
fi

# Check for entity documentation
if [ -f "docs/core-concepts/entity.md" ]; then
    echo "✅ entity.md exists"
else
    echo "❌ entity.md missing"
    exit 1
fi

# Validate HTML structure
if grep -q "<!DOCTYPE html>" docs/index.html; then
    echo "✅ index.html has valid HTML structure"
else
    echo "❌ index.html missing DOCTYPE"
    exit 1
fi

# Check for Docsify configuration
if grep -q "window.\$docsify" docs/index.html; then
    echo "✅ Docsify configuration found"
else
    echo "❌ Docsify configuration missing"
    exit 1
fi

# Check sidebar structure
if grep -q "\- \*\*Getting Started\*\*" docs/_sidebar.md; then
    echo "✅ Sidebar has Getting Started section"
else
    echo "❌ Sidebar missing Getting Started section"
    exit 1
fi

# Check for navigation links
if grep -q "\[Entity System\]" docs/_sidebar.md; then
    echo "✅ Sidebar has Entity System link"
else
    echo "❌ Sidebar missing Entity System link"
    exit 1
fi

echo ""
echo "🎉 All basic validations passed!"
echo "=================================="
echo "Your BunSane documentation site is ready for deployment."
echo ""
echo "Next steps:"
echo "1. Enable GitHub Pages in your repository settings"
echo "2. Set the source to 'Deploy from a branch'"
echo "3. Select the 'gh-pages' branch (will be created by GitHub Actions)"
echo "4. Your documentation will be available at: https://yaaruu.github.io/bunsane/"
echo ""
echo "For local development:"
echo "1. Install docsify-cli: npm install -g docsify-cli"
echo "2. Run: docsify serve docs"
echo "3. Open http://localhost:3000"