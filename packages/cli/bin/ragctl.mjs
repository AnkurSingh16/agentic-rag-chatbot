#!/usr/bin/env node
// Committed, unlike dist/, so npm can link the ragctl command before the package is built.
try {
  await import('../dist/main.js');
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('dist/main.js')) {
    process.stderr.write('ragctl is not built yet. Run "npm run build" first.\n');
    process.exitCode = 1;
  } else {
    throw error;
  }
}
