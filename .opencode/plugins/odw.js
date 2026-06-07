// Live-test shim: load the workspace ODW plugin from the repo so OpenCode's
// project-plugin loader picks it up. Imports inside the plugin resolve by
// walking up from packages/opencode-plugin/src/ to the root node_modules
// (odw-daemon / odw-core workspace junctions).
export { default } from '../../packages/opencode-plugin/src/index.js';
