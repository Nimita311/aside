// Keep this check independent of dependencies and syntax requiring modern Node.
// Source builds and the public launcher share the same minimum.
const MIN_NODE = '22.12.0';
const RECOMMENDED_NODE = '24 LTS';

function supportsNode(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts) return false;
  const actual = parts.slice(1).map(Number);
  const minimum = MIN_NODE.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

function assertSupportedNode() {
  if (supportsNode(process.versions.node)) return;
  process.stderr.write(
    'Aside requires Node.js >= ' + MIN_NODE + '; detected ' + process.version +
    ' at ' + process.execPath + '.\n' +
    'Install Node.js ' + RECOMMENDED_NODE + ', then retry with that executable. ' +
    'Agents and login jobs may use a different Node path than your shell; update their saved command if needed.\n'
  );
  process.exit(1);
}

module.exports = { MIN_NODE, RECOMMENDED_NODE, supportsNode, assertSupportedNode };
