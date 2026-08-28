// Runtime-only bridge: esbuild/tsx can compile the upstream TypeScript package,
// while NodeNext tsc consumes the adjacent .d.ts instead of type-checking the
// package's extensionless internal imports.
export { default } from "@ff-labs/pi-fff/src/index.ts";
