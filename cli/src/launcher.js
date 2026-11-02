#!/usr/bin/env node
import nodeVersion from '../node-version.cjs';

// No application dependencies run until the version has been checked.
nodeVersion.assertSupportedNode();
import('./runtime.js').catch(error => {
  console.error(`Aside could not load its runtime: ${error.message}. Rebuild this checkout with build.sh.`);
  process.exit(1);
});
