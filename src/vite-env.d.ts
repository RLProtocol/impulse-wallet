/// <reference types="vite/client" />
/// <reference types="chrome" />

declare module "*.png" {
  const src: string;
  export default src;
}
