// The build embeds template files as their text content (esbuild text loader /
// Vite raw equivalent). These declarations tell TypeScript that importing a
// .md or .yaml file yields its contents as a string.
declare module '*.md' {
  const content: string;
  export default content;
}

declare module '*.yaml' {
  const content: string;
  export default content;
}
