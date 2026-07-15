// elkjs ships types for the API entry only; the bundled build (single file,
// no worker-file indirection) re-exports the same class.
declare module 'elkjs/lib/elk.bundled.js' {
  import ELK from 'elkjs/lib/elk-api';
  export default ELK;
}
